// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

import {FHE, euint8} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract PubliclyAllowedTest {
    euint8 public lastHandle;

    function createAndAllowGlobal(uint8 value) public returns (euint8) {
        euint8 encrypted = FHE.asEuint8(value);
        // allowGlobal requires a persistent grant: the transient access from
        // creation alone is not enough. Persist to self first, then globalize.
        FHE.allow(encrypted, address(this));
        FHE.allowGlobal(encrypted);
        lastHandle = encrypted;
        return encrypted;
    }

    function createWithoutGlobal(uint8 value) public returns (euint8) {
        euint8 encrypted = FHE.asEuint8(value);
        lastHandle = encrypted;
        return encrypted;
    }
}
