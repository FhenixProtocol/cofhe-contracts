// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

import {FHE} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @notice Exposes the FHE.sol access-list helpers so tests can call them against the real address book.
contract AccessListManagerTest {
    function addToAccessList(address[] memory accounts) external {
        FHE.addToAccessList(accounts);
    }

    function removeFromAccessList(address[] memory accounts) external {
        FHE.removeFromAccessList(accounts);
    }
}
