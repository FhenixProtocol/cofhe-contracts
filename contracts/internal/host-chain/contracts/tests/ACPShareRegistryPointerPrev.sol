// SPDX-License-Identifier: MIT
// Test-only: a pointer-based ACPShareRegistry whose code differs from the current build, standing in
// for an earlier pointer-based release to test a pointer-to-pointer upgrade.
pragma solidity >=0.8.25 <0.9.0;

import {ACPShareRegistry} from "../ACPShareRegistry.sol";

contract ACPShareRegistryPointerPrev is ACPShareRegistry {
    function previousRelease() external pure returns (bool) {
        return true;
    }
}
