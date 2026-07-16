// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;
import {taskManagerAddress} from "./addresses/TaskManagerAddress.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlDefaultAdminRulesUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";

contract PlaintextsStorage is UUPSUpgradeable, AccessControlDefaultAdminRulesUpgradeable {
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

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

    function initialize(address initialAdmin, uint48 initialDelay) public initializer {
        __AccessControlDefaultAdminRules_init(initialDelay, initialAdmin);
        __UUPSUpgradeable_init();
    }

    /// @dev Upgrade-only re-initializer for proxies migrating from the Ownable
    ///      implementation. Do not call on a freshly `initialize`d proxy: it would
    ///      grant a second DEFAULT_ADMIN_ROLE holder, breaking the single-admin invariant.
    /// @custom:oz-upgrades-validate-as-initializer
    function initializeV2(uint48 initialDelay, address initialAdmin) public reinitializer(2) {
        __AccessControlDefaultAdminRules_init(initialDelay, initialAdmin);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}