// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlDefaultAdminRulesUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";
import {COFHE_ADDRESS_BOOK, TASK_MANAGER_ID} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {ICoFHEAddressBook, ITaskManager} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";
import {IFactoryRegistry} from "@fhenixprotocol/cofhe-contracts/IFactoryRegistry.sol";

/// @dev ITaskManager declares the list writers but not the public `accessList` getter.
interface IAccessListView {
    function accessList(address account) external view returns (bool);
}

/**
 * @notice Lets approved factories put the contracts they deploy on the TaskManager access list.
 *
 * The registry holds the TaskManager's ACCESS_LIST_MANAGER_ROLE and is its only writer for
 * registered contracts; the TaskManager itself is unchanged and keeps checking its flat list. The
 * registry keeps the tree behind that list: each contract's parent, and each contract's direct
 * children. Both lists stay exact (removal is swap-and-pop), so a root's live count can go down
 * again. A tree too large to unregister in one transaction is cut off with suspend instead.
 *
 * Roles, rated by worst case, as in the TaskManager:
 *   DEFAULT_ADMIN_ROLE     everything; changes only through a delayed two-step transfer.
 *   UPGRADER_ROLE          arbitrary implementation, so admin-equivalent.
 *   FACTORY_APPROVER_ROLE  gives a factory, and everything below it, FHE access: admin-equivalent
 *                          for the access gate.
 *   REVOKER_ROLE           removes access, never grants it: availability only, so it may also sit
 *                          on an operational key.
 */
