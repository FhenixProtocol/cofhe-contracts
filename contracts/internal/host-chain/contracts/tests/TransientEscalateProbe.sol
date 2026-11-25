// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13 <0.9.0;

interface ITaskManagerEscalate {
    function receiveCtHash(uint256 ctHash, address expectedSharer) external;
    function allowGlobal(uint256 ctHash) external;
    function allowForDecryption(uint256 ctHash) external;
}

/// @dev Claims a transient share and immediately tries to escalate it to a permanent grant.
/// Used to pin cofhe-contracts#174: allowGlobal / allowForDecryption must reject transient-only holding.
contract TransientEscalateProbe {
    ITaskManagerEscalate public immutable taskManager;

    constructor(address taskManager_) {
        taskManager = ITaskManagerEscalate(taskManager_);
    }

    function receiveAndAllowGlobal(uint256 handle, address sharer) external {
        taskManager.receiveCtHash(handle, sharer);
        taskManager.allowGlobal(handle);
    }

    function receiveAndAllowForDecryption(uint256 handle, address sharer) external {
        taskManager.receiveCtHash(handle, sharer);
        taskManager.allowForDecryption(handle);
    }
}
