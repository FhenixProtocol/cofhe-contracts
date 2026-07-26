// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

import {ITaskManager} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";

/// @notice Calls createRandomTask and allow in a single transaction, which is required
/// because transient ACL grants are cleared at the end of each transaction.
contract RandomTaskCaller {
    address private constant TASK_MANAGER = 0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9;

    uint256 public lastHandle;

    /// @notice Creates a random task, then grants on an explicitly supplied handle.
    function createThenAllow(
        uint8 utype,
        uint256 seed,
        int32 securityZone,
        uint256 handle,
        address beneficiary
    ) external {
        ITaskManager(TASK_MANAGER).createRandomTask(utype, seed, securityZone);
        ITaskManager(TASK_MANAGER).allow(handle, beneficiary);
    }

    /// @notice Creates a random task, then grants on the handle it returned.
    function createThenAllowReturned(
        uint8 utype,
        uint256 seed,
        int32 securityZone,
        address beneficiary
    ) external {
        uint256 handle = ITaskManager(TASK_MANAGER).createRandomTask(utype, seed, securityZone);
        ITaskManager(TASK_MANAGER).allow(handle, beneficiary);
        lastHandle = handle;
    }
}
