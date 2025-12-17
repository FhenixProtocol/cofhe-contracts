// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;
import {taskManagerAddress} from "./addresses/DeterministicTaskManagerAddress.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract DeterministicPlaintextsStorage is UUPSUpgradeable, OwnableUpgradeable {
    struct PlaintextResult {
        bool existenceIndicator;
        uint256 result;
    }

    mapping(uint256 => PlaintextResult) private plaintextResults;

    error OnlyTaskManagerAllowed(address caller);

    modifier onlyTaskManager() {
        if (msg.sender != taskManagerAddress) {
            revert OnlyTaskManagerAllowed(msg.sender);
        }
        _;
    }

    function storeResult(uint256 ctHash, uint256 result) external onlyTaskManager {
        // We decided not to optimize this by first reading if the result exists,
        // because the optimzation might cost more than the benefit.
        plaintextResults[ctHash] = PlaintextResult({
            existenceIndicator: true,
            result: result
        });
    }

    function getResult(uint256 ctHash) external view returns (uint256, bool) {
        PlaintextResult memory result = plaintextResults[ctHash];
        return (result.result, result.existenceIndicator);
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}