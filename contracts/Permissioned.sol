// solhint-disable func-name-mixedcase
// SPDX-License-Identifier: MIT
pragma solidity >=0.8.19 <0.9.0;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @dev Permission body that must be passed to a contract to allow access to sensitive data.
 *
 * The minimum permission to access a user's own data requires the fields
 * < issuer, expiration, contracts, projects, sealingKey, issuerSignature >
 *
 * `contracts` and `projects` are lists defining which contracts can be accessed with this permission.
 * `projects` is a list of strings, each of which defines and provides access to a group of contracts.
 *
 *   ---
 *
 * If not sharing the permission, `issuer` signs a signature using the fields:
 *     < issuer, expiration, contracts, projects, recipient, validatorId, validatorContract, sealingKey >
 * This signature can now be used by `issuer` to access their own encrypted data.
 *
 *   ---
 *
 * Sharing a permission is a two step process: `issuer` completes step 1, and `recipient` completes step 2.
 *
 * 1:
 * `issuer` creates a permission with `recipient` populated with the address of the user to give access to.
 * `issuer` does not include a `sealingKey` in the permission, it will be populated by the `recipient`.
 * `issuer` is still responsible for defining the permission's access through `contracts` and `projects`.
 * `issuer` signs a signature including the fields: (note: `sealingKey` is absent in this signature)
 *     < issuer, expiration, contracts, projects, recipient, validatorId, validatorContract >
 * `issuer` packages the permission data and `issuerSignature` and shares it with `recipient`
 *     ** None of this data is sensitive, and can be shared as cleartext **
 *
 * 2:
 * `recipient` adds their `sealingKey` to the data received from `issuer`
 * `recipient` signs a signature including the fields:
 *     < sealingKey, issuerSignature >
 * `recipient` can now use the completed Permission to access `issuer`s encrypted data.
 *
 *   ---
 *
 * `validatorId` and `validatorContract` are optional and can be used together to
 * increase security and control by disabling a permission after it has been created.
 * Useful when sharing permits to provide external access to sensitive data (eg auditors).
 */
struct Permission {
    // (base) User that initially created the permission, target of data fetching
    address issuer;
    // (base) Expiration timestamp
    uint64 expiration;
    // (base) List of contract addresses that can be accessed with this permission
    address[] contracts;
    // (base) List of project identifiers (strings) that can be accessed
    string[] projects;
    // (sharing) The user that this permission will be shared with
    // ** optional, use `address(0)` to disable **
    address recipient;
    // (issuer defined validation) An id used to query a contract to check this permissions validity
    // ** optional, use `0` to disable **
    uint256 validatorId;
    // (issuer defined validation) The contract to query to determine permission validity
    // ** optional, user `address(0)` to disable **
    address validatorContract;
    // (base) The publicKey of a sealingPair used to re-encrypt `issuer`s confidential data
    //   (non-sharing) Populated by `issuer`
    //   (sharing)     Populated by `recipient`
    bytes32 sealingKey;
    // (base) `signTypedData` signature created by `issuer`.
    // (base) Shared- and Self- permissions differ in signature format: (`sealingKey` absent in shared signature)
    //   (non-sharing) < issuer, expiration, contracts, projects, recipient, validatorId, validatorContract, sealingKey >
    //   (sharing)     < issuer, expiration, contracts, projects, recipient, validatorId, validatorContract >
    bytes issuerSignature;
    // (sharing) `signTypedData` signature created by `recipient` with format:
    // (sharing) < sealingKey, issuerSignature>
    // ** required for shared permits **
    bytes recipientSignature;
}

/// @dev Minimum required interface to create a custom permission validator.
/// Permission validators are optional, and provide extra security and control when sharing permits.
interface IPermissionCustomIdValidator {
    /// @dev Checks whether a permission is valid, returning `false` disables the permission.
    function disabled(address issuer, uint256 id) external view returns (bool);
}

