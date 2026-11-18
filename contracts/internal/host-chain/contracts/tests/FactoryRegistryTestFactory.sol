// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ITaskManager} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";
import {IFactoryRegistry} from "@fhenixprotocol/cofhe-contracts/IFactoryRegistry.sol";
import {FactoryRegistry} from "../FactoryRegistry.sol";

/// @notice Sends an FHE task from its constructor, so it deploys only if its address is already
///         on the access list.
contract ConstructorTaskCaller {
    constructor(ITaskManager tm) {
        tm.createRandomTask(2, 1, 0);
    }
}

/// @notice A partner-style factory: registers the CREATE2 address first, then deploys there.
contract FactoryRegistryTestFactory {
    IFactoryRegistry public immutable registry;

    constructor(IFactoryRegistry r) {
        registry = r;
    }

    function deploy(bytes32 salt, ITaskManager tm) external returns (address child) {
        address[] memory one = new address[](1);
        one[0] = predict(salt, tm);
        registry.register(one);
        child = address(new ConstructorTaskCaller{salt: salt}(tm));
    }

    /// @notice Deploys without registering, to show that the constructor task then fails.
    function deployUnregistered(bytes32 salt, ITaskManager tm) external returns (address) {
        return address(new ConstructorTaskCaller{salt: salt}(tm));
    }

    function predict(bytes32 salt, ITaskManager tm) public view returns (address) {
        bytes32 codeHash = keccak256(abi.encodePacked(type(ConstructorTaskCaller).creationCode, abi.encode(tm)));
        return Create2.computeAddress(salt, codeHash);
    }
}

/// @notice A second TaskManager stand-in for the setTaskManager test: only the access-list calls
///         the registry makes.
contract AccessListTaskManagerMock {
    mapping(address => bool) public accessList;

    function addToAccessList(address[] calldata accounts) external {
        for (uint256 i = 0; i < accounts.length; i++) accessList[accounts[i]] = true;
    }

    function removeFromAccessList(address[] calldata accounts) external {
        for (uint256 i = 0; i < accounts.length; i++) accessList[accounts[i]] = false;
    }
}

/// @notice An upgrade target for the upgrade test. It reuses the inherited `initialize`.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract FactoryRegistryV2Mock is FactoryRegistry {
    function version() external pure returns (uint256) {
        return 2;
    }
}
