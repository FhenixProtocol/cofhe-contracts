// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

/// Honest revoker: always returns disabled == false.
contract HonestRevoker {
    function disabled(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// Gas bomb: burns the entire forwarded allowance with CPU-bound keccak hashing,
/// then reverts. Models issue #151's attacker-chosen revoker: pre-fix,
/// ACPShareRegistry._isValid forwarded 63/64 of the enclosing call's gas under
/// EIP-150 — enough for a few poisoned shares to DoS any sharesFor caller.
contract GasBombRevoker {
    function disabled(address, uint256) external view returns (bool) {
        bytes32 h = keccak256(abi.encode(msg.sender));
        // ~10k keccak rounds per call: ~250k+ gas — overshoots any sane allowance
        for (uint256 i = 0; i < 20_000; ++i) {
            h = keccak256(abi.encodePacked(h, i));
        }
        revert("burned all forwarded gas");
    }
}
