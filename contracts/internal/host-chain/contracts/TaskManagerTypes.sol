// SPDX-License-Identifier: BSD-3-Clause-Clear
/* solhint-disable one-contract-per-file */
pragma solidity >=0.8.25 <0.9.0;

import {FunctionId, Utils} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";

// Shared by TaskManager and TaskManagerLib, so the library does not import TaskManager.

/// @dev Declared in an interface that TaskManager inherits, so the ABI keeps every error,
///      including the ones that revert from TaskManagerLib.
interface ITaskManagerErrors {
    error DecryptionResultNotReady(uint256 ctHash);
    // Input validation errors
    error InvalidInputsAmount(string operation, uint256 got, uint256 expected);
    error InvalidOperationInputs(string operation);
    error TooManyInputs(string operation, uint256 got, uint256 maxAllowed);
    // Type and security validation errors
    error InvalidTypeOrSecurityZone(string operation);
    error InvalidInputType(uint8 actual, uint8 expected);
    error InvalidInputForFunction(string functionName, uint8 inputType);
    error InvalidSecurityZone(int32 zone, int32 min, int32 max);
    error InvalidSignature();
    error InvalidSigner(address signer, address expectedSigner);
    error UnsupportedType(uint256 t);
    error LengthMismatch();

    // Access control errors
    error InvalidAddress();
    error CofheIsUnavailable();
    error NotOnAccessList(address caller);
    error OnDenyList(address caller);


    // Operation-specific errors
    error RandomFunctionNotSupported();
    error DecryptFunctionNotSupported();

    error ACLNotAllowed(uint256 handle, address account);

    // OpenZeppelin ECDSA errors. ECDSA now runs in TaskManagerLib, so they are re-declared
    // here with the same signatures to keep them in TaskManager's ABI.
    error ECDSAInvalidSignature();
    error ECDSAInvalidSignatureLength(uint256 length);
    error ECDSAInvalidSignatureS(bytes32 s);
}

/// @dev Inherited by TaskManager, so the ABI keeps the events that TaskManagerLib emits.
interface ITaskManagerEvents {
    event TaskCreated(uint256 ctHash, string operation, uint256 input1, uint256 input2, uint256 input3);
    event ProtocolNotification(uint256 ctHash, string operation, string errorMessage);
    event DecryptionResult(uint256 ctHash, uint256 result, address indexed requestor);
    event InputVerified(uint256 indexed ctHash, bytes32 commitment);
    event DecryptResultSignerChanged(address indexed oldSigner, address indexed newSigner);
    event VerifierSignerChanged(address indexed oldSigner, address indexed newSigner);
    event AccessListEnabledSet(bool enabled);
    event AccessGranted(address indexed account);
    event AccessRevoked(address indexed account);
    event DenyListSet(address indexed account, bool denied);
    event ACLContractChanged(address indexed oldACL, address indexed newACL);
    event PlaintextsStorageChanged(address indexed oldStorage, address indexed newStorage);
    event SecurityZonesChanged(int32 oldMin, int32 oldMax, int32 newMin, int32 newMax);
    event EnabledSet(bool enabled);
    event VersionIncremented(uint8 newVersion);
}

