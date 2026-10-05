// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

import {FHE, euint32} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @notice Exposes the FHE.sol decrypt-result helpers so tests can call them against the real address book.
contract SafeVariantsTest {
    function getDecryptResult(bytes32 ctHash) external view returns (uint256) {
        return FHE.getDecryptResult(ctHash);
    }

    function getDecryptResultSafe(bytes32 ctHash) external view returns (uint256, bool) {
        return FHE.getDecryptResultSafe(ctHash);
    }

    function verifyDecryptResultSafe(uint256 ctHash, uint256 result, bytes memory signature) external view returns (bool) {
        return FHE.verifyDecryptResultSafe(ctHash, result, signature);
    }

    function verifyDecryptResultBatchSafe(
        euint32[] memory inputs,
        uint32[] memory results,
        bytes[] memory signatures
    ) external view returns (bool[] memory) {
        return FHE.verifyDecryptResultBatchSafe(inputs, results, signatures);
    }
}