/// @dev Uses a modified version of openzeppelin's EIP712 contract which disables the `verifyingContract`.
/// Instead, access is checked using the `contracts` and `projects` fields of the `Permission` struct.
/// This allows a single signed permission to be used to access multiple contracts encrypted data.
contract PermissionedUpgradeable is Initializable, EIP712Upgradeable {
    using PermissionUtils for Permission;

    function __PermissionedUpgradeable_init() internal onlyInitializing {
        __EIP712_init_unchained("Fhenix Access Control Permission", "1");
    }

    function __PermissionedUpgradeable_init_unchained()
        internal
        onlyInitializing
    {}

    /// @dev Emitted when `project` is not in `permission.projects` nor `address(this)` in `permission.contracts`
    error PermissionInvalid_ContractUnauthorized();

    /// @dev Emitted when `permission.expiration` is in the past (< block.timestamp)
    error PermissionInvalid_Expired();

    /// @dev Emitted when `issuerSignature` is malformed or was not signed by `permission.issuer`
    error PermissionInvalid_IssuerSignature();

    /// @dev Emitted when `recipientSignature` is malformed or was not signed by `permission.recipient`
    error PermissionInvalid_RecipientSignature();

    /// @dev Emitted when `validatorContract` returned `false` indicating that this permission has been externally disabled
    error PermissionInvalid_Disabled();

    /// @dev Validate's a `permissions` access of sensitive data.
    /// `permission` may be invalid or unauthorized for the following reasons:
    ///    - Contract unauthorized:    `project` is not in `permission.projects` nor address(this) in `permission.contracts`
    ///    - Expired:                  `permission.expiration` is in the past (< block.timestamp)
    ///    - Issuer signature:         `issuerSignature` is malformed or was not signed by `permission.issuer`
    ///    - Recipient signature:      `recipientSignature` is malformed or was not signed by `permission.recipient`
    ///    - Disabled:                 `validatorContract` returned `false` indicating that this permission has been externally disabled
    /// @param permission Permission struct containing data necessary to validate data access and seal for return.
    ///
    /// NOTE: Functions protected by `withPermission` should return ONLY the sensitive data of `permission.issuer`.
    /// !! Returning data of `msg.sender` will leak sensitive values - `msg.sender` cannot be trusted in view functions !!
    modifier withPermission(Permission memory permission) {
        // Expiration
        if (permission.expiration < block.timestamp)
            revert PermissionInvalid_Expired();

        // Issuer signature
        if (
            !SignatureChecker.isValidSignatureNow(
                permission.issuer,
                _hashTypedDataV4(permission.issuerHash()),
                permission.issuerSignature
            )
        ) revert PermissionInvalid_IssuerSignature();

        // (if applicable) Recipient signature
        if (
            permission.recipient != address(0) &&
            !SignatureChecker.isValidSignatureNow(
                permission.recipient,
                _hashTypedDataV4(permission.recipientHash()),
                permission.recipientSignature
            )
        ) revert PermissionInvalid_RecipientSignature();

        // (if applicable) Externally disabled
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
}

/// @dev Internal utility library to improve the readability of PermissionedV2
/// Primarily focused on signature type hashes
library PermissionUtils {
    function issuerHash(
        Permission memory permission
    ) internal pure returns (bytes32) {
        if (permission.recipient == address(0))
            return issuerSelfHash(permission);
        return issuerSharedHash(permission);
    }

    function issuerSelfHash(
        Permission memory permission
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "PermissionedV2IssuerSelf(address issuer,uint64 expiration,address[] contracts,string[] projects,address recipient,uint256 validatorId,address validatorContract,bytes32 sealingKey)"
                    ),
                    permission.issuer,
                    permission.expiration,
                    encodeArray(permission.contracts),
                    encodeArray(permission.projects),
                    permission.recipient,
                    permission.validatorId,
                    permission.validatorContract,
                    permission.sealingKey
                )
            );
    }

    function issuerSharedHash(
        Permission memory permission
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "PermissionedV2IssuerShared(address issuer,uint64 expiration,address[] contracts,string[] projects,address recipient,uint256 validatorId,address validatorContract)"
                    ),
                    permission.issuer,
                    permission.expiration,
                    encodeArray(permission.contracts),
                    encodeArray(permission.projects),
                    permission.recipient,
                    permission.validatorId,
                    permission.validatorContract
                )
            );
    }

    function recipientHash(
        Permission memory permission
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "PermissionedV2Recipient(bytes32 sealingKey,bytes issuerSignature)"
                    ),
                    permission.sealingKey,
                    keccak256(permission.issuerSignature)
                )
            );
    }

    function satisfies(
        Permission memory permission,
        address addr,
        string memory proj
    ) internal pure returns (bool) {
        for (uint256 i = 0; i < permission.projects.length; i++) {
            if (
                keccak256(abi.encodePacked(proj)) ==
                keccak256(abi.encodePacked(permission.projects[i]))
            ) return true;
        }
        for (uint256 i = 0; i < permission.contracts.length; i++) {
            if (addr == permission.contracts[i]) return true;
        }
        return false;
    }

    function encodeArray(
        address[] memory items
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(items));
    }

    function encodeArray(
        string[] memory items
    ) internal pure returns (bytes32) {
        bytes32[] memory result = new bytes32[](items.length);
        for (uint256 i = 0; i < items.length; i++) {
            result[i] = keccak256(bytes(items[i]));
        }
        return keccak256(abi.encodePacked(result));
    }
}
