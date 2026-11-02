// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {FHE, ebool, euint8} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @notice Builds operands in chosen security zones and feeds them to a task in one
///         transaction, since the TaskManager's grants on fresh handles are transient.
contract SelectZoneProbe {
    bytes32 public lastResult;

    /// @notice select(control, ifTrue, ifFalse) with the control in `controlZone` and both
    ///         branches in `valueZone`.
    function selectAcrossZones(int32 controlZone, int32 valueZone) external returns (bytes32) {
        ebool control = FHE.asEbool(true, controlZone);
        euint8 a = FHE.asEuint8(1, valueZone);
        euint8 b = FHE.asEuint8(2, valueZone);
        euint8 r = FHE.select(control, a, b);
        lastResult = euint8.unwrap(r);
        return lastResult;
    }

    /// @notice add(lhs, rhs) with the operands in different zones - the reference behavior.
    function addAcrossZones(int32 lhsZone, int32 rhsZone) external returns (bytes32) {
        euint8 a = FHE.asEuint8(1, lhsZone);
        euint8 b = FHE.asEuint8(2, rhsZone);
        euint8 r = FHE.add(a, b);
        lastResult = euint8.unwrap(r);
        return lastResult;
    }
}
