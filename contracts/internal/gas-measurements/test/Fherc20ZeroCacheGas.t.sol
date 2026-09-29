// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {TokenGasBase} from "./TokenGasBase.sol";
import {euint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {FHERC20_Harness} from "@fhenixprotocol/confidential-contracts/test/FHERC20_Harness.sol";
import {FHERC20ZeroCache_Harness} from "../src/variants/FHERC20ZeroCache_Harness.sol";

interface IBalances {
    function confidentialBalanceOf(address account) external view returns (euint64);
}

/// The zero-cache FHERC20 variant against the original, on the same fork and the same inputs.
/// Writes results/fherc20-zerocache-<chain>.json.
contract Fherc20ZeroCacheGasTest is TokenGasBase {
    string constant SOURCE_COMMIT = "5138cb8644b19b24a75caf3f383a17457e823e16";

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address operator = makeAddr("operator");

    function test_sepolia() public {
        _run("sepolia", "results/fherc20-zerocache-sepolia.json");
    }

    function test_arbitrumSepolia() public {
        _run("arbitrumSepolia", "results/fherc20-zerocache-arbitrum-sepolia.json");
    }

    function _run(string memory chain, string memory file) internal {
        _fork(chain);
        _takeOverSigners();
        // Both tokens produce identical handles, and ACL entries like allow(handle, alice) are keyed by
        // handle and account, not by token. So each token runs on the same clean fork state; otherwise
        // the second run would find those slots already written and look too cheap.
        uint256 clean = vm.snapshotState();
        uint256 startNonce = nonce;
        address original = address(new FHERC20_Harness("Gas", "GAS", 6, ""));
        _flow(original, false);
        bytes32[3] memory expected = _balances(original);
        vm.revertToState(clean);

        nonce = startNonce; // same input handles for both tokens
        address variant = address(new FHERC20ZeroCache_Harness("Gas", "GAS", 6, ""));
        _flow(variant, true);
        bytes32[3] memory got = _balances(variant);

        // Handles are pure functions of their inputs: equal balance handles mean the variant runs
        // exactly the same encrypted computation.
        for (uint256 i = 0; i < 3; i++) {
            assertNotEq(got[i], bytes32(0), "no balance");
            assertEq(got[i], expected[i], "balance handle differs");
        }
        _write(chain, file, SOURCE_COMMIT);
    }

    function _balances(address t) internal view returns (bytes32[3] memory out) {
        address[3] memory who = [alice, bob, carol];
        for (uint256 i = 0; i < 3; i++) {
            out[i] = euint64.unwrap(IBalances(t).confidentialBalanceOf(who[i]));
        }
    }

    function _flow(address t, bool isVariant) internal {
        uint256[4] memory gas;
        FHERC20_Harness(t).mint(alice, 1_000_000);
        FHERC20_Harness(t).mint(bob, 1_000);
        string memory tag = isVariant ? "zeroCache." : "original.";
        gas[0] = _transfer(t, alice, bob);
        gas[1] = _transfer(t, alice, carol);
        gas[2] = _transfer(t, alice, bob);
        _txTo(t, alice, abi.encodeCall(FHERC20_Harness(t).setOperator, (operator, type(uint48).max)));
        (bytes32 h, bytes memory p) = _input(operator, t);
        gas[3] = _txTo(
            t,
            operator,
            abi.encodeWithSignature("confidentialTransferFrom(address,address,bytes32,bytes)", alice, bob, h, p)
        );
        _record(string.concat(tag, "transferToHolder"), gas[0]);
        _record(string.concat(tag, "transferToNewHolder"), gas[1]);
        _record(string.concat(tag, "transferAgain"), gas[2]);
        _record(string.concat(tag, "transferFromByOperator"), gas[3]);
    }

    function _transfer(address t, address from, address to) internal returns (uint256) {
        (bytes32 h, bytes memory p) = _input(from, t);
        return _txTo(t, from, abi.encodeWithSignature("confidentialTransfer(address,bytes32,bytes)", to, h, p));
    }
}
