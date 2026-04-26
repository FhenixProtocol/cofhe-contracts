// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

contract CommitmentRegistry is UUPSUpgradeable, Ownable2StepUpgradeable {

    enum VersionStatus { Unset, Active, Deprecated, Revoked }

    /// @notice Returned when a non-poster address attempts to post commitments.
    error OnlyPosterAllowed(address caller);

    /// @notice Returned when attempting to add a poster that is already registered.
    error PosterAlreadyExists(address poster);

    /// @notice Returned when attempting to remove a poster that is not registered.
    error PosterNotFound(address poster);

    /// @notice Returned when attempting to post commitments under a non-active version.
    error VersionNotActive(bytes32 version);

    /// @notice Returned when a commitment for the given handle already exists under this version.
    error CommitmentAlreadyExists(bytes32 version, bytes32 handle);

    /// @notice Returned when a zero address is provided where a non-zero address is required.
    error InvalidAddress();

    /// @notice Returned when the handles and commitHashes arrays have different lengths.
    error LengthMismatch();

    /// @notice Returned when an empty batch is submitted.
    error EmptyBatch();

    /// @notice Returned when a zero commitHash is provided for a handle.
    error ZeroCommitHash(bytes32 handle);

    /// @notice Returned when an invalid version status transition is attempted.
    error InvalidVersionTransition(bytes32 version, VersionStatus current, VersionStatus target);

    /// @custom:storage-location erc7201:cofhe.storage.CommitmentRegistry
    struct CommitmentRegistryStorage {
        mapping(bytes32 version => mapping(bytes32 handle => bytes32 commitHash)) commitments;
        mapping(bytes32 version => bytes32[]) handlesByVersion;
        mapping(bytes32 version => VersionStatus) versionStatus;
        mapping(address => bool) posters;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("cofhe.storage.CommitmentRegistry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT =
        keccak256(abi.encode(uint256(keccak256("cofhe.storage.CommitmentRegistry")) - 1)) & ~bytes32(uint256(0xff));

    event CommitmentsPosted(bytes32 indexed version, uint256 batchSize);
    /// @notice Emitted by `postCommitmentsSafe` when a handle is skipped because
    /// it was already committed under this version. `newlyPosted` is the count
    /// of handles that actually got written (i.e. `handles.length - skipped`).
    event CommitmentsPostedSafe(bytes32 indexed version, uint256 newlyPosted, uint256 skipped);
    event VersionStatusChanged(bytes32 indexed version, VersionStatus oldStatus, VersionStatus newStatus);
    event PosterAdded(address indexed poster);
    event PosterRemoved(address indexed poster);

    modifier onlyPoster() {
        CommitmentRegistryStorage storage $ = _getStorage();
        if (!$.posters[msg.sender]) {
            revert OnlyPosterAllowed(msg.sender);
        }
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner, address initialPoster) public initializer {
        if (initialOwner == address(0) || initialPoster == address(0)) {
            revert InvalidAddress();
        }
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        CommitmentRegistryStorage storage $ = _getStorage();
        $.posters[initialPoster] = true;
        emit PosterAdded(initialPoster);
    }

    function postCommitments(
        bytes32 version,
        bytes32[] calldata handles,
        bytes32[] calldata commitHashes
    ) external onlyPoster {
        uint256 len = handles.length;
        if (len == 0) revert EmptyBatch();
        if (len != commitHashes.length) revert LengthMismatch();

        CommitmentRegistryStorage storage $ = _getStorage();

        if ($.versionStatus[version] != VersionStatus.Active) {
            revert VersionNotActive(version);
        }

        mapping(bytes32 => bytes32) storage versionMap = $.commitments[version];

        for (uint256 i = 0; i < len; ) {
            bytes32 handle = handles[i];
            bytes32 commitHash = commitHashes[i];
            if (commitHash == bytes32(0)) revert ZeroCommitHash(handle);
            if (versionMap[handle] != bytes32(0)) revert CommitmentAlreadyExists(version, handle);
            versionMap[handle] = commitHash;
            $.handlesByVersion[version].push(handle);
            unchecked { ++i; }
        }
        emit CommitmentsPosted(version, len);
    }

    /// @notice Idempotent variant of `postCommitments`. Handles already committed
    /// under this version are silently skipped instead of reverting the batch.
    /// Useful for callers (e.g. blockchain-poster) where the same handle may
    /// arrive in multiple flushes due to deterministic FHE outputs or message
    /// redeliveries — the on-chain end state is identical either way, and the
    /// caller would rather make progress than roll back the whole batch.
    ///
    /// `ZeroCommitHash` and `LengthMismatch` still revert (those indicate caller
    /// bugs, not duplicates). `VersionNotActive`, `EmptyBatch` likewise.
    function postCommitmentsSafe(
        bytes32 version,
        bytes32[] calldata handles,
        bytes32[] calldata commitHashes
    ) external onlyPoster {
        uint256 len = handles.length;
        if (len == 0) revert EmptyBatch();
        if (len != commitHashes.length) revert LengthMismatch();

        CommitmentRegistryStorage storage $ = _getStorage();

        if ($.versionStatus[version] != VersionStatus.Active) {
            revert VersionNotActive(version);
        }

        mapping(bytes32 => bytes32) storage versionMap = $.commitments[version];

        uint256 newlyPosted = 0;
        for (uint256 i = 0; i < len; ) {
            bytes32 handle = handles[i];
            bytes32 commitHash = commitHashes[i];
            if (commitHash == bytes32(0)) revert ZeroCommitHash(handle);
            if (versionMap[handle] == bytes32(0)) {
                versionMap[handle] = commitHash;
                $.handlesByVersion[version].push(handle);
                unchecked { ++newlyPosted; }
            }
            // else: handle already committed — silently skip. The desired end
            // state (commitment recorded under (version, handle)) is unchanged.
            unchecked { ++i; }
        }
        emit CommitmentsPostedSafe(version, newlyPosted, len - newlyPosted);
    }

    function addPoster(address poster) external onlyOwner {
        if (poster == address(0)) revert InvalidAddress();
        CommitmentRegistryStorage storage $ = _getStorage();
        if ($.posters[poster]) revert PosterAlreadyExists(poster);
        $.posters[poster] = true;
        emit PosterAdded(poster);
    }

    function removePoster(address poster) external onlyOwner {
        if (poster == address(0)) revert InvalidAddress();
        CommitmentRegistryStorage storage $ = _getStorage();
        if (!$.posters[poster]) revert PosterNotFound(poster);
        $.posters[poster] = false;
        emit PosterRemoved(poster);
    }

    function setVersionStatus(bytes32 version, VersionStatus newStatus) external onlyOwner {
        CommitmentRegistryStorage storage $ = _getStorage();
        VersionStatus current = $.versionStatus[version];

        // Allowed transitions:
        // Unset -> Active
        // Active -> Deprecated
        // Active -> Revoked
        // Deprecated -> Revoked
        bool allowed = (current == VersionStatus.Unset      && newStatus == VersionStatus.Active)     ||
                       (current == VersionStatus.Active     && newStatus == VersionStatus.Deprecated)  ||
                       (current == VersionStatus.Active     && newStatus == VersionStatus.Revoked)     ||
                       (current == VersionStatus.Deprecated && newStatus == VersionStatus.Revoked);

        if (!allowed) {
            revert InvalidVersionTransition(version, current, newStatus);
        }

        $.versionStatus[version] = newStatus;
        emit VersionStatusChanged(version, current, newStatus);
    }

    function getCommitment(bytes32 version, bytes32 handle) external view returns (bytes32) {
        return _getStorage().commitments[version][handle];
    }

    function getVersionStatus(bytes32 version) external view returns (VersionStatus) {
        return _getStorage().versionStatus[version];
    }

    function getSize(bytes32 version) external view returns (uint256) {
        return _getStorage().handlesByVersion[version].length;
    }

    function getHandleByIndex(bytes32 version, uint256 index) external view returns (bytes32) {
        return _getStorage().handlesByVersion[version][index];
    }

    function getHandles(bytes32 version, uint256 offset, uint256 limit) external view returns (bytes32[] memory) {
        CommitmentRegistryStorage storage $ = _getStorage();
        bytes32[] storage allHandles = $.handlesByVersion[version];
        uint256 total = allHandles.length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 len = end - offset;
        bytes32[] memory result = new bytes32[](len);
        for (uint256 i = 0; i < len; ) {
            result[i] = allHandles[offset + i];
            unchecked { ++i; }
        }
        return result;
    }

    function isPoster(address account) external view returns (bool) {
        return _getStorage().posters[account];
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function _getStorage() private pure returns (CommitmentRegistryStorage storage $) {
        bytes32 slot = STORAGE_SLOT;
        assembly {
            $.slot := slot
        }
    }
}
