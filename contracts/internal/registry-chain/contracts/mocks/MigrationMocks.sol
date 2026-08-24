// SPDX-License-Identifier: BSD-3-Clause-Clear
/* solhint-disable one-contract-per-file */
pragma solidity >=0.8.25 <0.9.0;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

/**
 * @notice Test-only stand-in for the pre-roles `Ownable2Step` CommitmentRegistry implementation.
 * @dev    Lets the suite reproduce the state a real migration passes through: a proxy whose
 *         `_initialized == 1` and whose AccessControl namespace is still zero, with an owner
 *         recorded in `openzeppelin.storage.Ownable`. Only the parts `initializeV2` depends on are
 *         reproduced - the registry's own storage is irrelevant to the migration gate.
 */
contract OwnableCommitmentRegistryMock is UUPSUpgradeable, Ownable2StepUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}

/// @notice Test-only ERC-1967 proxy, so the suite can bootstrap on an implementation the
///         OpenZeppelin upgrades plugin would refuse to `deployProxy`.
contract ERC1967ProxyMock is ERC1967Proxy {
    constructor(address implementation, bytes memory data) ERC1967Proxy(implementation, data) {}
}
