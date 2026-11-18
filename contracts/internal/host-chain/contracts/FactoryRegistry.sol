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
 * again, and an unregister never reads more than MAX_TREE_SIZE contracts.
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
    /// @inheritdoc IFactoryRegistry
    /// @dev Sized so that unregistering a full tree stays well under Ethereum's 2^24 per-transaction
    ///      gas cap (EIP-7825): about 10.3M gas measured for 500 flat, 11.4M for the worst shape
    ///      (62 chains of depth 8). See test/foundry.
    uint256 public constant MAX_TREE_SIZE = 500;

    /// @notice A factory was approved as the root of a new tree.
    event FactoryApproved(address indexed factory);
    /// @notice The registry now writes to `current` instead of `previous`.
    event TaskManagerSet(address indexed previous, address indexed current);

    /// @dev 27 bytes, one storage slot.
    struct Node {
        address parent; // zero: not registered; this registry: an approved factory (a root)
        uint8 depth; // levels below the root
        uint32 index; // position in the parent's child list, for swap-and-pop
        uint16 treeSize; // live contracts below a root; unused on other nodes
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
        _checkNewNode(factory);
        _s().nodes[factory] = Node({parent: address(this), depth: 0, index: 0, treeSize: 0});
        emit FactoryApproved(factory);

        address[] memory one = new address[](1);
        one[0] = factory;
        _s().taskManager.addToAccessList(one);
    }

    /// @inheritdoc IFactoryRegistry
    function register(address[] calldata children) external {
        RegistryStorage storage $ = _s();
        Node memory caller = $.nodes[msg.sender];
        if (caller.parent == address(0)) revert NotRegistered();
        if (caller.depth >= MAX_DEPTH) revert MaxDepthExceeded();

        address root = _rootOf(msg.sender);
        Node storage rootNode = $.nodes[root];
        uint256 size = rootNode.treeSize + children.length;
        if (size > MAX_TREE_SIZE) revert TreeFull();
        rootNode.treeSize = uint16(size);

        address[] storage list = $.childrenOf[msg.sender];
        uint8 depth = caller.depth + 1;
        for (uint256 i = 0; i < children.length; i++) {
            address child = children[i];
            _checkNewNode(child);
            $.nodes[child] = Node({parent: msg.sender, depth: depth, index: uint32(list.length), treeSize: 0});
            list.push(child);
            emit Registered(child, msg.sender, root);
        }
        $.taskManager.addToAccessList(children);
    }

    /// @inheritdoc IFactoryRegistry
    function unregister(address target) external {
        RegistryStorage storage $ = _s();
        Node memory t = $.nodes[target];
        if (t.parent == address(0)) revert NotRegistered();
        _checkCaller(target, t.parent);

        bool isRoot = t.parent == address(this);
        address root = isRoot ? target : _rootOf(t.parent);
        // A subtree is never larger than its root's live count, so no counting pass is needed.
        address[] memory removed = new address[](isRoot ? uint256(t.treeSize) + 1 : $.nodes[root].treeSize);

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

    /// @dev Shared by approval and registration, so a root gets the same protection as a child.
    function _checkNewNode(address account) private view {
        // The registry is every root's parent: as a node, its own ancestors would rank above every tree.
        if (account == address(0) || account == address(this)) revert InvalidChild();
        RegistryStorage storage $ = _s();
        if ($.nodes[account].parent != address(0)) revert AlreadyRegistered();
        // Entries Fhenix added by hand stay Fhenix's: a tree must never be able to remove them.
        if (IAccessListView(address($.taskManager)).accessList(account)) revert AlreadyOnAccessList();
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
