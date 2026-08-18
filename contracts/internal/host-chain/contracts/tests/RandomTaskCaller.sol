// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

import {ITaskManager} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";
import {taskManagerAddress} from "../addresses/TaskManagerAddress.sol";

/// @notice Calls createRandomTask and allow in a single transaction, which is required
/// because transient ACL grants are cleared at the end of each transaction.
contract RandomTaskCaller {
    uint256 public lastHandle;

    /// @notice Creates a random task, then grants on an explicitly supplied handle.
    function createThenAllow(
        uint8 utype,
        uint256 seed,
        int32 securityZone,
        uint256 handle,
        address beneficiary
    ) external {
        ITaskManager(taskManagerAddress).createRandomTask(utype, seed, securityZone);
        ITaskManager(taskManagerAddress).allow(handle, beneficiary);
    }

    /// @notice Creates a random task, then grants on the handle it returned.
    function createThenAllowReturned(
        uint8 utype,
        uint256 seed,
        int32 securityZone,
        address beneficiary
    ) external {
        uint256 handle = ITaskManager(taskManagerAddress).createRandomTask(utype, seed, securityZone);
        ITaskManager(taskManagerAddress).allow(handle, beneficiary);
        lastHandle = handle;
    }
}
