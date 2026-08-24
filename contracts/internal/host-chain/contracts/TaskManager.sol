// SPDX-License-Identifier: BSD-3-Clause-Clear
/* solhint-disable one-contract-per-file */
pragma solidity >=0.8.25 <0.9.0;
import {LegacyOwnable} from "./LegacyOwnable.sol";
import {ACL, ACP} from "./ACL.sol";
import {PlaintextsStorage} from "./PlaintextsStorage.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlDefaultAdminRulesUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ITaskManager, FunctionId, Utils, UnsignedEncryptedInput} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";


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
error CofheIsUnavailable();
error NotOnAccessList(address caller);


// Operation-specific errors
error RandomFunctionNotSupported();
error DecryptFunctionNotSupported();

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

contract TaskManager is ITaskManager, Initializable, UUPSUpgradeable, AccessControlDefaultAdminRulesUpgradeable {
    // ---------------------------------------------------------------------------------------
    // Roles. Splitting `onlyOwner` into capabilities limits *who has to hold* each key, not how
    // much damage each key can do. Four of these are protocol-critical - a single holder can
    // break confidentiality or integrity outright, without ever touching the implementation:
    //
    //   UPGRADER_ROLE                 arbitrary implementation, i.e. everything.
    //   CONFIG_MANAGER_ROLE           repoints `acl` (permissive `isAllowed` -> unrestricted
    //                                 ciphertext access) and `plaintextsStorage` (arbitrary
    //                                 plaintext for any handle). See setACLContract below.
    //   VERIFIER_SIGNER_MANAGER_ROLE  forges encrypted inputs; `address(0)` skips verification.
    //   DECRYPT_SIGNER_MANAGER_ROLE   forges decrypt results; `address(0)` skips verification.
    //
    // Treat those four as admin-equivalent: they belong on the same governance as
    // DEFAULT_ADMIN_ROLE, not on an operational hot key. Only PAUSER_ROLE,
    // SECURITY_ZONE_MANAGER_ROLE and ACCESS_LIST_MANAGER_ROLE are genuinely narrow - their worst
    // case is availability (halting intake, or gating it to an allowlist), not disclosure.
    // ---------------------------------------------------------------------------------------
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant SECURITY_ZONE_MANAGER_ROLE = keccak256("SECURITY_ZONE_MANAGER_ROLE");
    bytes32 public constant ACCESS_LIST_MANAGER_ROLE = keccak256("ACCESS_LIST_MANAGER_ROLE");
    bytes32 public constant VERIFIER_SIGNER_MANAGER_ROLE = keccak256("VERIFIER_SIGNER_MANAGER_ROLE");
    bytes32 public constant DECRYPT_SIGNER_MANAGER_ROLE = keccak256("DECRYPT_SIGNER_MANAGER_ROLE");
    /// @dev Admin-equivalent despite the name - see the role notes above.
    bytes32 public constant CONFIG_MANAGER_ROLE = keccak256("CONFIG_MANAGER_ROLE");

    /// @dev Reserves the namespaces this contract used while it inherited Ownable2StepUpgradeable.
    ///      Already-deployed proxies still hold an owner there; keeping the declarations marks
    ///      that storage as taken so a later upgrade cannot silently reuse it.
    /// @custom:storage-location erc7201:openzeppelin.storage.Ownable
    struct OwnableStorage {
        address _owner;
    }

    /// @custom:storage-location erc7201:openzeppelin.storage.Ownable2Step
    struct Ownable2StepStorage {
        address _pendingOwner;
    }

    bool private initialized;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice              Initializes the contract.
     * @param initialAdmin  Initial admin address.
     * @param initialDelay  Initial delay for the default admin transfer.
     */
    function initialize(
        address initialAdmin, uint48 initialDelay) public initializer {
        __AccessControlDefaultAdminRules_init(initialDelay, initialAdmin);
        __UUPSUpgradeable_init();
        initialized = true;
        verifierSigner = address(1);
        decryptResultSigner = address(1);
        isEnabled = true;
    }

    /// @dev Upgrade-only re-initializer for proxies migrating from the Ownable implementation.
    ///      Callable only by the owner the pre-roles implementation left behind - the same account
    ///      its `_authorizeUpgrade` required - so the migration does not depend on being bundled
    ///      into `upgradeToAndCall`. Without that check `reinitializer(2)` passes on any proxy
    ///      whose `_initialized == 1`, and the inherited `_grantRole` guard does not fire while
    ///      `defaultAdmin()` is still zero, leaving DEFAULT_ADMIN_ROLE free for the taking.
    ///
    ///      Grants the operational roles to `initialAdmin` as well as DEFAULT_ADMIN_ROLE. The admin
    ///      can grant them to itself anyway, so this is no extra power - it just means a migration
    ///      driven by a Safe or a manual `cast send`, with no follow-up script, cannot leave the
    ///      proxy without an UPGRADER_ROLE holder (which would brick it permanently).
    ///      Revoke afterwards to re-establish separation.
    /// @param initialAdmin  Address receiving DEFAULT_ADMIN_ROLE and the operational roles.
    /// @param initialDelay  Delay enforced on subsequent default-admin transfers.
    /// @custom:oz-upgrades-validate-as-initializer
    function initializeV2(address initialAdmin, uint48 initialDelay) public reinitializer(2) {
        LegacyOwnable.requireLegacyOwner(msg.sender);
        __AccessControlDefaultAdminRules_init(initialDelay, initialAdmin);

        // Looped rather than seven inlined calls: `_grantRole` is large enough that inlining it
        // seven times costs ~1KB of the 24KB limit, and TaskManager is already the contract closest
        // to it.
        bytes32[7] memory roles = [
            UPGRADER_ROLE,
            PAUSER_ROLE,
            SECURITY_ZONE_MANAGER_ROLE,
            ACCESS_LIST_MANAGER_ROLE,
            VERIFIER_SIGNER_MANAGER_ROLE,
            DECRYPT_SIGNER_MANAGER_ROLE,
            CONFIG_MANAGER_ROLE
        ];
        for (uint256 i = 0; i < roles.length; i++) {
            _grantRole(roles[i], initialAdmin);
        }

        // A proxy arriving from the deterministic bootstrap stub reinterprets slots: that stub
        // stops at slot 3, so TaskManager's `verifierSigner` (slot 4) and `decryptResultSigner`
        // (slot 7) read storage it never wrote, i.e. zero - which is the verification-*disabled*
        // sentinel, not a safe default. Seed the fail-closed value so a migrated proxy is safe by
        // construction rather than by whatever the deploy script gets around to setting.
        //
        // Zero is also a legitimate configured state - the debug bypass at L789/L861 - so a proxy
        // deliberately running with verification off is flipped fail-closed here and has to re-set
        // it after migrating. `isEnabled`, `acl` and `plaintextsStorage` are deliberately not
        // touched: the first is already true on a live proxy (migrating must not pause it), and the
        // latter two have no safe default and must be set via CONFIG_MANAGER_ROLE.
        if (verifierSigner == address(0)) verifierSigner = address(1);
        if (decryptResultSigner == address(0)) decryptResultSigner = address(1);
    }

    function setSecurityZones(int32 minSZ, int32 maxSZ) external onlyRole(SECURITY_ZONE_MANAGER_ROLE) {
        securityZoneMin = minSZ;
        securityZoneMax = maxSZ;
    }

    function isInitialized() public view returns (bool) {
        return initialized;
    }

    function getVersion() public view returns (uint8) {
        return version;
    }

    function incVersion() public onlyRole(UPGRADER_ROLE) {
        version++;
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    // Errors
    // Returned when the handle is not allowed in the ACL for the account.
    error ACLNotAllowed(uint256 handle, address account);

    // Events
    event TaskCreated(uint256 ctHash, string operation, uint256 input1, uint256 input2, uint256 input3);
    event ProtocolNotification(uint256 ctHash, string operation, string errorMessage);
    event DecryptionResult(uint256 ctHash, uint256 result, address indexed requestor);
    event InputVerified(uint256 indexed ctHash, bytes32 commitment);
    event DecryptResultSignerChanged(address indexed oldSigner, address indexed newSigner);
    event VerifierSignerChanged(address indexed oldSigner, address indexed newSigner);
    event AccessListEnabledSet(bool enabled);
    event AccessGranted(address indexed account);
    event AccessRevoked(address indexed account);

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

    // Deprecated: this address is no longer used
    address private _aggregator;

    // Access-Control contract
    ACL public acl;

    address public verifierSigner;

    uint8 private version;

    // Storage contract for plaintext results of decrypt operations
    PlaintextsStorage public plaintextsStorage;

    // Deprecated: the aggregator allowlist and the unsigned `handleDecryptResult` / `handleError`
    // entry points it gated are gone. Decrypt results are now published only through the
    // signature-checked `publishDecryptResult*`. Kept so the slot stays reserved.
    mapping(address aggregator => bool isActiveAggregator) public _aggregators;

    // Master kill-switch for coprocessor intake.
    // When disabled, task creation (createTask, createRandomTask) and
    // decrypt-result publishing revert.
    bool public isEnabled;

    // Signer address for decrypt result verification (threshold network's signing key)
    // When set to address(0), signature verification is skipped (debug mode)
    address public decryptResultSigner;

    // Optional access list managed by ACCESS_LIST_MANAGER_ROLE, off by default (no behavior
    // change until enabled).
    bool public accessListEnabled;
    mapping(address account => bool isAllowed) public accessList;

    modifier onlyIfEnabled() {
        if (!isEnabled) {
            revert CofheIsUnavailable();
        }
        _;
    }

    // Gates task intake to allowlisted callers when the access list is enabled.
    // Short-circuits when disabled, so the mapping is only read while the list is active.
    modifier onlyAccessListed() {
        if (accessListEnabled && !accessList[msg.sender]) {
            revert NotOnAccessList(msg.sender);
        }
        _;
    }

    function enable() external onlyRole(PAUSER_ROLE) {
        isEnabled = true;
    }

    function disable() external onlyRole(PAUSER_ROLE) {
        isEnabled = false;
    }

    function enableAccessList() external onlyRole(ACCESS_LIST_MANAGER_ROLE) {
        accessListEnabled = true;
        emit AccessListEnabledSet(true);
    }

    function disableAccessList() external onlyRole(ACCESS_LIST_MANAGER_ROLE) {
        accessListEnabled = false;
        emit AccessListEnabledSet(false);
    }

    function addToAccessList(address[] calldata accounts) external onlyRole(ACCESS_LIST_MANAGER_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            if (accounts[i] == address(0)) {
                revert InvalidAddress();
            }
            accessList[accounts[i]] = true;
            emit AccessGranted(accounts[i]);
        }
    }

    function removeFromAccessList(address[] calldata accounts) external onlyRole(ACCESS_LIST_MANAGER_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            if (accounts[i] == address(0)) {
                revert InvalidAddress();
            }
            accessList[accounts[i]] = false;
            emit AccessRevoked(accounts[i]);
        }
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

    function createRandomTask(uint8 returnType, uint256 seed, int32 securityZone) external onlyIfEnabled onlyAccessListed returns (uint256) {
        if (!isValidType(returnType)) {
            revert UnsupportedType(returnType);
        }

        if (!isValidSecurityZone(securityZone)) {
            revert InvalidSecurityZone(securityZone, securityZoneMin, securityZoneMax);
        }

        if (seed == 0) {
            seed = _generateSeed(securityZone);
        }

        /// @dev msg.sender is part of the preimage so the same seed from different
        /// callers yields different handles.
        uint256[] memory inputs = new uint256[](2);
        inputs[0] = seed;
        inputs[1] = uint256(uint160(msg.sender));

        uint256 ctHash = TMCommon.calcPlaceholderKey(returnType, securityZone, inputs, FunctionId.random);
        acl.allowTransient(ctHash, msg.sender, address(this));
        emit TaskCreated(ctHash, Utils.functionIdToString(FunctionId.random), seed, uint256(uint32(securityZone)), inputs[1]);
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

    function createTask(uint8 returnType, FunctionId funcId, uint256[] memory encryptedHashes, uint256[] memory extraInputs) external onlyAccessListed returns (uint256) {
        if (funcId == FunctionId.random) {
            revert RandomFunctionNotSupported();
        }

        if (funcId == FunctionId.decrypt) {
            revert DecryptFunctionNotSupported();
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

    /// @notice Verify multiple decrypt result signatures without publishing
    /// @dev Reverts if any signature is invalid
    function verifyDecryptResultBatch(
        uint256[] calldata ctHashes,
        uint256[] calldata results,
        bytes[] calldata signatures
    ) external view returns (bool) {
        uint256 length = ctHashes.length;
        if (results.length != length || signatures.length != length) revert LengthMismatch();

        for (uint256 i = 0; i < length; i++) {
            _verifyDecryptResult(ctHashes[i], results[i], signatures[i], true);
        }
        return true;
    }

    /// @notice Verify multiple decrypt result signatures without publishing (non-reverting)
    /// @dev Returns per-item results instead of reverting
    function verifyDecryptResultBatchSafe(
        uint256[] calldata ctHashes,
        uint256[] calldata results,
        bytes[] calldata signatures
    ) external view returns (bool[] memory) {
        uint256 length = ctHashes.length;
        if (results.length != length || signatures.length != length) revert LengthMismatch();

        bool[] memory validResults = new bool[](length);
        for (uint256 i = 0; i < length; i++) {
            validResults[i] = _verifyDecryptResult(ctHashes[i], results[i], signatures[i], false);
        }
        return validResults;
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
        // slither-disable-next-line unused-return
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

    // slither-disable-next-line unused-return
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

    /// @notice Verify a batch of encrypted inputs that share a single signature.
    /// @dev The only input-verification entry point: a single input is a batch of one.
    ///      The verifier signs the whole batch with one signature over
    ///      keccak256(h_0 || h_1 || ... || h_n), where each h_i is the per-input
    ///      message hash
    ///      keccak256(ctHash || utype || securityZone || sender || chainid || contractAddress).
    ///      The batch is bound to the consuming contract (`msg.sender`), so it
    ///      cannot be replayed into a different contract.
    ///      Inputs are processed in order; the returned hashes line up with `inputs`.
    ///      Emits one `InputVerified` per input, in input order — the same event
    ///      the single-input flow emitted, so the commitment relay reads a batch
    ///      as N independent verified inputs and needs no batch-aware decoding.
    /// @param inputs The encrypted inputs to verify (no per-input signature —
    ///        the batch is authenticated by the single `signature` argument).
    /// @param sender The account the inputs are bound to.
    /// @param signature The single ECDSA signature covering the whole batch.
    /// @return appendedHashes The metadata-appended ct hashes, in input order.
    function batchVerifyInputs(
        UnsignedEncryptedInput[] memory inputs,
        address sender,
        bytes memory signature
    ) external onlyAccessListed returns (uint256[] memory) {
        uint256 len = inputs.length;
        // When signer is set to 0 address we skip this logic to be able to support debug use cases.
        // In debug use cases we assume that the verifier is not necessarily running.
        if (verifierSigner != address(0)) {
            for (uint256 i = 0; i < len; i++) {
                int32 securityZone = int32(uint32(inputs[i].securityZone));
                if (!isValidSecurityZone(securityZone)) {
                    revert InvalidSecurityZone(securityZone, securityZoneMin, securityZoneMax);
                }
            }

            address signer = extractBatchSigner(inputs, sender, msg.sender, signature);
            if (signer != verifierSigner) {
                revert InvalidSigner(signer, verifierSigner);
            }
        }

        uint256[] memory appendedHashes = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            int32 securityZone = int32(uint32(inputs[i].securityZone));
            appendedHashes[i] =
                TMCommon.appendMetadata(inputs[i].ctHash, securityZone, inputs[i].utype, false);
            emit InputVerified(appendedHashes[i], bytes32(inputs[i].ctHash));
        }

        acl.batchAllowTransient(appendedHashes, msg.sender, address(this));

        return appendedHashes;
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

    function shareCtHash(uint256 ctHash, address receiver) external {
        acl.shareCtHash(ctHash, msg.sender, receiver);
    }

    function receiveCtHash(uint256 ctHash, address expectedSharer) external {
        acl.receiveCtHash(ctHash, expectedSharer, msg.sender);
    }

    function allowForDecryption(uint256 ctHash) external {
        uint256[] memory hashes = new uint256[](1);
        hashes[0] = ctHash;
        acl.allowForDecryption(hashes, msg.sender);
    }

    function isAllowed(uint256 ctHash, address account) external view returns (bool) {
        return acl.isAllowed(ctHash, account);
    }

    function isPubliclyAllowed(uint256 ctHash) external view returns (bool) {
        return acl.globalAllowed(ctHash);
    }

    /// @dev Per-input message hash folded into the batch digest:
    ///      keccak256(ctHash || utype || securityZone || sender || chainid || contractAddress).
    function inputMessageHash(
        uint256 ctHash,
        uint8 utype,
        uint8 securityZone,
        address sender,
        address contractAddress
    ) private view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                ctHash,
                utype,
                securityZone,
                sender,
                block.chainid,
                contractAddress
            )
        );
    }

    /// @dev Recover the signer of a batch from the single signature over
    ///      keccak256(h_0 || h_1 || ... || h_n), where each h_i is `inputMessageHash`.
    function extractBatchSigner(
        UnsignedEncryptedInput[] memory inputs,
        address sender,
        address contractAddress,
        bytes memory signature
    ) private view returns (address) {
        uint256 len = inputs.length;
        // One allocation of 32*len bytes, each hash written in place, so the
        // buffer is not reallocated and recopied once per input.
        bytes memory concatenatedHashes = new bytes(len * 32);
        for (uint256 i = 0; i < len; i++) {
            bytes32 h = inputMessageHash(inputs[i].ctHash, inputs[i].utype, inputs[i].securityZone, sender, contractAddress);
            assembly ("memory-safe") {
                mstore(add(add(concatenatedHashes, 32), mul(i, 32)), h)
            }
        }

        bytes32 batchHash = keccak256(concatenatedHashes);

        address signer = ECDSA.recover(batchHash, signature);
        if (signer == address(0)) {
            revert InvalidSignature();
        }

        return signer;
    }

    /// @notice Set the authorized signer for encrypted inputs
    /// @dev    Admin-equivalent. The holder can point this at a key it controls and forge
    ///         encrypted inputs; `address(0)` skips input verification entirely (debug mode,
    ///         see `verifyInput`). Grant only to whoever holds DEFAULT_ADMIN_ROLE.
    /// @param signer The new signer address (address(0) disables verification)
    function setVerifierSigner(address signer) external onlyRole(VERIFIER_SIGNER_MANAGER_ROLE) {
        address oldSigner = verifierSigner;
        verifierSigner = signer;
        emit VerifierSignerChanged(oldSigner, signer);
    }

    /// @notice Set the authorized signer for decrypt results
    /// @dev    Admin-equivalent. The holder can point this at a key it controls and forge
    ///         decrypt results; `address(0)` makes `_verifyDecryptResult` return true for every
    ///         signature, so any caller can publish arbitrary plaintext for any handle. Deploy
    ///         scripts refuse to set zero on non-local networks. Grant only to whoever holds
    ///         DEFAULT_ADMIN_ROLE.
    /// @param signer The new signer address (address(0) disables verification)
    function setDecryptResultSigner(address signer) external onlyRole(DECRYPT_SIGNER_MANAGER_ROLE) {
        address oldSigner = decryptResultSigner;
        decryptResultSigner = signer;
        emit DecryptResultSignerChanged(oldSigner, signer);
    }

    function setSecurityZoneMax(int32 securityZone) external onlyRole(SECURITY_ZONE_MANAGER_ROLE) {
        if (securityZone < securityZoneMin) {
            revert InvalidSecurityZone(securityZone, securityZoneMin, securityZoneMax);
        }
        securityZoneMax = securityZone;
    }

    function setSecurityZoneMin(int32 securityZone) external onlyRole(SECURITY_ZONE_MANAGER_ROLE) {
        if (securityZone > securityZoneMax) {
            revert InvalidSecurityZone(securityZone, securityZoneMin, securityZoneMax);
        }
        securityZoneMin = securityZone;
    }

    /// @notice Point the TaskManager at an ACL contract
    /// @dev    Admin-equivalent, not narrow config. Every confidentiality check funnels through
    ///         `acl.isAllowed*`, so an ACL whose `isAllowed` returns true grants unrestricted
    ///         access to every ciphertext - no implementation upgrade required. Grant
    ///         CONFIG_MANAGER_ROLE only to whoever holds DEFAULT_ADMIN_ROLE.
    /// @param _aclAddress The ACL contract address
    function setACLContract(address _aclAddress) external onlyRole(CONFIG_MANAGER_ROLE) {
        if (_aclAddress == address(0)) {
            revert InvalidAddress();
        }
        acl = ACL(_aclAddress);
    }

    /// @notice Point the TaskManager at a PlaintextsStorage contract
    /// @dev    Admin-equivalent, same reasoning as setACLContract: decrypt results are read back
    ///         from here, so a storage contract that returns attacker-chosen values yields
    ///         arbitrary plaintext for any handle.
    /// @param _plaintextsStorageAddress The PlaintextsStorage contract address
    function setPlaintextsStorage(address _plaintextsStorageAddress) external onlyRole(CONFIG_MANAGER_ROLE) {
        if (_plaintextsStorageAddress == address(0)) {
            revert InvalidAddress();
        }
        plaintextsStorage = PlaintextsStorage(_plaintextsStorageAddress);
    }

    /// @notice ACP scope-checked access, forwarded to the ACL.
    function isAllowedWithPermission(ACP memory acp, uint256 handle) public view returns (bool) {
        return acl.isAllowedWithPermission(acp, handle);
    }
}
