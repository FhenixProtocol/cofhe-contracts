// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { ebool, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// Handles of trivially encrypted constants. A handle derives only from (value, type, zone, op), so it
/// is the same on every chain and for every contract; the values below match what the live
/// TaskManagers return for `asEuint64(0)` and `asEbool(true)`. A contract still needs ACL access
/// to use them (its own allowThis, or a one-time allowGlobal).
library FHEConstants {
    bytes32 internal constant ZERO_EUINT64_HANDLE = 0x43662edd94f2cbb937c25150b4e534c629d27a2e7f7c7b9e5d7367635dbc8500;
    bytes32 internal constant TRUE_EBOOL_HANDLE = 0xb3e26d30bbd0fa3e41a1d86cb7844842fbb2638ed221cf36790bbd9c9f3e8000;

    function zeroEuint64() internal pure returns (euint64) {
        return euint64.wrap(ZERO_EUINT64_HANDLE);
    }

    function trueEbool() internal pure returns (ebool) {
        return ebool.wrap(TRUE_EBOOL_HANDLE);
    }
}
