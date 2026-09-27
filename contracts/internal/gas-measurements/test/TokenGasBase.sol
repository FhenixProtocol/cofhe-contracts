// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {ForkBase, TM} from "./ForkBase.sol";

/// Whole-transaction gas for token calls on a fork. Needs `isolate = true`: each call is then its
/// own transaction, and the gasleft() delta around it is 21,000 intrinsic + calldata + execution.
abstract contract TokenGasBase is ForkBase {
    uint8 constant EUINT64 = 5;

    string internal results;
    uint256 internal nonce;

    // Calldata is encoded before the measurement, so the delta holds only the transaction.
    function _txTo(address target, address from, bytes memory data) internal returns (uint256 used) {
        vm.prank(from);
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = target.call(data);
        used = g - gasleft();
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    // The token forwards msg.sender (the caller) as the input sender and is itself the consumer.
    function _input(address sender, address token) internal returns (bytes32, bytes memory) {
        uint256[] memory hashes = new uint256[](1);
        uint8[] memory utypes = new uint8[](1);
        hashes[0] = uint256(keccak256(abi.encode("token-input", nonce++)));
        utypes[0] = EUINT64;
        return (bytes32(hashes[0]), _signInputs(hashes, utypes, sender, token));
    }

    function _record(string memory id, uint256 gas) internal {
        assertGt(gas, 21_000, id);
        results = vm.serializeUint("rows", id, gas);
    }

    function _write(string memory chain, string memory file, string memory sourceCommit) internal {
        vm.serializeString("root", "chain", chain);
        vm.serializeUint("root", "forkBlock", forkBlock);
        vm.serializeAddress("root", "tmImpl", _impl(TM));
        vm.serializeAddress("root", "aclImpl", _impl(acl));
        vm.serializeAddress("root", "plaintextsStorageImpl", _impl(tm.plaintextsStorage()));
        vm.serializeString("root", "sourceCommit", sourceCommit);
        vm.writeJson(vm.serializeString("root", "rows", results), file);
    }
}
