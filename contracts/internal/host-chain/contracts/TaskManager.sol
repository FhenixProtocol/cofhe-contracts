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
import {TaskManagerLib} from "./TaskManagerLib.sol";
import {ITaskManager, FunctionId, Utils, UnsignedEncryptedInput} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";
import {ITaskManagerErrors, ITaskManagerEvents, TMCommon} from "./TaskManagerTypes.sol";


// Declared but not used; kept outside ITaskManagerErrors so the ABI stays as before the library.
error InvalidBytesLength(uint256 got, uint256 expected);
error OnlyOwnerAllowed(address caller);

contract TaskManager is ITaskManager, ITaskManagerErrors, ITaskManagerEvents, Initializable, UUPSUpgradeable, AccessControlDefaultAdminRulesUpgradeable {
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
    // case is availability (halting intake, or gating it to an allow or deny list), not disclosure.
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
        _setSecurityZones(minSZ, maxSZ);
    }

    /// @dev The single write path for the security zone bounds. Rejecting an inverted range here
    ///      is what stops `setSecurityZones(10, 5)` from looking like an ordinary admin change
    ///      while silently reverting every task intake that follows.
    function _setSecurityZones(int32 newMin, int32 newMax) private {
        if (newMin > newMax) {
            revert InvalidSecurityZone(newMin, newMin, newMax);
        }
        emit SecurityZonesChanged(securityZoneMin, securityZoneMax, newMin, newMax);
        securityZoneMin = newMin;
        securityZoneMax = newMax;
    }

    function isInitialized() public view returns (bool) {
        return initialized;
    }

    function getVersion() public view returns (uint8) {
        return version;
    }

    function incVersion() public onlyRole(UPGRADER_ROLE) {
        version++;
        emit VersionIncremented(version);
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    // Errors
    // Returned when the handle is not allowed in the ACL for the account.
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

    // Callers blocked from task intake while the access list is disabled. Ignored when it is enabled.
    mapping(address account => bool isDenied) public denyList;

    modifier onlyIfEnabled() {
        if (!isEnabled) {
            revert CofheIsUnavailable();
        }
        _;
    }

    // Gates task intake to allowlisted callers when the access list is enabled,
    // otherwise blocks deny-listed callers.
    modifier onlyAccessListed() {
        _checkAccessList();
        _;
    }

    function _checkAccessList() private view {
        if (accessListEnabled) {
            if (!accessList[msg.sender]) {
                revert NotOnAccessList(msg.sender);
            }
        } else if (denyList[msg.sender]) {
            revert OnDenyList(msg.sender);
        }
    }

    function enable() external onlyRole(PAUSER_ROLE) {
        isEnabled = true;
        emit EnabledSet(true);
    }

    function disable() external onlyRole(PAUSER_ROLE) {
        isEnabled = false;
        emit EnabledSet(false);
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

    function setDenyList(address[] calldata accounts, bool denied) external onlyRole(ACCESS_LIST_MANAGER_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            if (accounts[i] == address(0)) {
                revert InvalidAddress();
            }
            denyList[accounts[i]] = denied;
            emit DenyListSet(accounts[i], denied);
        }
    }

    function createRandomTask(uint8 returnType, uint256 seed, int32 securityZone) external onlyIfEnabled onlyAccessListed returns (uint256) {
        // The seed stays here: it increments randomCounter, a storage value the library cannot reach.
        if (seed == 0) {
            seed = _generateSeed(securityZone);
        }
        return TaskManagerLib.createRandomTask(returnType, seed, securityZone, acl, securityZoneMin, securityZoneMax);
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

    function createTask(uint8 returnType, FunctionId funcId, uint256[] calldata encryptedHashes, uint256[] calldata extraInputs) external onlyAccessListed returns (uint256) {
        return TaskManagerLib.createTask(returnType, funcId, encryptedHashes, extraInputs, acl, securityZoneMin, securityZoneMax, isEnabled);
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

    function _verifyDecryptResult(
        uint256 ctHash,
        uint256 result,
        bytes calldata signature,
        bool shouldRevert
    ) private view returns (bool) {
        return TaskManagerLib._verifyDecryptResult(ctHash, result, signature, shouldRevert, decryptResultSigner);
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
        UnsignedEncryptedInput[] calldata inputs,
        address sender,
        bytes calldata signature
    ) external onlyAccessListed returns (uint256[] memory) {
        return TaskManagerLib.batchVerifyInputs(inputs, sender, signature, verifierSigner, securityZoneMin, securityZoneMax, acl);
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
        _setSecurityZones(securityZoneMin, securityZone);
    }

    function setSecurityZoneMin(int32 securityZone) external onlyRole(SECURITY_ZONE_MANAGER_ROLE) {
        _setSecurityZones(securityZone, securityZoneMax);
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
        emit ACLContractChanged(address(acl), _aclAddress);
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
        emit PlaintextsStorageChanged(address(plaintextsStorage), _plaintextsStorageAddress);
        plaintextsStorage = PlaintextsStorage(_plaintextsStorageAddress);
    }

    /// @notice ACP scope-checked access, forwarded to the ACL.
    function isAllowedWithPermission(ACP memory acp, uint256 handle) public view returns (bool) {
        return acl.isAllowedWithPermission(acp, handle);
    }
}
