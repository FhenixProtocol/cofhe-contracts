// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;
import {taskManagerAddress} from "./addresses/TaskManagerAddress.sol";
import {LegacyOwnable} from "./LegacyOwnable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlDefaultAdminRulesUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";

contract PlaintextsStorage is UUPSUpgradeable, AccessControlDefaultAdminRulesUpgradeable {
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// @dev Reserves the namespace this contract used while it inherited OwnableUpgradeable.
    ///      Already-deployed proxies still hold an owner there; keeping the declaration marks
    ///      that storage as taken so a later upgrade cannot silently reuse it.
    /// @custom:storage-location erc7201:openzeppelin.storage.Ownable
    struct OwnableStorage {
        address _owner;
    }

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

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}