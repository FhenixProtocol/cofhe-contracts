// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlDefaultAdminRulesUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";
import {taskManagerAddress} from "./addresses/TaskManagerAddress.sol";
import {LegacyOwnable} from "./LegacyOwnable.sol";
import {PermissionedUpgradeable, ACP, SCOPE_GLOBAL, SCOPE_CONTRACT, SCOPE_HANDLES} from "./Permissioned.sol";

/**
 * @title  ACL
 * @notice The ACL (Access Control List) is a permission management system designed to
 *         control who can access, compute on, or decrypt encrypted values in cofhe.
 *         By defining and enforcing these permissions, the ACL ensures that encrypted data remains secure while still being usable
 *         within authorized contexts.
 */
contract ACL is UUPSUpgradeable, AccessControlDefaultAdminRulesUpgradeable, PermissionedUpgradeable {
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

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

    /// @notice Returned if the delegatee contract is already delegatee for sender & delegator addresses.
    error AlreadyDelegated();

    /// @notice Returned if the sender is the delegatee address.
    error SenderCannotBeDelegateeAddress();

    /// @notice         Returned if the sender address is not allowed for allow operations.
    /// @param sender   Sender address.
    error SenderNotAllowed(address sender);

    /// @notice         Returned if the user is trying to directly allow a handle (not via Task Manager).
    /// @param sender   Sender address.
    error DirectAllowForbidden(address sender);

    /// @notice         Returned when no share is pending at (handle, receiver).
    /// @param handle   Handle.
    /// @param receiver Address attempting to claim the share.
    error NotShared(uint256 handle, address receiver);

    /// @notice         Returned when the pending share was created by someone other than the
    ///                 party the receiver named.
    /// @param expected Sharer the receiver named.
    /// @param actual   Sharer that actually created the share.
    error UnexpectedSharer(address expected, address actual);

    /// @notice             Emitted when a list of handles is allowed for decryption.
    /// @param handlesList  List of handles allowed for decryption.
    event AllowedForDecryption(uint256[] handlesList);

    /// @notice                 Emitted when a new delegate address is added.
    /// @param sender           Sender address
    /// @param delegatee        Delegatee address.
    /// @param contractAddress  Contract address.
    event NewDelegation(address indexed sender, address indexed delegatee, address indexed contractAddress);

    /// @notice                 Emitted when the default revoker contract address is updated.
    /// @param oldAddress       Previous address.
    /// @param newAddress       New address (zero = unset).
    event DefaultRevokerContractUpdated(address oldAddress, address newAddress);

    /// @notice                 Emitted when the share registry address is updated.
    /// @param oldAddress       Previous address.
    /// @param newAddress       New address (zero = unset).
    event ShareRegistryUpdated(address oldAddress, address newAddress);

    /// @custom:storage-location erc7201:cofhe.storage.ACL
    struct ACLStorage {
        mapping(uint256 handle => bool isGlobal) globalHandles;
        mapping(uint256 handle => mapping(address account => bool isAllowed)) persistedAllowedPairs;
        mapping(uint256 => bool) allowedForDecryption;
        mapping(address account => mapping(address delegatee => mapping(address contractAddress => bool isDelegate))) delegates;
        // ACP infrastructure addresses served to SDKs (appended fields — do not reorder)
        address defaultRevokerContract;
        address shareRegistry;
    }

    /// @notice Name of the contract.
    string private constant CONTRACT_NAME = "ACL";

    /// @notice Major version of the contract.
    uint256 private constant MAJOR_VERSION = 0;

    /// @notice Minor version of the contract.
    uint256 private constant MINOR_VERSION = 1;

    /// @notice Patch version of the contract.
    uint256 private constant PATCH_VERSION = 0;

    /// @notice TaskManagerAddress address.
    address private constant TASK_MANAGER_ADDRESS = taskManagerAddress;

    /// @dev keccak256(abi.encode(uint256(keccak256("cofhe.storage.ACL")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ACL_SLOT = keccak256(abi.encode(uint256(keccak256("cofhe.storage.ACL")) - 1)) & ~bytes32(uint256(0xff));

    /// @dev Domain separator for share slots. Share keys are derived from a longer preimage than
    ///      transient allowance keys and carry this prefix, so the two key spaces cannot alias.
    bytes32 private constant SHARE_DOMAIN = keccak256("cofhe.acl.share");

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice              Initializes the contract.
     * @param initialAdmin  Initial admin address.
     * @param initialDelay  Initial delay for the default admin transfer.
     */
    function initialize(address initialAdmin, uint48 initialDelay) public initializer {
        __AccessControlDefaultAdminRules_init(initialDelay, initialAdmin);
        __PermissionedUpgradeable_init();
    }

    /// @dev Upgrade-only re-initializer for proxies migrating from the Ownable implementation.
    ///      Callable only by the owner the pre-roles implementation left behind - see
    ///      {LegacyOwnable} for why that is the only authority available in this window.
    ///      Grants UPGRADER_ROLE too: there is no upgrade task for this proxy, so a hand-rolled
    ///      migration with no follow-up grant would leave it permanently un-upgradeable.
    /// @param initialAdmin  Address receiving DEFAULT_ADMIN_ROLE and UPGRADER_ROLE.
    /// @param initialDelay  Delay enforced on subsequent default-admin transfers.
    /// @custom:oz-upgrades-validate-as-initializer
    function initializeV2(address initialAdmin, uint48 initialDelay) public reinitializer(2) {
        LegacyOwnable.requireLegacyOwner(msg.sender);
        __AccessControlDefaultAdminRules_init(initialDelay, initialAdmin);
        _grantRole(UPGRADER_ROLE, initialAdmin);
    }

    /**
     * @notice              Allows the use of `handle` for the address `account`.
     * @dev                 The caller must be allowed to use `handle` for allow() to succeed. If not, allow() reverts.
     * @param handle        Handle.
     * @param account       Address of the account being given permissions.
     * @param requester     Address of the account giving the permissions.
     */
    function allow(uint256 handle, address account, address requester) public virtual {
        if (msg.sender != TASK_MANAGER_ADDRESS) {
            revert DirectAllowForbidden(msg.sender);
        }

        if (!isAllowed(handle, requester)) {
            revert SenderNotAllowed(requester);
        }

        ACLStorage storage $ = _getACLStorage();
        $.persistedAllowedPairs[handle][account] = true;
    }

    /**
     * @notice              Allows the use of `handle` globally (all accounts).
     * @dev                 The caller must be allowed to use `handle` for allowGlobal() to succeed. If not, allowGlobal() reverts.
     * @param handle        Handle.
     * @param requester     Address of the account giving the permissions.
     */
    function allowGlobal(uint256 handle, address requester) public virtual {
        if (msg.sender != TASK_MANAGER_ADDRESS) {
            revert DirectAllowForbidden(msg.sender);
        }

        if (!isAllowed(handle, requester)) {
            revert SenderNotAllowed(requester);
        }

        ACLStorage storage $ = _getACLStorage();
      
        $.globalHandles[handle] = true;
    }

    /**
     * @notice              Allows a list of handles to be decrypted.
     * @param handlesList   List of handles.
     */
    function allowForDecryption(uint256[] memory handlesList, address requester) public virtual {
        if (msg.sender != TASK_MANAGER_ADDRESS) {
            revert DirectAllowForbidden(msg.sender);
        }

        uint256 len = handlesList.length;
        ACLStorage storage $ = _getACLStorage();

        for (uint256 k = 0; k < len; k++) {
            uint256 handle = handlesList[k];
            if (!isAllowed(handle, requester)) {
                revert SenderNotAllowed(requester);
            }
            $.allowedForDecryption[handle] = true;
        }
        emit AllowedForDecryption(handlesList);
    }

    /**
     * @notice              Allows the use of `handle` by address `account` for this transaction.
     * @dev                 The caller must be the Task Manager contract.
     * @dev                 The requester must be allowed to use `handle` for allowTransient() to succeed.
     *                      If not, allowTransient() reverts.
     * @param handle        Handle.
     * @param account       Address of the account.
     * @param requester     Address of the requester.
     */
    function allowTransient(uint256 handle, address account, address requester) public virtual {
        if (msg.sender != TASK_MANAGER_ADDRESS) {
            revert DirectAllowForbidden(msg.sender);
        }

        if (!isAllowed(handle, requester) && requester != TASK_MANAGER_ADDRESS) {
            revert SenderNotAllowed(requester);
        }

        _allowTransient(handle, account);
    }

    /**
     * @notice              Allows the use of every handle in `handles` by address `account` for this transaction.
     * @dev                 Batch form of allowTransient(), so a caller verifying many handles pays for one
     *                      call instead of one per handle.
     * @dev                 The caller must be the Task Manager contract.
     * @dev                 The requester must be allowed to use every handle for batchAllowTransient()
     *                      to succeed. If not, batchAllowTransient() reverts.
     * @param handles       List of handles.
     * @param account       Address of the account.
     * @param requester     Address of the requester.
     */
    function batchAllowTransient(uint256[] memory handles, address account, address requester) public virtual {
        if (msg.sender != TASK_MANAGER_ADDRESS) {
            revert DirectAllowForbidden(msg.sender);
        }

        // The Task Manager is exempt from the isAllowed() requirement (same as in
        // allowTransient()), so hoist the comparison and skip the lookup entirely.
        bool requesterIsTaskManager = requester == TASK_MANAGER_ADDRESS;
        uint256 len = handles.length;

        for (uint256 k = 0; k < len; k++) {
            uint256 handle = handles[k];
            if (!requesterIsTaskManager && !isAllowed(handle, requester)) {
                revert SenderNotAllowed(requester);
            }
            _allowTransient(handle, account);
        }
    }

    /**
     * @dev                 Marks `handle` usable by `account` for this transaction and appends the key to
     *                      the transient key list, whose length lives in transient slot 0.
     * @param handle        Handle.
     * @param account       Address of the account.
     */
    function _allowTransient(uint256 handle, address account) internal {
        _tstoreTracked(keccak256(abi.encodePacked(handle, account)), 1);
    }

    /**
     * @dev                 Writes `value` to transient slot `key` and appends `key` to the transient key
     *                      list, whose length lives in transient slot 0. Every transient write must go
     *                      through here so cleanTransientStorage() clears allowances and share slots
     *                      together. receiveCtHash() does not re-check the receiver's own grant, so it
     *                      relies on "a live share slot implies a live allowance for the receiver" —
     *                      which only holds while both ride the same cleanup path. Clearing one without
     *                      the other hands back an unusable handle, surfacing later as an opaque
     *                      ACLNotAllowed rather than a share-related error.
     * @param key           Transient slot to write.
     * @param value         Value to store.
     */
    function _tstoreTracked(bytes32 key, uint256 value) private {
        assembly {
            tstore(key, value)
            let length := tload(0)
            let lengthPlusOne := add(length, 1)
            tstore(lengthPlusOne, key)
            tstore(0, lengthPlusOne)
        }
    }

    /**
     * @dev                 Transient slot holding the sharer of a share directed at `receiver`.
     * @param handle        Handle.
     * @param receiver      Address the share is directed at.
     */
    function _shareKey(uint256 handle, address receiver) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(SHARE_DOMAIN, handle, receiver));
    }

    /**
     * @notice              Grants `receiver` transient access to `handle` and records `sharer` as the
     *                      party handing it over, for the duration of this transaction.
     * @dev                 The caller must be the Task Manager contract.
     * @dev                 Stricter than allowTransient(): there is no TASK_MANAGER_ADDRESS bypass.
     *                      Nothing shares on the Task Manager's own behalf, so the sharer must
     *                      genuinely hold the handle.
     * @param handle        Handle.
     * @param sharer        Address handing the handle over.
     * @param receiver      Address the handle is being handed to.
     */
    function shareCtHash(uint256 handle, address sharer, address receiver) public virtual {
        if (msg.sender != TASK_MANAGER_ADDRESS) {
            revert DirectAllowForbidden(msg.sender);
        }

        if (!isAllowed(handle, sharer)) {
            revert SenderNotAllowed(sharer);
        }

        // Capability, then provenance. `sharer` is a clean uint160 cast, so the tload in
        // receiveCtHash() needs no masking.
        _allowTransient(handle, receiver);
        _tstoreTracked(_shareKey(handle, receiver), uint256(uint160(sharer)));
    }

    /**
     * @notice                  Consumes the share directed at `receiver` for `handle`.
     * @dev                     The caller must be the Task Manager contract.
     * @dev                     The slot is cleared before the checks run. A reverting claim rolls the
     *                          clear back with its own frame, so a failed claim leaves the share
     *                          available to its intended receiver.
     * @param handle            Handle.
     * @param expectedSharer    Sharer the receiver names. Required, so a share cannot be consumed
     *                          without naming who it came from.
     * @param receiver          Address claiming the share.
     */
    function receiveCtHash(uint256 handle, address expectedSharer, address receiver) public virtual {
        if (msg.sender != TASK_MANAGER_ADDRESS) {
            revert DirectAllowForbidden(msg.sender);
        }

        bytes32 shareKey = _shareKey(handle, receiver);
        address sharer;
        assembly {
            sharer := tload(shareKey)
            tstore(shareKey, 0)
        }

        if (sharer == address(0)) {
            revert NotShared(handle, receiver);
        }

        if (sharer != expectedSharer) {
            revert UnexpectedSharer(expectedSharer, sharer);
        }

        // Unreachable today — a live slot implies a live sharer grant, since allowances are never
        // revoked and cleanTransientStorage() drops slots and allowances together, so NotShared fires
        // first. Kept so decoupling those cannot silently return provenance without real access.
        if (!isAllowed(handle, sharer)) {
            revert SenderNotAllowed(sharer);
        }
    }

    /**
     * @notice                  Delegates the access of `handles` in the context of account abstraction for issuing
     *                          reencryption requests from a smart contract account.
     * @param delegatee         Delegatee address.
     * @param delegateeContract Delegatee contract.
     */
    function delegateAccount(address delegatee, address delegateeContract) public virtual {
         if (msg.sender != TASK_MANAGER_ADDRESS) {
            revert DirectAllowForbidden(msg.sender);
        }
        if (delegateeContract == msg.sender) {
            revert SenderCannotBeDelegateeAddress();
        }

        ACLStorage storage $ = _getACLStorage();
        if ($.delegates[msg.sender][delegatee][delegateeContract]) {
            revert AlreadyDelegated();
        }

        $.delegates[msg.sender][delegatee][delegateeContract] = true;
        emit NewDelegation(msg.sender, delegatee, delegateeContract);
    }

    /**
     * @notice                  Returns whether the delegatee is allowed to access the handle.
     * @param delegatee         Delegatee address.
     * @param handle            Handle.
     * @param contractAddress   Contract address.
     * @param account           Address of the account.
     * @return isAllowed        Whether the handle can be accessed.
     */
    function allowedOnBehalf(
        address delegatee,
        uint256 handle,
        address contractAddress,
        address account
    ) public view virtual returns (bool) {
        ACLStorage storage $ = _getACLStorage();
        return
            $.persistedAllowedPairs[handle][account] &&
            $.persistedAllowedPairs[handle][contractAddress] &&
            $.delegates[account][delegatee][contractAddress];
    }

    /**
     * @notice                      Checks whether the account is allowed to use the handle in the
     *                              same transaction (transient).
     * @param handle                Handle.
     * @param account               Address of the account.
     * @return isAllowedTransient   Whether the account can access transiently the handle.
     */
    function allowedTransient(uint256 handle, address account) public view virtual returns (bool) {
        bool isAllowedTransient;
        bytes32 key = keccak256(abi.encodePacked(handle, account));
        assembly {
            isAllowedTransient := tload(key)
        }
        return isAllowedTransient;
    }

    /**
     * @notice                     Getter function for the TaskManager contract address.
     * @return taskManagerAddress  Address of the TaskManager.
     */
    function getTaskManagerAddress() public view virtual returns (address) {
        return TASK_MANAGER_ADDRESS;
    }

    /**
     * @notice              Returns whether the account is allowed to use the `handle`, either due to
     *                      allowTransient() or allow().
     * @param handle        Handle.
     * @param account       Address of the account.
     * @return isAllowed    Whether the account can access the handle.
     */
    function isAllowed(uint256 handle, address account) public view virtual returns (bool) {
        return allowedTransient(handle, account) || persistAllowed(handle, account) || globalAllowed(handle);
    }

    /**
     * @notice              Checks whether a handle is allowed for decryption.
     * @param handle        Handle.
     * @return isAllowed    Whether the handle is allowed for decryption.
     */
    function isAllowedForDecryption(uint256 handle) public view virtual returns (bool) {
        ACLStorage storage $ = _getACLStorage();
        return $.allowedForDecryption[handle];
    }

    /**
     * @notice              Returns `true` if address `a` is allowed to use `c` and `false` otherwise.
     * @param handle        Handle.
     * @param account       Address of the account.
     * @return isAllowed    Whether the account can access the handle.
     */
    function persistAllowed(uint256 handle, address account) public view virtual returns (bool) {
        ACLStorage storage $ = _getACLStorage();
        return $.persistedAllowedPairs[handle][account];
    }

    /**
     * @notice              Returns `true` if the handle is allowed globally.
     * @param handle        Handle.
     * @return isAllowed    Whether the handle is allowed globally.
     */
    function globalAllowed(uint256 handle) public view virtual returns (bool) {
        ACLStorage storage $ = _getACLStorage();
        return $.globalHandles[handle];
    }

    /**
     * @dev This function removes the transient allowances, which could be useful for integration with
     *      Account Abstraction when bundling several UserOps calling the TaskManagerCoprocessor.
     */
    function cleanTransientStorage() external virtual {
        if (msg.sender != TASK_MANAGER_ADDRESS) {
            revert DirectAllowForbidden(msg.sender);
        }

        assembly {
            let length := tload(0)
            tstore(0, 0)
            let lengthPlusOne := add(length, 1)
            for {
                let i := 1
            } lt(i, lengthPlusOne) {
                i := add(i, 1)
            } {
                let handle := tload(i)
                tstore(i, 0)
                tstore(handle, 0)
            }
        }
    }

    /**
     * @notice        Getter for the name and version of the contract.
     * @return string Name and the version of the contract.
     */
    function getVersion() external pure virtual returns (string memory) {
        return
            string(
                abi.encodePacked(
                    CONTRACT_NAME,
                    " v",
                    Strings.toString(MAJOR_VERSION),
                    ".",
                    Strings.toString(MINOR_VERSION),
                    ".",
                    Strings.toString(PATCH_VERSION)
                )
            );
    }

    /**
     * @dev Should revert when `msg.sender` is not authorized to upgrade the contract.
     *      Empty implementation since authorization is handled by onlyRole(UPGRADER_ROLE) modifier.
     */
    /* solhint-disable-next-line no-empty-blocks */
    function _authorizeUpgrade(address _newImplementation) internal virtual override onlyRole(UPGRADER_ROLE) {}

    /**
     * @dev                         Returns the ACL storage location.
     */
    function _getACLStorage() internal pure returns (ACLStorage storage $) {
        bytes32 slot = ACL_SLOT;
        assembly {
            $.slot := slot
        }
    }

    // ---------------------------------------------------------------------------
    // ACP (Permit V3) — scope-checked access
    // ---------------------------------------------------------------------------
    //
    // Structure validity (expiration / signatures / revocation) and the EIP-712
    // domain live on this contract, inherited from PermissionedUpgradeable —
    // `withPermission` and `checkPermissionValidity` are the entry points.

    /// @notice         Default revoker contract for newly created ACPs, served to SDKs.
    /// @return address The default revoker contract address (zero = unset).
    function defaultRevokerContract() public view virtual returns (address) {
        return _getACLStorage().defaultRevokerContract;
    }

    /// @notice         The ACPShareRegistry address, served to SDKs.
    /// @return address The share registry address (zero = sharing not available on this chain).
    function shareRegistry() public view virtual returns (address) {
        return _getACLStorage().shareRegistry;
    }

    /// @notice             Sets the default revoker contract address.
    /// @param newAddress   The new address (zero = unset).
    function setDefaultRevokerContract(address newAddress) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        ACLStorage storage $ = _getACLStorage();
        emit DefaultRevokerContractUpdated($.defaultRevokerContract, newAddress);
        $.defaultRevokerContract = newAddress;
    }

    /// @notice             Sets the share registry address.
    /// @param newAddress   The new address (zero = unset).
    function setShareRegistry(address newAddress) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        ACLStorage storage $ = _getACLStorage();
        emit ShareRegistryUpdated($.shareRegistry, newAddress);
        $.shareRegistry = newAddress;
    }

    /// @notice ACP access check — the scope table.
    ///
    ///         | condition                                          | result |
    ///         |----------------------------------------------------|--------|
    ///         | permission structure invalid (expired/sig/revoked) | REVERT |
    ///         | issuer does NOT have access to handle              | false  |
    ///         | scope == SCOPE_GLOBAL                              | true   |
    ///         | scope == SCOPE_CONTRACT, a contract may read handle| true   |
    ///         | scope == SCOPE_HANDLES, handles contains handle    | true   |
    ///         | otherwise                                          | false  |
    ///
    /// @dev Scopes narrow the issuer's existing access, never widen it.
    ///      Contract scope intersects the EXISTING allowances
    ///      (populated via FHE.allow/allowThis) — no new data structures.
    function isAllowedWithPermission(ACP memory acp, uint256 handle) public view withPermission(acp) returns (bool) {
        // Scopes narrow the issuer's existing access, never widen it
        if (!isAllowed(handle, acp.issuer)) return false;

        if (acp.scope == SCOPE_GLOBAL) return true;

        if (acp.scope == SCOPE_CONTRACT) {
            for (uint256 i = 0; i < acp.contracts.length; i++) {
                if (isAllowed(handle, acp.contracts[i])) return true;
            }
            return false;
        }

        if (acp.scope == SCOPE_HANDLES) {
            for (uint256 i = 0; i < acp.handles.length; i++) {
                if (acp.handles[i] == bytes32(handle)) return true;
            }
            return false;
        }

        return false;
    }
}