library TMCommon {
    uint256 private constant HASH_MASK_FOR_METADATA  = type(uint256).max - type(uint16).max; // 2 bytes reserved for metadata
    uint256 private constant SECURITY_ZONE_MASK = type(uint8).max; // 0xff -  1 byte reserved for security zone
    uint256 private constant UINT_TYPE_MASK = (type(uint8).max >> 1); // 0x7f - 7 bits reserved for uint type in the one before last byte
    uint256 private constant TRIVIALLY_ENCRYPTED_MASK = type(uint8).max - UINT_TYPE_MASK; //0x80  1 bit reserved for isTriviallyEncrypted
    uint256 private constant TYPE_AND_TRIVIALLY_ENCRYPTED_BYTE_OFFSET = 8;
    uint256 private constant SHIFTED_TYPE_MASK = UINT_TYPE_MASK << TYPE_AND_TRIVIALLY_ENCRYPTED_BYTE_OFFSET; // 0x7f00 - 7 bits reserved for uint type in the one before last byte
    uint256 private constant SHIFTED_TRIVIALLY_ENCRYPTED_MASK = TRIVIALLY_ENCRYPTED_MASK << TYPE_AND_TRIVIALLY_ENCRYPTED_BYTE_OFFSET; //0x80  1 bit reserved for isTriviallyEncrypted
    /*
      The format: keccak256(operands_list, op)[0:29] || is_trivial (1 bit) & ct_type (7 bit) || securityZone
    */

    // Constants for decrypt result hash computation (message format: result || enc_type || chain_id || ct_hash)
    uint256 internal constant SHIFT_ENC_TYPE = 224;      // Shift for 4-byte enc_type (256 - 32 = 224)
    uint256 internal constant SHIFT_CHAIN_ID = 192;      // Shift for 8-byte chain_id (256 - 64 = 192)
    uint256 internal constant OFFSET_ENC_TYPE = 0x20;    // Byte offset for enc_type in message
    uint256 internal constant OFFSET_CHAIN_ID = 0x24;    // Byte offset for chain_id in message
    uint256 internal constant OFFSET_CT_HASH = 0x2c;     // Byte offset for ctHash in message
    uint256 internal constant MESSAGE_LENGTH = 0x4c;     // Total message length: 76 bytes

    function uint256ToBytes32(uint256 value) internal pure returns (bytes memory) {
        bytes memory result = new bytes(32);
        assembly {
            mstore(add(result, 32), value)
        }
        return result;
    }

    function combineInputs(uint256[] memory encryptedHashes, uint256[] memory extraInputs) internal pure returns (uint256[] memory) {
        uint256[] memory inputs = new uint256[](encryptedHashes.length + extraInputs.length);
        uint8 i = 0;
        for (; i < encryptedHashes.length; i++) {
            inputs[i] = encryptedHashes[i];
        }
        for (; i < encryptedHashes.length + extraInputs.length; i++) {
            inputs[i] = extraInputs[i - encryptedHashes.length];
        }

        return inputs;
    }

    function getReturnType(FunctionId functionId, uint8 ctType) internal pure returns (uint8) {
        if (functionId == FunctionId.lte ||
            functionId == FunctionId.lt ||
            functionId == FunctionId.gte ||
            functionId == FunctionId.gt ||
            functionId == FunctionId.eq ||
            functionId == FunctionId.ne) {
            return Utils.EBOOL_TFHE;
        }

        return ctType;
    }

    /// @notice Calculates the temporary hash for async operations
    /// @dev Must result the same temp hash as calculated by warp-drive/fhe-driver/CalcBinaryPlaceholderValueHash
    /// @param functionId - The function id
    /// @return The calculated temporary key
    function calcPlaceholderKey(
        uint8 ctType,
        int32 securityZone,
        uint256[] memory inputs,
        FunctionId functionId
    ) internal pure returns (uint256) {
        bytes memory combined = "";
        bool isTriviallyEncrypted = (functionId == FunctionId.trivialEncrypt);
        for (uint8 i = 0; i < inputs.length; i++) {
            combined = bytes.concat(combined, uint256ToBytes32(inputs[i]));
        }

        // Square is doing mul behind the scene
        if (functionId == FunctionId.square) {
            functionId = FunctionId.mul;
            combined = bytes.concat(combined, uint256ToBytes32(inputs[0]));
        }

        bytes1 functionIdByte = bytes1(uint8(functionId));
        combined = bytes.concat(combined, functionIdByte);

        // Calculate Keccak256 hash
        bytes32 hash = keccak256(combined);

        return appendMetadata(uint256(hash), securityZone, getReturnType(functionId, ctType), isTriviallyEncrypted);
    }

    function getByteForTrivialAndType(bool isTrivial, uint8 uintType) internal pure returns (uint256) {
      /// @dev first bit for isTriviallyEncrypted
      /// @dev last 7 bits for uintType

      return uint256(((isTrivial ? SHIFTED_TRIVIALLY_ENCRYPTED_MASK : 0x0000) | (uint256(uintType) << TYPE_AND_TRIVIALLY_ENCRYPTED_BYTE_OFFSET) & SHIFTED_TYPE_MASK));
    }

    /**
     *      Results format is: keccak256(operands_list, op)[0:29] || is_trivial (1 bit) & ct_type (7 bit) || securityZone
     */
    function appendMetadata(uint256 preCtHash, int32 securityZone, uint8 uintType, bool isTrivial) internal pure returns (uint256 result) {
        result = preCtHash & HASH_MASK_FOR_METADATA ;
        uint256 metadata = getByteForTrivialAndType(isTrivial, uintType) | (uint256(uint8(int8(securityZone)))); /// @dev 8 bits for type, 8 bits for securityZone
        result = result | metadata;
    }

    function getSecurityZoneFromHash(uint256 hash) internal pure returns (int32) {
      return int32(int8(uint8(hash & SECURITY_ZONE_MASK)));
    }

    function getUintTypeFromHash(uint256 hash) internal pure returns (uint8) {
      return uint8((hash & SHIFTED_TYPE_MASK) >> 8);
    }

    function getSecAndTypeFromHash(uint256 hash) internal pure returns (uint256) {
      return uint256((SHIFTED_TYPE_MASK | SECURITY_ZONE_MASK) & hash);
    }
}
