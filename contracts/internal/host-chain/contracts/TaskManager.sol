// SPDX-License-Identifier: BSD-3-Clause-Clear
/* solhint-disable one-contract-per-file */
pragma solidity >=0.8.25 <0.9.0;
import {ACL, Permission} from "./ACL.sol";
import {PlaintextsStorage} from "./PlaintextsStorage.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ITaskManager, FunctionId, Utils, EncryptedInput} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";


error DecryptionResultNotReady(uint256 ctHash);
// Input validation errors
error InvalidInputsAmount(string operation, uint256 got, uint256 expected);
error InvalidOperationInputs(string operation);
error TooManyInputs(string operation, uint256 got, uint256 maxAllowed);
error InvalidBytesLength(uint256 got, uint256 expected);
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
error OnlyOwnerAllowed(address caller);
error OnlyAggregatorAllowed(address caller);
error CofheIsUnavailable();


// Operation-specific errors
error RandomFunctionNotSupported();

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
        bytes memory combined;
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

contract TaskManager is ITaskManager, Initializable, UUPSUpgradeable, Ownable2StepUpgradeable {
    bool private initialized;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice              Initializes the contract.
     * @param initialOwner  Initial owner address.
     */
    function initialize(
        address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        initialized = true;
        verifierSigner = address(1);
        decryptResultSigner = address(1);
        isEnabled = true;
    }

    function setSecurityZones(int32 minSZ, int32 maxSZ) external onlyOwner {
        securityZoneMin = minSZ;
        securityZoneMax = maxSZ;
    }

    function isInitialized() public view returns (bool) {
        return initialized;
    }

    function getVersion() public view returns (uint8) {
        return version;
    }

    function incVersion() public onlyOwner {
        version++;
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    // Errors
    // Returned when the handle is not allowed in the ACL for the account.
    error ACLNotAllowed(uint256 handle, address account);

    // Events
    event TaskCreated(uint256 ctHash, string operation, uint256 input1, uint256 input2, uint256 input3);
    event ProtocolNotification(uint256 ctHash, string operation, string errorMessage);
    event DecryptionResult(uint256 ctHash, uint256 result, address indexed requestor);
    event DecryptResultSignerChanged(address indexed oldSigner, address indexed newSigner);
    event VerifierSignerChanged(address indexed oldSigner, address indexed newSigner);

    struct Task {
        address creator;
        uint256 createdAt;
        bool isResultReady;
    }

    // Supported Security Zones
    int32 private securityZoneMax;
    int32 private securityZoneMin;

    // Random counter
    uint256 private randomCounter;

    address private unusedAggregator; // Should never be used / deleted present only for storage layout

    // Access-Control contract
    ACL public acl;

    address public verifierSigner;

    uint8 private version;

    // Storage contract for plaintext results of decrypt operations
    PlaintextsStorage public plaintextsStorage;

    mapping(address aggregator => bool isActiveAggregator) public aggregators;

    // Whether the task manager is enabled
    // If disabled, all operations will revert
    bool public isEnabled;

    // Signer address for decrypt result verification (threshold network's signing key)
    // When set to address(0), signature verification is skipped (debug mode)
    address public decryptResultSigner;


    modifier onlyAggregator() {
        if (!aggregators[msg.sender]) {
            revert OnlyAggregatorAllowed(msg.sender);
        }
        _;
    }

    modifier onlyIfEnabled() {
        if (!isEnabled) {
            revert CofheIsUnavailable();
        }
        _;
    }

    function enable() external onlyOwner {
        isEnabled = true;
    }

    function disable() external onlyOwner {
        isEnabled = false;
    }

    function sendEventCreated(uint256 ctHash, string memory operation, uint256[] memory inputs) private onlyIfEnabled {
        if (inputs.length == 1) {
            emit TaskCreated(ctHash, operation, inputs[0], 0, 0);
        } else if (inputs.length == 2) {
            emit TaskCreated(ctHash, operation, inputs[0], inputs[1], 0);
        } else {
            emit TaskCreated(ctHash, operation, inputs[0], inputs[1], inputs[2]);
        }
    }

    function createDecryptTask(uint256 ctHash, address requestor) public {
        checkAllowed(ctHash);

        (uint256 result, bool hasResult) = plaintextsStorage.getResult(ctHash);
        if(hasResult) {
            emit DecryptionResult(ctHash, result, requestor);
        } else {
            uint256[] memory inputs = new uint256[](1);
            inputs[0] = uint256(uint160(requestor));
            sendEventCreated(ctHash, Utils.functionIdToString(FunctionId.decrypt), inputs);
        }
    }

    function checkAllowed(uint256 ctHash) internal view {
        if (!acl.isAllowed(ctHash, msg.sender)) revert ACLNotAllowed(ctHash, msg.sender);
    }

    function isUnaryOperation(FunctionId funcId) internal pure returns (bool) {
        return funcId == FunctionId.not || 
               funcId == FunctionId.square || 
               funcId == FunctionId.cast;
    }

    function isPlaintextOperation(FunctionId funcId) internal pure returns (bool) {
        return funcId == FunctionId.random || funcId == FunctionId.trivialEncrypt;
    }

    function getSecurityZone(FunctionId functionId, uint256[] memory encryptedInputs, uint256[] memory plaintextInputs) internal pure returns (int32) {
        if (isPlaintextOperation(functionId)) {
            // If inputs are plaintext (currently trivialEncrypt and random) the security zone will be the last input
            return int32(int256(plaintextInputs[plaintextInputs.length - 1]));
        }

        // First param of a function that receives some encrypted values will always be encrypted
        // Refer to: combineInput for more details
        return TMCommon.getSecurityZoneFromHash(encryptedInputs[0]);

    }

    function isValidSecurityZone(int32 _securityZone) internal view returns (bool) {
        return _securityZone >= securityZoneMin && _securityZone <= securityZoneMax;
    }

    function isValidSecurityZone(uint256 _securityZone) internal view returns (bool) {
        if (_securityZone > uint256(int256(type(int32).max))) {
            return false;
        }

        return isValidSecurityZone(int32(int256(_securityZone)));
    }

    function isValidType(uint8 t) internal pure returns (bool) {
        return t == Utils.EUINT8_TFHE ||
               t == Utils.EUINT16_TFHE ||
               t == Utils.EUINT32_TFHE ||
               t == Utils.EUINT64_TFHE ||
               t == Utils.EUINT128_TFHE ||
               t == Utils.EADDRESS_TFHE ||
               t == Utils.EBOOL_TFHE;
    }

    function isValidTypeUint256(uint256 t) internal pure returns (bool) {
        if (t > type(uint8).max) {
            return false;
        }

        return isValidType(uint8(t));
    }

    function validateEncryptedHashes(uint256[] memory encryptedHashes) internal view {
        for (uint8 i = 0; i < encryptedHashes.length; i++) {
            checkAllowed(encryptedHashes[i]);
        }
    }

    function validateTrivialEncryptInputs(uint256[] memory extraInputs) internal view {
        if (extraInputs[1] > type(uint8).max) {
            revert UnsupportedType(extraInputs[1]);
        }

        if (!isValidSecurityZone(extraInputs[2])) {
            revert InvalidSecurityZone(int32(int256(extraInputs[2])), securityZoneMin, securityZoneMax);
        }

        uint256 valueToEncrypt = extraInputs[0];
        uint8 toType = uint8(extraInputs[1]);

        if (toType == Utils.EUINT8_TFHE) {
            if (valueToEncrypt > type(uint8).max) {
                revert InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else if (toType == Utils.EUINT16_TFHE) {
            if (valueToEncrypt > type(uint16).max) {
                revert InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else if (toType == Utils.EUINT32_TFHE) {
            if (valueToEncrypt > type(uint32).max) {
                revert InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else if (toType == Utils.EUINT64_TFHE) {
            if (valueToEncrypt > type(uint64).max) {
                revert InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else if (toType == Utils.EUINT128_TFHE) {
            if (valueToEncrypt > type(uint128).max) {
                revert InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else if (toType == Utils.EADDRESS_TFHE) {
            if (valueToEncrypt > type(uint160).max) {
                revert InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else if (toType == Utils.EBOOL_TFHE) {
            if (valueToEncrypt > 1) {
                revert InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else {
            revert UnsupportedType(toType);
        }

    }

    // Verifies if a function is a function that supports all types (including select for ifTrue, ifFalse)
    function isAllTypesFunction(FunctionId funcId) internal pure returns (bool) {
        return funcId == FunctionId.select ||
               funcId == FunctionId.eq ||
               funcId == FunctionId.ne ||
               funcId == FunctionId.cast;
    }

    // Verifies if a function is receives ONLY boolean or numeral inputs
    function isBooleanAndNumeralFunction(FunctionId funcId) internal pure returns (bool) {
        return funcId == FunctionId.xor ||
               funcId == FunctionId.and ||
               funcId == FunctionId.or ||
               funcId == FunctionId.not;
    }

    function validateFunctionInputTypes(FunctionId funcId, string memory functionName, uint256[] memory inputs) internal pure {
        if (isAllTypesFunction(funcId)) {
            return;
        }

        if (isBooleanAndNumeralFunction(funcId)) {
            for (uint8 i = 0; i < inputs.length; i++) {
                uint8 inputType = TMCommon.getUintTypeFromHash(inputs[i]);
                if ((inputType ^ Utils.EADDRESS_TFHE) == 0) {
                    revert InvalidInputForFunction(functionName, Utils.EADDRESS_TFHE);
                }
            }
        } else {
            // In this case we expect a function that only work with numbers
            for (uint8 i = 0; i < inputs.length; i++) {
                uint8 inputType = TMCommon.getUintTypeFromHash(inputs[i]);
                if ((inputType ^ Utils.EADDRESS_TFHE) == 0 || (inputType ^ Utils.EBOOL_TFHE) == 0) {
                    revert InvalidInputForFunction(functionName, inputType);
                }
            }
        }
    }

    function validateEncryptedInputs(uint256[] memory encryptedHashes, FunctionId funcId) internal view {
        string memory functionName = Utils.functionIdToString(funcId);

        if (encryptedHashes.length == 0) {
            if (!isPlaintextOperation(funcId)) {
                revert InvalidOperationInputs(functionName);
            }
            return;
        }

        if (funcId == FunctionId.select) {
            validateSelectInputs(encryptedHashes);
        } else if (isUnaryOperation(funcId)) {
            if (encryptedHashes.length != 1) {
                revert InvalidInputsAmount(functionName, encryptedHashes.length, 1);
            }
        } else {
            if (encryptedHashes.length != 2) {
                revert InvalidInputsAmount(functionName, encryptedHashes.length, 2);
            }
            if ((TMCommon.getSecAndTypeFromHash(encryptedHashes[0] ^ encryptedHashes[1])) != 0) {
                revert InvalidTypeOrSecurityZone(functionName);
            }
        }

        int32 securityZone = TMCommon.getSecurityZoneFromHash(encryptedHashes[0]);
        if (!isValidSecurityZone(securityZone)) {
            revert InvalidSecurityZone(securityZone, securityZoneMin, securityZoneMax);
        }
        validateEncryptedHashes(encryptedHashes);
        validateFunctionInputTypes(funcId, functionName, encryptedHashes);
    }

    function validateSelectInputs(uint256[] memory encryptedHashes) internal pure {
        if (encryptedHashes.length != 3) {
            revert InvalidInputsAmount("select", encryptedHashes.length, 3);
        }
        if ((TMCommon.getSecAndTypeFromHash(encryptedHashes[1] ^ encryptedHashes[2])) != 0) {
            revert InvalidTypeOrSecurityZone("select");
        }

        uint8 uintType = TMCommon.getUintTypeFromHash(encryptedHashes[0]);
        if ((uintType ^ Utils.EBOOL_TFHE) != 0) {
            revert InvalidInputType(uintType, Utils.EBOOL_TFHE);
        }
    }

    function validateExtraInputs(uint256[] memory extraInputs, FunctionId funcId) internal view {
        // The amount of inputs shouldn't be validated here
        // We validate that the amount of all the inputs (encrypted and plaintext) is not greater than 3
        // And then we validate that the amount of encrypted inputs is correct
        // The above forces the amount of extra inputs to be correct

        if (funcId == FunctionId.trivialEncrypt) {
            validateTrivialEncryptInputs(extraInputs);
        } else if (funcId == FunctionId.cast) {
            if (!isValidTypeUint256(extraInputs[0])) {
                revert UnsupportedType(extraInputs[0]);
            }
        } else {
            revert InvalidOperationInputs(Utils.functionIdToString(funcId));
        }
    }

    function createRandomTask(uint8 returnType, uint256 seed, int32 securityZone) external returns (uint256) {
        if (!isValidType(returnType)) {
            revert UnsupportedType(returnType);
        }

        if (!isValidSecurityZone(securityZone)) {
            revert InvalidSecurityZone(securityZone, securityZoneMin, securityZoneMax);
        }

        if (seed == 0) {
            seed = _generateSeed(securityZone);
        }

        // seed is directly used as preCtHash for encrypted randoms
        uint256 ctHash = TMCommon.appendMetadata(seed, securityZone, returnType, false);
        acl.allowTransient(ctHash, msg.sender, address(this));
        emit TaskCreated(ctHash, Utils.functionIdToString(FunctionId.random), seed, uint256(uint32(securityZone)), 0);
        return ctHash;
    }

    function _generateSeed(int32 securityZone) internal returns (uint256 seed) {
        seed = uint256(
            keccak256(abi.encodePacked(blockhash(block.number - 1), block.timestamp, randomCounter, block.chainid, securityZone))
        );
        unchecked {
            // Unchecked increment; overflow is non-concerning and saves gas
            randomCounter++;
        }
    }

    function createTask(uint8 returnType, FunctionId funcId, uint256[] memory encryptedHashes, uint256[] memory extraInputs) external returns (uint256) {
        if (funcId == FunctionId.random) {
            revert RandomFunctionNotSupported();
        }

        if (!isValidType(returnType)) {
            revert UnsupportedType(returnType);
        }

        uint256 inputsLength = encryptedHashes.length + extraInputs.length;
        if (inputsLength > 3) {
            revert TooManyInputs( Utils.functionIdToString(funcId), inputsLength, 3 );
        }

        validateEncryptedInputs(encryptedHashes, funcId);
        if (extraInputs.length > 0) {
            validateExtraInputs(extraInputs, funcId);
        }

        uint256[] memory inputs = TMCommon.combineInputs(encryptedHashes, extraInputs);

        int32 securityZone = getSecurityZone(funcId, encryptedHashes, extraInputs);
        uint256 ctHash = TMCommon.calcPlaceholderKey(returnType, securityZone, inputs, funcId);

        acl.allowTransient(ctHash, msg.sender, address(this));
        sendEventCreated(ctHash, Utils.functionIdToString(funcId), inputs);

        return ctHash;
    }

    function handleDecryptResult(uint256 ctHash, uint256 result, address[] calldata requestors) external onlyAggregator {
        plaintextsStorage.storeResult(ctHash, result);
        for (uint8 i = 0; i < requestors.length; i++) {
            emit DecryptionResult(ctHash, result, requestors[i]);
        }
    }

    /// @notice Publish a signed decrypt result to the chain
    /// @dev Anyone with a valid signature from the decrypt network can call this
    /// @param ctHash The ciphertext hash
    /// @param result The decrypted plaintext value
    /// @param signature The ECDSA signature from the decrypt network
    function publishDecryptResult(
        uint256 ctHash,
        uint256 result,
        bytes calldata signature
    ) external onlyIfEnabled {
        _verifyDecryptResult(ctHash, result, signature, true);
        plaintextsStorage.storeResult(ctHash, result);
        emit DecryptionResult(ctHash, result, msg.sender);
    }

    /// @notice Publish multiple decrypt results in one transaction
    /// @dev Amortizes base tx cost across multiple operations
    function publishDecryptResultBatch(
        uint256[] calldata ctHashes,
        uint256[] calldata results,
        bytes[] calldata signatures
    ) external onlyIfEnabled {
        uint256 length = ctHashes.length;
        if (results.length != length || signatures.length != length) revert LengthMismatch();

        for (uint256 i = 0; i < length; i++) {
            _verifyDecryptResult(ctHashes[i], results[i], signatures[i], true);
            plaintextsStorage.storeResult(ctHashes[i], results[i]);
            emit DecryptionResult(ctHashes[i], results[i], msg.sender);
        }
    }

    /// @notice Verify a decrypt result signature without publishing
    /// @dev Returns true if signature is valid, reverts otherwise
    /// @return True if signature is valid
    function verifyDecryptResult(
        uint256 ctHash,
        uint256 result,
        bytes calldata signature
    ) external view returns (bool) {
        return _verifyDecryptResult(ctHash, result, signature, true);
    }

    /// @notice Verify a decrypt result signature without publishing (non-reverting)
    /// @dev Returns false if signature is invalid instead of reverting
    /// @return True if signature is valid, false otherwise
    function verifyDecryptResultSafe(
        uint256 ctHash,
        uint256 result,
        bytes calldata signature
    ) external view returns (bool) {
        return _verifyDecryptResult(ctHash, result, signature, false);
    }

    /// @dev Verify decrypt result signature
    /// @dev Skips verification if decryptResultSigner is address(0) (debug mode)
    /// @param shouldRevert If true, reverts on invalid signature; if false, returns false
    function _verifyDecryptResult(
        uint256 ctHash,
        uint256 result,
        bytes calldata signature,
        bool shouldRevert
    ) private view returns (bool) {
        if (decryptResultSigner == address(0)) {
            return true;
        }

        bytes32 messageHash = _computeDecryptResultHash(ctHash, result);
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(messageHash, signature);

        if (err != ECDSA.RecoverError.NoError || recovered == address(0)) {
            if (shouldRevert) revert InvalidSignature();
            return false;
        }
        if (recovered != decryptResultSigner) {
            if (shouldRevert) revert InvalidSigner(recovered, decryptResultSigner);
            return false;
        }
        return true;
    }

    /// @dev Compute message hash using assembly for gas efficiency
    /// @notice Format: result (32) || enc_type (4) || chain_id (8) || ct_hash (32) = 76 bytes
    function _computeDecryptResultHash(
        uint256 ctHash,
        uint256 result
    ) private view returns (bytes32 messageHash) {
        uint8 encryptionType = TMCommon.getUintTypeFromHash(ctHash);
        uint64 chainId = uint64(block.chainid);

        // Load constants for assembly
        uint256 shiftEncType = TMCommon.SHIFT_ENC_TYPE;
        uint256 shiftChainId = TMCommon.SHIFT_CHAIN_ID;
        uint256 offsetEncType = TMCommon.OFFSET_ENC_TYPE;
        uint256 offsetChainId = TMCommon.OFFSET_CHAIN_ID;
        uint256 offsetCtHash = TMCommon.OFFSET_CT_HASH;
        uint256 msgLength = TMCommon.MESSAGE_LENGTH;

        // Assembly for gas-efficient message construction
        // Overlapping 32-byte mstores are safe here: each subsequent mstore overwrites
        // only the tail bytes of the previous one, and the final mstore (ctHash) lands
        // exactly at the end of the 76-byte message, so all fields end up correctly placed.
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, result)                                            // bytes 0-31: result
            mstore(add(ptr, offsetEncType), shl(shiftEncType, encryptionType))  // bytes 32-35: enc_type
            mstore(add(ptr, offsetChainId), shl(shiftChainId, chainId))         // bytes 36-43: chain_id
            mstore(add(ptr, offsetCtHash), ctHash)                              // bytes 44-75: ctHash
            messageHash := keccak256(ptr, msgLength)                            // hash 76 bytes
            mstore(0x40, add(ptr, msgLength))                                   // advance free memory pointer
        }
    }

    function handleError(uint256 ctHash, string memory operation, string memory errorMessage) external onlyAggregator {
        emit ProtocolNotification(ctHash, operation, errorMessage);
    }

    function getDecryptResultSafe(uint256 ctHash) external view returns (uint256, bool) {
        return plaintextsStorage.getResult(ctHash);
    }

    function getDecryptResult(uint256 ctHash) external view returns (uint256) {
        (uint256 result, bool hadResult) = plaintextsStorage.getResult(ctHash);
        if (!hadResult) {
            revert DecryptionResultNotReady(ctHash);
        }
        return result;
    }

    function verifyInput(EncryptedInput memory input, address sender) external returns (uint256) {
        int32 securityZone = int32(uint32(input.securityZone));

        // When signer is set to 0 address we skip this logic to be able to support debug use cases.
        // In debug use cases we assume that the verifier is not necessarily running.
        if (verifierSigner != address(0)) {
            if (!isValidSecurityZone(securityZone)) {
                revert InvalidSecurityZone(securityZone, securityZoneMin, securityZoneMax);
            }

            address signer = extractSigner(input, sender);
            if (signer != verifierSigner) {
                revert InvalidSigner(signer, verifierSigner);
            }
        }

        uint256 appendedHash = TMCommon.appendMetadata(input.ctHash, securityZone, input.utype, false);

        acl.allowTransient(appendedHash, msg.sender, address(this));
        return appendedHash;
    }

    function allow(uint256 ctHash, address account) external {
        acl.allow(ctHash, account, msg.sender);
    }

    function allowGlobal(uint256 ctHash) external {
        acl.allowGlobal(ctHash, msg.sender);
    }

    function allowTransient(uint256 ctHash, address account) external {
        acl.allowTransient(ctHash, account, msg.sender);
    }

    function allowForDecryption(uint256 ctHash) external {
        uint256[] memory hashes = new uint256[](1);
        hashes[0] = ctHash;
        acl.allowForDecryption(hashes, msg.sender);
    }

    function isAllowed(uint256 ctHash, address account) external view returns (bool) {
        return acl.isAllowed(ctHash, account);
    }

    function extractSigner(EncryptedInput memory input, address sender) private view returns (address) {
        bytes memory combined = abi.encodePacked(
            input.ctHash,
            input.utype,
            input.securityZone,
            sender,
            block.chainid
        );

        bytes32 expectedHash = keccak256(combined);

        address signer = ECDSA.recover(expectedHash, input.signature);
        if (signer == address(0)) {
            revert InvalidSignature();
        }

        return signer;
    }

    function setVerifierSigner(address signer) external onlyOwner {
        address oldSigner = verifierSigner;
        verifierSigner = signer;
        emit VerifierSignerChanged(oldSigner, signer);
    }

    /// @notice Set the authorized signer for decrypt results
    /// @param signer The new signer address (address(0) disables verification)
    function setDecryptResultSigner(address signer) external onlyOwner {
        address oldSigner = decryptResultSigner;
        decryptResultSigner = signer;
        emit DecryptResultSignerChanged(oldSigner, signer);
    }

    function setSecurityZoneMax(int32 securityZone) external onlyOwner {
        if (securityZone < securityZoneMin) {
            revert InvalidSecurityZone(securityZone, securityZoneMin, securityZoneMax);
        }
        securityZoneMax = securityZone;
    }

    function setSecurityZoneMin(int32 securityZone) external onlyOwner {
        if (securityZone > securityZoneMax) {
            revert InvalidSecurityZone(securityZone, securityZoneMin, securityZoneMax);
        }
        securityZoneMin = securityZone;
    }

    function setACLContract(address _aclAddress) external onlyOwner {
        if (_aclAddress == address(0)) {
            revert InvalidAddress();
        }
        acl = ACL(_aclAddress);
    }

    function setPlaintextsStorage(address _plaintextsStorageAddress) external onlyOwner {
        if (_plaintextsStorageAddress == address(0)) {
            revert InvalidAddress();
        }
        plaintextsStorage = PlaintextsStorage(_plaintextsStorageAddress);
    }

    function addAggregator(address _aggregatorAddress) external onlyOwner {
        if (_aggregatorAddress == address(0)) {
            revert InvalidAddress();
        }

        aggregators[_aggregatorAddress] = true;
    }

    function removeAggregator(address _aggregatorAddress) external onlyOwner {
        if (_aggregatorAddress == address(0)) {
            revert InvalidAddress();
        }
        aggregators[_aggregatorAddress] = false;
    }

    function isAllowedWithPermission(Permission memory permission, uint256 handle) public view returns (bool) {
        return acl.isAllowedWithPermission(permission, handle);
    }
}