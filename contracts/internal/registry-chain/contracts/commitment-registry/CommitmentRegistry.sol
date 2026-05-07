// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

/// @title CommitmentRegistry
/// @notice Stores FHE computation commitments scoped by (chainId, version, handle).
///
/// Storage hierarchy is chainId-first because chains are independent rollout
/// surfaces: each chain has its own crypto-material lifecycle, and one chain
/// migrating to a new version says nothing about another. The `version` is the
/// cryptographic identity of the keys used to produce the ciphertext (per the
/// engine's COMMITMENT_VERSION constant — currently a placeholder, eventually
/// keccak256 of publicKey/library/params), so it is required data on every
/// write and cannot be defaulted by the contract: filing a commitment under
/// the wrong version would silently break TN's integrity check.
contract CommitmentRegistry is UUPSUpgradeable, Ownable2StepUpgradeable {

    enum VersionStatus { Unset, Active, Deprecated, Revoked }

    error OnlyPosterAllowed(address caller);
    error PosterAlreadyExists(address poster);
    error PosterNotFound(address poster);
    error VersionNotActive(uint64 chainId, bytes32 version);
    error CommitmentAlreadyExists(uint64 chainId, bytes32 version, bytes32 handle);
    error InvalidAddress();
    error InvalidChainId();
    error LengthMismatch();
    error EmptyBatch();
    error ZeroCommitHash(bytes32 handle);
    error InvalidVersionTransition(uint64 chainId, bytes32 version, VersionStatus current, VersionStatus target);

    /// @custom:storage-location erc7201:cofhe.storage.CommitmentRegistry
    struct CommitmentRegistryStorage {
        mapping(uint64 chainId => mapping(bytes32 version => mapping(bytes32 handle => bytes32 commitHash))) commitments;
        mapping(uint64 chainId => mapping(bytes32 version => bytes32[])) handles;
        mapping(uint64 chainId => mapping(bytes32 version => VersionStatus)) versionStatus;
        mapping(address => bool) posters;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("cofhe.storage.CommitmentRegistry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT =
        keccak256(abi.encode(uint256(keccak256("cofhe.storage.CommitmentRegistry")) - 1)) & ~bytes32(uint256(0xff));

    event CommitmentsPosted(uint64 indexed chainId, bytes32 indexed version, uint256 batchSize);
    /// @notice Emitted by `postCommitmentsSafe` when some handles were already
    /// committed under (chainId, version) and silently skipped.
    event CommitmentsPostedSafe(uint64 indexed chainId, bytes32 indexed version, uint256 newlyPosted, uint256 skipped);
    /// @notice Emitted by `postCommitmentsSafe` when an existing handle is
    /// re-posted with a *different* commitHash than the one already stored.
    /// The function still skips silently (per its idempotent contract) — this
    /// event surfaces the disagreement so off-chain monitoring can detect
    /// commitment drift between producers (e.g. two engine instances racing
    /// after a key rotation, or a producer bug).
    event CommitmentMismatchSkipped(
        uint64 indexed chainId,
        bytes32 indexed version,
        bytes32 indexed handle,
        bytes32 stored,
        bytes32 attempted
    );
    event VersionStatusChanged(uint64 indexed chainId, bytes32 indexed version, VersionStatus oldStatus, VersionStatus newStatus);
    event PosterAdded(address indexed poster);
    event PosterRemoved(address indexed poster);

    modifier onlyPoster() {
        CommitmentRegistryStorage storage $ = _getStorage();
        if (!$.posters[msg.sender]) revert OnlyPosterAllowed(msg.sender);
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
        uint64 chainId,
        bytes32 version,
        bytes32[] calldata handlesArr,
        bytes32[] calldata commitHashes
    ) external onlyPoster {
        if (chainId == 0) revert InvalidChainId();
        uint256 len = handlesArr.length;
        if (len == 0) revert EmptyBatch();
        if (len != commitHashes.length) revert LengthMismatch();

        CommitmentRegistryStorage storage $ = _getStorage();

        if ($.versionStatus[chainId][version] != VersionStatus.Active) {
            revert VersionNotActive(chainId, version);
        }

        mapping(bytes32 => bytes32) storage commitMap = $.commitments[chainId][version];
        bytes32[] storage handleList = $.handles[chainId][version];

        for (uint256 i = 0; i < len; ) {
            bytes32 handle = handlesArr[i];
            bytes32 commitHash = commitHashes[i];
            if (commitHash == bytes32(0)) revert ZeroCommitHash(handle);
            if (commitMap[handle] != bytes32(0)) revert CommitmentAlreadyExists(chainId, version, handle);
            commitMap[handle] = commitHash;
            handleList.push(handle);
            unchecked { ++i; }
        }
        emit CommitmentsPosted(chainId, version, len);
    }

    /// @notice Idempotent variant of `postCommitments`. Handles already committed
    /// under (chainId, version) are silently skipped instead of reverting the
    /// batch. Useful when the same handle may arrive across multiple flushes
    /// due to deterministic FHE outputs or message redeliveries.
    function postCommitmentsSafe(
        uint64 chainId,
        bytes32 version,
        bytes32[] calldata handlesArr,
        bytes32[] calldata commitHashes
    ) external onlyPoster {
        if (chainId == 0) revert InvalidChainId();
        uint256 len = handlesArr.length;
        if (len == 0) revert EmptyBatch();
        if (len != commitHashes.length) revert LengthMismatch();

        CommitmentRegistryStorage storage $ = _getStorage();

        if ($.versionStatus[chainId][version] != VersionStatus.Active) {
            revert VersionNotActive(chainId, version);
        }

        mapping(bytes32 => bytes32) storage commitMap = $.commitments[chainId][version];
        bytes32[] storage handleList = $.handles[chainId][version];

        uint256 newlyPosted = 0;
        for (uint256 i = 0; i < len; ) {
            bytes32 handle = handlesArr[i];
            bytes32 commitHash = commitHashes[i];
            if (commitHash == bytes32(0)) revert ZeroCommitHash(handle);
            bytes32 stored = commitMap[handle];
            if (stored == bytes32(0)) {
                commitMap[handle] = commitHash;
                handleList.push(handle);
                unchecked { ++newlyPosted; }
            } else if (stored != commitHash) {
                // Idempotent skip is intentional, but a *disagreeing* re-post
                // is a producer-side bug or rotation race the operator needs
                // to see. Strictly-equal redeliveries stay silent.
                emit CommitmentMismatchSkipped(chainId, version, handle, stored, commitHash);
            }
            unchecked { ++i; }
        }
        emit CommitmentsPostedSafe(chainId, version, newlyPosted, len - newlyPosted);
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

    /// @notice Owner-managed lifecycle for (chainId, version) pairs. Multiple
    /// versions per chain may be Active simultaneously to support rotation
    /// overlap (deploy v2 alongside v1, drain in-flight v1 work, then deprecate
    /// v1) — the contract does not enforce a single-Active invariant.
    function setVersionStatus(uint64 chainId, bytes32 version, VersionStatus newStatus) external onlyOwner {
        if (chainId == 0) revert InvalidChainId();
        CommitmentRegistryStorage storage $ = _getStorage();
        VersionStatus current = $.versionStatus[chainId][version];

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
            revert InvalidVersionTransition(chainId, version, current, newStatus);
        }

        $.versionStatus[chainId][version] = newStatus;
        emit VersionStatusChanged(chainId, version, current, newStatus);
    }

    function getCommitment(uint64 chainId, bytes32 version, bytes32 handle) external view returns (bytes32) {
        return _getStorage().commitments[chainId][version][handle];
    }

    function getVersionStatus(uint64 chainId, bytes32 version) external view returns (VersionStatus) {
        return _getStorage().versionStatus[chainId][version];
    }

    function getSize(uint64 chainId, bytes32 version) external view returns (uint256) {
        return _getStorage().handles[chainId][version].length;
    }

    function getHandleByIndex(uint64 chainId, bytes32 version, uint256 index) external view returns (bytes32) {
        return _getStorage().handles[chainId][version][index];
    }

    function getHandles(uint64 chainId, bytes32 version, uint256 offset, uint256 limit)
        external view returns (bytes32[] memory)
    {
        CommitmentRegistryStorage storage $ = _getStorage();
        bytes32[] storage allHandles = $.handles[chainId][version];
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
