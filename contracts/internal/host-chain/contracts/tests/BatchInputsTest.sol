// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

import {FHE, ebool, euint8, externalEuint8} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @dev Exercises the batch input converters so the handles they return can be
///      compared against TaskManager.batchVerifyInputs, verifying that value and
///      order survive the array reinterpretation done inside FHE.sol.
contract BatchInputsTest {
    bytes32[] public lastHandles;

    function batchAsEuint8(externalEuint8[] memory values, bytes memory signature) public {
        euint8[] memory verified = FHE.asEuint8s(values, signature);
        delete lastHandles;
        for (uint256 i = 0; i < verified.length; i++) {
            lastHandles.push(euint8.unwrap(verified[i]));
        }
    }

    function batchAsEbool(bytes[] memory values, bytes memory signature) public {
        ebool[] memory verified = FHE.asEbools(values, signature);
        delete lastHandles;
        for (uint256 i = 0; i < verified.length; i++) {
            lastHandles.push(ebool.unwrap(verified[i]));
        }
    }

    // The single-input converter now rides batchVerifyInputs as a batch of one,
    // so its signature must cover keccak256(h_0).
    function singleAsEuint8(externalEuint8 value, bytes memory signature) public {
        euint8 verified = FHE.asEuint8(value, signature);
        delete lastHandles;
        lastHandles.push(euint8.unwrap(verified));
    }

    function lastHandlesLength() external view returns (uint256) {
        return lastHandles.length;
    }
}
