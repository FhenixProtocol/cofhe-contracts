// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ACP, IPermissionCustomIdValidator} from "./Permissioned.sol";

/**
 * @notice On-chain hand-off for sharing ACPs — replaces the JSON copy-paste flow.
 *
 * An issuer posts a sharing ACP addressed to a recipient; the recipient reads it
 * from here, fills in their sealing key, signs, and imports it client-side. Shares
 * are indexed globally per recipient — a share is addressed to a person, and any
 * cofhesdk-enabled app may surface it.
 *
 * The registry stores the payload verbatim and stays deliberately dumb:
 *
 *  - The posted ACP carries `sealingKey = 0` and `recipientSignature = ""` — the
 *    recipient supplies both at import, exactly as in the off-chain flow.
 *  - No signature verification on-chain: a share's full validity cannot be checked
 *    before the recipient signs, and the SDK validates everything at import. The
 *    trust the registry adds is `msg.sender == acp.issuer` — a share listed under
 *    a recipient was genuinely posted by its claimed issuer.
 *  - `isShareValid` is the verification hook for other contracts: share exists,
 *    is unexpired, and is not revoked (per the share's own revoker contract).
 *
 * Nothing stored here is sensitive: every field is part of the cleartext share
 * payload by design. Posting on-chain does make the issuer→recipient sharing
 * relationship public. (A future variant may accept an encrypted payload as a
 * parallel entry type; this registry's cleartext entries would be unaffected.)
 */
contract ACPShareRegistry is UUPSUpgradeable, AccessControlUpgradeable {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice Role allowed to upgrade the implementation.
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// @custom:storage-location erc7201:cofhe.storage.ACPShareRegistry
    struct ACPShareRegistryStorage {
        /// @dev recipient => ids of shares addressed to them
        mapping(address => EnumerableSet.Bytes32Set) shareIdsFor;
        /// @dev share id => stored payload
        mapping(bytes32 => ACP) shares;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("cofhe.storage.ACPShareRegistry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ACP_SHARE_REGISTRY_SLOT =
        keccak256(abi.encode(uint256(keccak256("cofhe.storage.ACPShareRegistry")) - 1)) & ~bytes32(uint256(0xff));

    event Shared(address indexed recipient, address indexed issuer, bytes32 shareId);
    event ShareRemoved(address indexed recipient, address indexed issuer, bytes32 shareId);

    error NotIssuer();
    error NotIssuerOrRecipient();
    error RecipientMissing();
    error SealingKeyMustBeEmpty();
    error IssuerSignatureMissing();
    error ShareExpired();
    error AlreadyShared();
    error UnknownShare();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice              Initializes the contract.
     * @param initialAdmin  Receives DEFAULT_ADMIN_ROLE and UPGRADER_ROLE.
     */
    function initialize(address initialAdmin) public initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(UPGRADER_ROLE, initialAdmin);
    }

    /// @notice Post a sharing ACP for its recipient to pick up.
    /// @dev The share id is the hash of the payload — reposting an identical share reverts.
    function share(ACP calldata acp) external returns (bytes32 shareId) {
        if (msg.sender != acp.issuer) revert NotIssuer();
        if (acp.recipient == address(0)) revert RecipientMissing();
        if (acp.sealingKey != bytes32(0)) revert SealingKeyMustBeEmpty();
        if (acp.issuerSignature.length == 0) revert IssuerSignatureMissing();
        if (acp.expiration < block.timestamp) revert ShareExpired();

        ACPShareRegistryStorage storage $ = _getStorage();

        shareId = keccak256(abi.encode(acp));
        // the id commits to the recipient, so a duplicate can only be in this set
        if (!$.shareIdsFor[acp.recipient].add(shareId)) revert AlreadyShared();
        $.shares[shareId] = acp;

        emit Shared(acp.recipient, acp.issuer, shareId);
    }

    /// @notice Remove a share. The issuer may retract it; the recipient may dismiss it
    ///         (e.g. after importing, or to decline).
    function removeShare(bytes32 shareId) external {
        ACPShareRegistryStorage storage $ = _getStorage();

        ACP storage acp = $.shares[shareId];
        if (acp.issuer == address(0)) revert UnknownShare();
        if (msg.sender != acp.issuer && msg.sender != acp.recipient) revert NotIssuerOrRecipient();

        address recipient = acp.recipient;
        address issuer = acp.issuer;

        $.shareIdsFor[recipient].remove(shareId);
        delete $.shares[shareId];

        emit ShareRemoved(recipient, issuer, shareId);
    }

    /// @notice All importable shares addressed to `recipient`: unexpired and not revoked.
    ///         Dead entries stay in storage until removed but are filtered here.
    function sharesFor(address recipient) external view returns (ACP[] memory acps) {
        ACPShareRegistryStorage storage $ = _getStorage();
        EnumerableSet.Bytes32Set storage ids = $.shareIdsFor[recipient];
        uint256 len = ids.length();

        uint256 live = 0;
        for (uint256 i = 0; i < len; i++) {
            if (_isValid($.shares[ids.at(i)])) live++;
        }

        acps = new ACP[](live);
        uint256 j = 0;
        for (uint256 i = 0; i < len; i++) {
            ACP storage acp = $.shares[ids.at(i)];
            if (_isValid(acp)) {
                acps[j] = acp;
                j++;
            }
        }
    }

    /// @notice A single share by id (zeroed struct if unknown/removed).
    function getShare(bytes32 shareId) external view returns (ACP memory) {
        return _getStorage().shares[shareId];
    }

    /// @notice Verification hook for contracts: the share exists, was posted by its
    ///         claimed issuer (guaranteed at posting), is unexpired, and is not
    ///         revoked per its own revoker contract.
    function isShareValid(bytes32 shareId) external view returns (bool) {
        ACPShareRegistryStorage storage $ = _getStorage();
        if ($.shares[shareId].issuer == address(0)) return false;
        return _isValid($.shares[shareId]);
    }

    /// @dev Unexpired and not revoked. The revoker call mirrors `withPermission`'s
    ///      revocation clause; a reverting revoker fails closed (share invalid).
    function _isValid(ACP storage acp) private view returns (bool) {
        if (acp.expiration < block.timestamp) return false;

        if (acp.revokerData != 0 && acp.revokerContract != address(0)) {
            try IPermissionCustomIdValidator(acp.revokerContract).disabled(acp.issuer, acp.revokerData) returns (
                bool disabled
            ) {
                if (disabled) return false;
            } catch {
                return false;
            }
        }

        return true;
    }

    /**
     * @dev Should revert when `msg.sender` is not authorized to upgrade the contract.
     *      Empty implementation since authorization is handled by the role check.
     */
    /* solhint-disable-next-line no-empty-blocks */
    function _authorizeUpgrade(address _newImplementation) internal virtual override onlyRole(UPGRADER_ROLE) {}

    /**
     * @dev Returns the registry storage location.
     */
    function _getStorage() internal pure returns (ACPShareRegistryStorage storage $) {
        bytes32 slot = ACP_SHARE_REGISTRY_SLOT;
        assembly {
            $.slot := slot
        }
    }
}
