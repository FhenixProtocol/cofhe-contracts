// solhint-disable func-name-mixedcase
// SPDX-License-Identifier: MIT
pragma solidity >=0.8.19 <0.9.0;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IPermissionCustomIdValidator} from "./Permissioned.sol";

/**
 * @dev ACP (Access Control Permission) — the V3 permission struct ("Permit V3").
 *
 * Evolves the V2 `Permission` (see Permissioned.sol) with scope granularity:
 *   - `global`    grants access to ALL of `issuer`s encrypted values (V2 behavior)
 *   - `contracts` grants access to `issuer`s values allowed for one of these contracts
 *                 (ACL-side check: intersection over existing `persistedAllowedPairs`)
 *   - `handles`   grants access to these specific ciphertext handles
 *
 * Scope semantics are enforced by the ACL (`isAllowedWithACP`); this verifier
 * checks structure only: expiration, signatures, revocation.
 *
 * Signing flows are identical to V2 (self / two-step sharing) with new
 * `ACPIssuerSelf` / `ACPIssuerShared` / `ACPRecipient` EIP-712 types and the
 * domain version bumped to "2".
 *
 * Revocation: `validatorId` + `validatorContract` unchanged from V2 — the id is
 * an opaque uint256 interpreted by the validator (creation timestamp in the
 * default TimestampBasedACPValidator). `validatorId = 0` or
 * `validatorContract = address(0)` disables the check (permit not revocable).
 */
struct ACPermission {
    address issuer;
    uint64 expiration;
    address recipient;
    uint256 validatorId;
    address validatorContract;
    bool global;
    address[] contracts;
    uint256[] handles;
    bytes32 sealingKey;
    bytes issuerSignature;
    bytes recipientSignature;
}

/// @notice Structure verifier for ACP (Permit V3) permissions.
/// @dev TODO(review): production wants this upgradeable (UUPS + AccessControl
/// upgrader role, like the ACL). Kept plain for the first review round —
/// stateless except the EIP-712 immutables.
contract ACPVerifier is EIP712 {
    using ACPUtils for ACPermission;

    /// @dev Same verifying-contract identity as V2 ("ACL"), domain version bumped for V3 types.
    constructor() EIP712("ACL", "2") {}

    error PermissionInvalid_Expired();
    error PermissionInvalid_IssuerSignature();
    error PermissionInvalid_RecipientSignature();
    error PermissionInvalid_Disabled();

    /// @dev Identical check order and semantics to V2 `withPermission`; only the
    /// struct hashing (ACPUtils) differs. The validator call-site is unchanged.
    modifier withPermission(ACPermission memory permission) {
        if (permission.expiration < block.timestamp)
            revert PermissionInvalid_Expired();

        if (
            !SignatureChecker.isValidSignatureNow(
                permission.issuer,
                _hashTypedDataV4(permission.issuerHash()),
                permission.issuerSignature
            )
        ) revert PermissionInvalid_IssuerSignature();

        if (
            permission.recipient != address(0) &&
            !SignatureChecker.isValidSignatureNow(
                permission.recipient,
                _hashTypedDataV4(permission.recipientHash()),
                permission.recipientSignature
            )
        ) revert PermissionInvalid_RecipientSignature();

        if (
            permission.validatorId != 0 &&
            permission.validatorContract != address(0) &&
            IPermissionCustomIdValidator(permission.validatorContract).disabled(
                permission.issuer,
                permission.validatorId
            )
        ) revert PermissionInvalid_Disabled();

        _;
    }

    /// @dev Structure-validity probe (expiration / signatures / revocation).
    function checkPermissionValidity(
        ACPermission memory permission
    ) public view withPermission(permission) returns (bool) {
        return true;
    }

    function hashTypedDataV4(bytes32 structHash) public view returns (bytes32) {
        return _hashTypedDataV4(structHash);
    }
}

/// @dev Signature type hashes for ACPermission. Field order must match the
/// struct and the SDK's SignatureTypes exactly — pinned by tests on both sides.
library ACPUtils {
    function issuerHash(ACPermission memory permission) internal pure returns (bytes32) {
        if (permission.recipient == address(0)) return issuerSelfHash(permission);
        return issuerSharedHash(permission);
    }

    function issuerSelfHash(ACPermission memory permission) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "ACPIssuerSelf(address issuer,uint64 expiration,address recipient,uint256 validatorId,address validatorContract,bool global,address[] contracts,uint256[] handles,bytes32 sealingKey)"
                    ),
                    permission.issuer,
                    permission.expiration,
                    permission.recipient,
                    permission.validatorId,
                    permission.validatorContract,
                    permission.global,
                    keccak256(abi.encodePacked(permission.contracts)),
                    keccak256(abi.encodePacked(permission.handles)),
                    permission.sealingKey
                )
            );
    }

    function issuerSharedHash(ACPermission memory permission) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "ACPIssuerShared(address issuer,uint64 expiration,address recipient,uint256 validatorId,address validatorContract,bool global,address[] contracts,uint256[] handles)"
                    ),
                    permission.issuer,
                    permission.expiration,
                    permission.recipient,
                    permission.validatorId,
                    permission.validatorContract,
                    permission.global,
                    keccak256(abi.encodePacked(permission.contracts)),
                    keccak256(abi.encodePacked(permission.handles))
                )
            );
    }

    function recipientHash(ACPermission memory permission) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256("ACPRecipient(bytes32 sealingKey,bytes issuerSignature)"),
                    permission.sealingKey,
                    keccak256(permission.issuerSignature)
                )
            );
    }
}

/**
 * @notice Default ACP validator — timestamp-based revocation.
 *
 * Interprets a permission's `validatorId` as its creation timestamp (populated
 * by the SDK, backdated 60s for clock skew). No upfront contract call: a permit
 * is revocable from birth.
 *
 * disabled(issuer, id):
 *   id > block.timestamp      -> true  (future-dated never validates; closes the revoke-all dodge)
 *   id <= revokeAllAt[issuer] -> true  (mass revocation, inclusive)
 *   revokedSingle[issuer][id] -> true  (targeted revocation)
 *
 * Accepted trade-offs (see PermitV3 spec discussion): same-second permits share
 * an id (revoking one revokes both — fail-safe over-revocation); revocation is
 * permanent.
 *
 * @dev TODO(review): production wants upgradeable (OZ AccessControl upgrader).
 */
contract TimestampBasedACPValidator is IPermissionCustomIdValidator {
    mapping(address => uint256) public revokeAllAt;
    mapping(address => mapping(uint256 => bool)) public revokedSingle;

    event RevokedSingle(address indexed issuer, uint256 indexed id);
    event RevokedAll(address indexed issuer, uint256 at);

    function revokeSingle(uint256 id) external {
        revokedSingle[msg.sender][id] = true;
        emit RevokedSingle(msg.sender, id);
    }

    function revokeAllExisting() external {
        revokeAllAt[msg.sender] = block.timestamp;
        emit RevokedAll(msg.sender, block.timestamp);
    }

    function disabled(address issuer, uint256 id) external view returns (bool) {
        return id > block.timestamp || id <= revokeAllAt[issuer] || revokedSingle[issuer][id];
    }
}
