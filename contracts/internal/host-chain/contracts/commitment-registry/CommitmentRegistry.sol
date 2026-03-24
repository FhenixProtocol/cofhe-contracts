// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

contract CommitmentRegistry is UUPSUpgradeable, Ownable2StepUpgradeable {

    enum VersionStatus { Unset, Active, Deprecated, Revoked }

    /// @notice Returned when a non-poster address attempts to post commitments.
    error OnlyPosterAllowed(address caller);

    /// @notice Returned when attempting to post commitments under a non-active version.
    error VersionNotActive(bytes32 version);

    /// @notice Returned when a commitment for the given handle already exists under this version.
    error CommitmentAlreadyExists(bytes32 version, bytes32 handle);

    /// @notice Returned when a zero address is provided where a non-zero address is required.
    error InvalidAddress();

    /// @notice Returned when the handles and ctHashes arrays have different lengths.
    error LengthMismatch();

    /// @notice Returned when an empty batch is submitted.
    error EmptyBatch();

    /// @notice Returned when a zero ctHash is provided for a handle.
    error ZeroCtHash(bytes32 handle);

    /// @notice Returned when an invalid version status transition is attempted.
    error InvalidVersionTransition(bytes32 version, VersionStatus current, VersionStatus target);

    /// @custom:storage-location erc7201:cofhe.storage.CommitmentRegistry
    struct CommitmentRegistryStorage {
        mapping(bytes32 version => mapping(bytes32 handle => bytes32 ctHash)) commitments;
        mapping(bytes32 version => VersionStatus) versionStatus;
        mapping(bytes32 version => uint256) commitmentCount;
        address poster;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("cofhe.storage.CommitmentRegistry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT =
        keccak256(abi.encode(uint256(keccak256("cofhe.storage.CommitmentRegistry")) - 1)) & ~bytes32(uint256(0xff));

    event CommitmentsPosted(bytes32 indexed version, uint256 batchSize);
    event VersionStatusChanged(bytes32 indexed version, VersionStatus oldStatus, VersionStatus newStatus);
    event PosterChanged(address indexed oldPoster, address indexed newPoster);

    modifier onlyPoster() {
        CommitmentRegistryStorage storage $ = _getStorage();
        if (msg.sender != $.poster) {
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
        $.poster = initialPoster;
        emit PosterChanged(address(0), initialPoster);
    }

    function postCommitments(
        bytes32 version,
        bytes32[] calldata handles,
        bytes32[] calldata ctHashes
    ) external onlyPoster {
        uint256 len = handles.length;
        if (len == 0) revert EmptyBatch();
        if (len != ctHashes.length) revert LengthMismatch();

        CommitmentRegistryStorage storage $ = _getStorage();

        if ($.versionStatus[version] != VersionStatus.Active) {
            revert VersionNotActive(version);
        }

        mapping(bytes32 => bytes32) storage versionMap = $.commitments[version];

        for (uint256 i = 0; i < len; ) {
            bytes32 handle = handles[i];
            bytes32 ctHash = ctHashes[i];
            if (ctHash == bytes32(0)) revert ZeroCtHash(handle);
            if (versionMap[handle] != bytes32(0)) revert CommitmentAlreadyExists(version, handle);
            versionMap[handle] = ctHash;
            unchecked { ++i; }
        }

        $.commitmentCount[version] += len;
        emit CommitmentsPosted(version, len);
    }

    function setPoster(address newPoster) external onlyOwner {
        if (newPoster == address(0)) revert InvalidAddress();
        CommitmentRegistryStorage storage $ = _getStorage();
        address oldPoster = $.poster;
        $.poster = newPoster;
        emit PosterChanged(oldPoster, newPoster);
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
        return _getStorage().commitmentCount[version];
    }

    function getPoster() external view returns (address) {
        return _getStorage().poster;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function _getStorage() private pure returns (CommitmentRegistryStorage storage $) {
        bytes32 slot = STORAGE_SLOT;
        assembly {
            $.slot := slot
        }
    }
}
