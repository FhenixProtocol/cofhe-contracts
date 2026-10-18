// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

import {FHE} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @notice Exposes FHE.addToAccessList so tests can call it against the real address book.
contract AccessListManagerTest {
    function addToAccessList(address[] memory accounts) external {
        FHE.addToAccessList(accounts);
    }
}
