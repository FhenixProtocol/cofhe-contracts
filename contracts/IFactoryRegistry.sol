// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.25 <0.9.0;

/**
 * @notice The part of the FactoryRegistry that partner contracts call.
 *
 * CoFHE accepts tasks only from contracts on its access list. An approved factory registers the
 * contracts it deploys here, and the registry adds them to that list. A registered contract can
 * register its own contracts, so the registered contracts form a tree below each approved factory.
 */
interface IFactoryRegistry {
    /// @notice A contract was registered under `parent`, in the tree of the approved factory `root`.
    event Registered(address indexed child, address indexed parent, address indexed root);

    /// @notice `target` and the `count - 1` contracts below it were removed by `caller`.
    event Unregistered(address indexed target, address indexed caller, uint256 count);

    /// @notice The caller, or the target, is not registered.
    error NotRegistered();
    /// @notice The caller is registered but not on the CoFHE access list, so it cannot give access to others.
    error CallerNotOnAccessList();
    /// @notice The child is the zero address or the registry itself.
    error InvalidChild();
    /// @notice The child already has a parent.
    error AlreadyRegistered();
    /// @notice The child is already on the CoFHE access list, for example added by Fhenix by hand.
    ///         To register it under the FactoryRegistry, ask Fhenix to adopt it.
    error AlreadyOnAccessList();
    /// @notice The child would sit more than `MAX_DEPTH` levels below its approved factory.
    error MaxDepthExceeded();
    /// @notice The approved factory's tree would hold more than `MAX_TREE_SIZE` live contracts.
    error TreeFull();
    /// @notice The caller may not unregister this target.
    error NotAllowed();

    /// @notice Registers `children` under the caller and adds them to the CoFHE access list.
    /// @dev    The caller must be an approved factory, or a contract registered under one. A child
    ///         needs no code yet, so a factory can register a CREATE2 address before it deploys.
    function register(address[] calldata children) external;

    /// @notice Removes `target` and every contract below it from the registry and from the CoFHE
    ///         access list.
    /// @dev    Allowed for `target` itself, any contract above it, or a Fhenix revoker.
    function unregister(address target) external;

    /// @notice The place of `account` in its tree. `parent == address(0)` means not registered.
    ///         An approved factory reports the registry as its parent and depth 0.
    function nodeOf(address account) external view returns (address parent, uint8 depth);

    /// @notice The live contracts below the approved factory `root`.
    function treeSizeOf(address root) external view returns (uint256);

    /// @notice The most live contracts one approved factory's tree can hold.
    function MAX_TREE_SIZE() external view returns (uint256);

    /// @notice The most levels below an approved factory.
    function MAX_DEPTH() external view returns (uint256);
}
