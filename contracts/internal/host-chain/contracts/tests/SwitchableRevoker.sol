// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {IPermissionCustomIdValidator} from "../Permissioned.sol";

/// @dev Test-only revoker that can be made to revert, standing in for a revoker that fails for a
///      while (paused, mid-upgrade, or out of the gas a caller left it).
contract SwitchableRevoker is IPermissionCustomIdValidator {
    bool public reverting;

    function setReverting(bool value) external {
        reverting = value;
    }

    function disabled(address, uint256) external view returns (bool) {
        require(!reverting, "revoker unavailable");
        return false;
    }
}
