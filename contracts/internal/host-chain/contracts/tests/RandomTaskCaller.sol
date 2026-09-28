// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

import {ITaskManager} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";

/// @notice Calls createRandomTask and allow in a single transaction, which is required
/// because transient ACL grants are cleared at the end of each transaction.
contract RandomTaskCaller {
    ITaskManager private immutable TASK_MANAGER;
    uint256 public lastHandle;

    constructor(address taskManager) {
        TASK_MANAGER = ITaskManager(taskManager);
    }

    /// @notice Creates a random task, then grants on an explicitly supplied handle.
    function createThenAllow(
        uint8 utype,
        uint256 seed,
        int32 securityZone,
        uint256 handle,
        address beneficiary
    ) external {
        TASK_MANAGER.createRandomTask(utype, seed, securityZone);
        TASK_MANAGER.allow(handle, beneficiary);
    }

    /// @notice Creates a random task, then grants on the handle it returned.
    function createThenAllowReturned(
        uint8 utype,
        uint256 seed,
        int32 securityZone,
        address beneficiary
    ) external {
        uint256 handle = TASK_MANAGER.createRandomTask(utype, seed, securityZone);
        TASK_MANAGER.allow(handle, beneficiary);
        lastHandle = handle;
    }
}
