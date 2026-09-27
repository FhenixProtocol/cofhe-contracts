// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {ForkBase} from "./ForkBase.sol";

contract ForkSmokeTest is ForkBase {
    function test_sepolia() public {
        _fork("sepolia");
        assertEq(tm.getVersion(), 10);
        assertTrue(tm.isEnabled());
    }

    function test_arbitrumSepolia() public {
        _fork("arbitrumSepolia");
        assertEq(tm.getVersion(), 11);
        assertTrue(tm.isEnabled());
    }
}