contract FactoryRegistry is IFactoryRegistry, UUPSUpgradeable, AccessControlDefaultAdminRulesUpgradeable {
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant FACTORY_APPROVER_ROLE = keccak256("FACTORY_APPROVER_ROLE");
    bytes32 public constant REVOKER_ROLE = keccak256("REVOKER_ROLE");

    /// @inheritdoc IFactoryRegistry
    uint256 public constant MAX_DEPTH = 8;

    /// @notice A factory was approved as the root of a new tree.
    event FactoryApproved(address indexed factory);
    /// @notice The registry now writes to `current` instead of `previous`.
    event TaskManagerSet(address indexed previous, address indexed current);
    /// @notice `factory`'s tree can register nothing until resume.
    event FactorySuspended(address indexed factory, address indexed caller);
    /// @notice `factory`'s tree can register again. Its contracts get access back only when re-listed.
    event FactoryResumed(address indexed factory, address indexed caller);

    /// @notice adopt() or adoptFactories() got an address that is not on the TaskManager list.
    error MustBeOnAccessList();
    /// @notice suspend() got an address that is not the given factory or below it.
    error NotUnderFactory();

    /// @dev 28 bytes, one storage slot.
    struct Node {
        address parent; // zero: not registered; this registry: an approved factory (a root)
        uint8 depth; // levels below the root
        uint32 index; // position in the parent's child list, for swap-and-pop
        uint16 treeSize; // live contracts below a root; unused on other nodes
        bool suspended; // on a root: its tree can register nothing; unused on other nodes
    }

    /// @custom:storage-location erc7201:cofhe.storage.FactoryRegistry
    struct RegistryStorage {
        mapping(address => Node) nodes;
        mapping(address => address[]) childrenOf;
        ITaskManager taskManager;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("cofhe.storage.FactoryRegistry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REGISTRY_SLOT = 0xa14bafdf5c2c5943ba3887932aad2dcb76fb2dff21a26e6897a0bc07379eba00;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Gives every role to `admin` and binds the TaskManager that FHE.sol uses.
    function initialize(address admin, uint48 initialDelay) external initializer {
        __AccessControlDefaultAdminRules_init(initialDelay, admin);
        __UUPSUpgradeable_init();
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(FACTORY_APPROVER_ROLE, admin);
        _grantRole(REVOKER_ROLE, admin);
        _setTaskManager(TASK_MANAGER_ID);
    }

    /// @notice Points the registry at the TaskManager the address book lists under `id`.
    /// @dev    Entries already written stay on the previous TaskManager; nothing is moved.
    function setTaskManager(uint256 id) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTaskManager(id);
    }

    /// @notice Makes `factory` the root of a new tree and gives it FHE access.
    function approveFactory(address factory) external onlyRole(FACTORY_APPROVER_ROLE) {
        _makeRoot(factory, false);
        address[] memory one = new address[](1);
        one[0] = factory;
        _s().taskManager.addToAccessList(one);
    }

    /// @notice Makes addresses that are already on the TaskManager list approved factories (roots).
    ///         The list does not change, so they keep FHE access without a gap.
    /// @dev    For migrating factories added by hand. Approve only factories you would approve with
    ///         approveFactory: a root can register contracts.
    function adoptFactories(address[] calldata factories) external onlyRole(FACTORY_APPROVER_ROLE) {
        for (uint256 i = 0; i < factories.length; i++) _makeRoot(factories[i], true);
    }

    /// @notice Moves addresses that are already on the TaskManager list below `parent`. The list does
    ///         not change, so they keep FHE access without a gap.
    /// @dev    For migrating contracts added by hand. Adopted addresses become removable by everything
    ///         above them, so check off-chain that they belong to that tree before adopting them. They
    ///         can also register children, like any node.
    function adopt(address parent, address[] calldata accounts) external onlyRole(FACTORY_APPROVER_ROLE) {
        _attach(parent, accounts, true);
    }

    /// @inheritdoc IFactoryRegistry
    function register(address[] calldata children) external {
        _attach(msg.sender, children, false);
        _s().taskManager.addToAccessList(children);
    }

    /// @inheritdoc IFactoryRegistry
    function unregister(address target) external {
        RegistryStorage storage $ = _s();
        Node memory t = $.nodes[target];
        if (t.parent == address(0)) revert NotRegistered();
        _checkCaller(target, t.parent);

        bool isRoot = t.parent == address(this);
        address root = isRoot ? target : _rootOf(t.parent);
        // Memory cost grows with the square of the array size, so a branch is counted first rather than
        // sized by its whole tree. The count's reads make the collect pass's reads warm.
        address[] memory removed = new address[](isRoot ? uint256(t.treeSize) + 1 : _count(target));

        if (!isRoot) _removeFromParent(t.parent, t.index);
        uint256 count = _collect(target, removed, 0);
        // slither-disable-next-line assembly
        assembly {
            mstore(removed, count)
        }
        if (!isRoot) $.nodes[root].treeSize -= uint16(count);

        $.taskManager.removeFromAccessList(removed);
        emit Unregistered(target, msg.sender, count);
    }

    /// @notice Stops `factory`'s tree from registering and takes `accounts` off the TaskManager list.
    ///         Their registry entries stay, so a resume plus re-listing restores the tree as it was.
    /// @dev    For a tree too large to unregister in one transaction: the first call closes
    ///         registration, and later calls take the rest off the list in batches. `accounts` may
    ///         include the factory itself.
    function suspend(address factory, address[] calldata accounts) external onlyRole(REVOKER_ROLE) {
        RegistryStorage storage $ = _s();
        Node storage f = $.nodes[factory];
        if (f.parent != address(this)) revert NotRegistered();
        if (!f.suspended) {
            f.suspended = true;
            emit FactorySuspended(factory, msg.sender);
        }
        for (uint256 i = 0; i < accounts.length; i++) {
            // Keeps a revoker key to the trees: entries Fhenix listed by hand are not its to remove.
            if (_rootOf(accounts[i]) != factory) revert NotUnderFactory();
        }
        $.taskManager.removeFromAccessList(accounts);
    }

    /// @notice Lets `factory`'s tree register again. Suspended contracts stay off the list until
    ///         Fhenix adds them back.
    /// @dev    FACTORY_APPROVER_ROLE, not REVOKER_ROLE: reopening gives power back.
    function resume(address factory) external onlyRole(FACTORY_APPROVER_ROLE) {
        Node storage f = _s().nodes[factory];
        if (f.parent != address(this)) revert NotRegistered();
        f.suspended = false;
        emit FactoryResumed(factory, msg.sender);
    }

    /// @inheritdoc IFactoryRegistry
    function isSuspended(address factory) external view returns (bool) {
        return _s().nodes[factory].suspended;
    }

    /// @notice The number of contracts registered directly below `node`.
    function childCount(address node) external view returns (uint256) {
        return _s().childrenOf[node].length;
    }

    /// @notice Up to `count` of `node`'s direct children, from position `start`. Paged, so off-chain
    ///         tooling can walk a tree of any size within an RPC's eth_call gas limit.
    function childrenOf(address node, uint256 start, uint256 count) external view returns (address[] memory page) {
        address[] storage list = _s().childrenOf[node];
        uint256 end = list.length;
        if (start >= end) return page;
        if (count < end - start) end = start + count;
        page = new address[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = list[i];
    }

    /// @inheritdoc IFactoryRegistry
    function nodeOf(address account) external view returns (address parent, uint8 depth) {
        Node memory n = _s().nodes[account];
        return (n.parent, n.depth);
    }

    /// @inheritdoc IFactoryRegistry
    function treeSizeOf(address root) external view returns (uint256) {
        return _s().nodes[root].treeSize;
    }

    /// @notice The TaskManager this registry writes to.
    function taskManager() external view returns (ITaskManager) {
        return _s().taskManager;
    }

    function _setTaskManager(uint256 id) private {
        RegistryStorage storage $ = _s();
        address previous = address($.taskManager);
        $.taskManager = ITaskManager(ICoFHEAddressBook(COFHE_ADDRESS_BOOK).getTm(id));
        emit TaskManagerSet(previous, address($.taskManager));
    }

    function _makeRoot(address account, bool listed) private {
        _checkNewNode(account, listed);
        _s().nodes[account] = Node({parent: address(this), depth: 0, index: 0, treeSize: 0, suspended: false});
        emit FactoryApproved(account);
    }

    /// @dev Writes `children` below `parent` without touching the TaskManager list.
    function _attach(address parent, address[] calldata children, bool listed) private {
        RegistryStorage storage $ = _s();
        Node memory p = $.nodes[parent];
        if (p.parent == address(0)) revert NotRegistered();
        if (p.depth >= MAX_DEPTH) revert MaxDepthExceeded();
        // A node taken off the list (by hand, or after setTaskManager) must not give access to others.
        if (!listed && !IAccessListView(address($.taskManager)).accessList(parent)) revert CallerNotOnAccessList();

        address root = _rootOf(parent);
        Node storage rootNode = $.nodes[root];
        if (rootNode.suspended) revert FactoryIsSuspended();
        uint256 size = rootNode.treeSize + children.length;
        // The only size limit: treeSize must not wrap.
        if (size > type(uint16).max) revert TreeFull();
        rootNode.treeSize = uint16(size);

        address[] storage list = $.childrenOf[parent];
        uint8 depth = p.depth + 1;
        for (uint256 i = 0; i < children.length; i++) {
            address child = children[i];
            _checkNewNode(child, listed);
            $.nodes[child] = Node({parent: parent, depth: depth, index: uint32(list.length), treeSize: 0, suspended: false});
            list.push(child);
            emit Registered(child, parent, root);
        }
    }

    /// @dev Shared by approval, registration and adoption, so a root gets the same protection as a child.
    ///      `listed` says whether the account must already be on the TaskManager list (adoption) or
    ///      must not be (everything else).
    function _checkNewNode(address account, bool listed) private view {
        // The registry is every root's parent: as a node, its own ancestors would rank above every tree.
        if (account == address(0) || account == address(this)) revert InvalidChild();
        RegistryStorage storage $ = _s();
        if ($.nodes[account].parent != address(0)) revert AlreadyRegistered();
        bool onList = IAccessListView(address($.taskManager)).accessList(account);
        // Entries Fhenix added by hand stay Fhenix's: only Fhenix can move them into a tree, by adoption.
        if (onList && !listed) revert AlreadyOnAccessList();
        if (!onList && listed) revert MustBeOnAccessList();
    }

    function _checkCaller(address target, address parent) private view {
        if (msg.sender == target || hasRole(REVOKER_ROLE, msg.sender)) return;
        RegistryStorage storage $ = _s();
        address a = parent;
        // The walk ends at the registry, which no caller can be.
        for (uint256 i = 0; i <= MAX_DEPTH && a != address(this); i++) {
            if (a == msg.sender) return;
            a = $.nodes[a].parent;
        }
        revert NotAllowed();
    }

    function _rootOf(address account) private view returns (address) {
        RegistryStorage storage $ = _s();
        for (uint256 i = 0; i <= MAX_DEPTH; i++) {
            address parent = $.nodes[account].parent;
            if (parent == address(this)) return account;
            account = parent;
        }
        revert NotRegistered();
    }

    function _removeFromParent(address parent, uint32 index) private {
        RegistryStorage storage $ = _s();
        address[] storage list = $.childrenOf[parent];
        uint256 last = list.length - 1;
        if (index != last) {
            address moved = list[last];
            list[index] = moved;
            $.nodes[moved].index = index;
        }
        list.pop();
    }

    function _count(address node) private view returns (uint256 n) {
        address[] storage kids = _s().childrenOf[node];
        n = 1;
        for (uint256 i = 0; i < kids.length; i++) n += _count(kids[i]);
    }

    /// @dev Deletes the lists of every removed contract, so an address registered again later
    ///      starts with an empty list and no old entries can reach another tree's walk.
    function _collect(address node, address[] memory out, uint256 n) private returns (uint256) {
        RegistryStorage storage $ = _s();
        out[n++] = node;
        address[] storage kids = $.childrenOf[node];
        for (uint256 i = 0; i < kids.length; i++) {
            n = _collect(kids[i], out, n);
        }
        delete $.childrenOf[node];
        delete $.nodes[node];
        return n;
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    function _s() private pure returns (RegistryStorage storage $) {
        bytes32 slot = REGISTRY_SLOT;
        // slither-disable-next-line assembly
        assembly {
            $.slot := slot
        }
    }
}
