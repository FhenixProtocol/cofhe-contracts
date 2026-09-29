// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {Vm} from "forge-std/Vm.sol";
import {TokenGasBase} from "./TokenGasBase.sol";
import {TM} from "./ForkBase.sol";
import {euint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {FHERC20_Harness} from "@fhenixprotocol/confidential-contracts/test/FHERC20_Harness.sol";
import {FHERC20ConstantsAllowThis_Harness} from "../src/variants/constants/FHERC20ConstantsAllowThis_Harness.sol";
import {FHERC20RefundSkip_Harness} from "../src/variants/refundskip/FHERC20RefundSkip_Harness.sol";
import {FHERC20ConstantsRefundSkip_Harness} from "../src/variants/constants/FHERC20ConstantsRefundSkip_Harness.sol";
import {FHEConstants} from "../src/variants/constants/FHEConstants.sol";

interface IToken {
    function confidentialBalanceOf(address account) external view returns (euint64);
    function confidentialTotalSupply() external view returns (euint64);
    function balanceOf(address account) external view returns (uint256);
}

/// Variant D (skip the zero refund of transferAndCall when the recipient has no code), alone and on
/// top of constants variant A, against the original. Writes results/fherc20-refundskip-<chain>.json
/// and results/fherc20-refundskip-evidence-<chain>.json.
contract Fherc20RefundSkipGasTest is TokenGasBase {
    string constant SOURCE_COMMIT = "5138cb8644b19b24a75caf3f383a17457e823e16";
    bytes32 constant TASK_CREATED = keccak256("TaskCreated(uint256,string,uint256,uint256,uint256)");
    bytes32 constant CONFIDENTIAL_TRANSFER = keccak256("ConfidentialTransfer(address,address,bytes32)");

    address alice = makeAddr("pro575-refundskip-alice");
    address bob = makeAddr("pro575-refundskip-bob");
    address dave = makeAddr("pro575-refundskip-dave");

    string evidence;

    function test_sepolia() public {
        _run("sepolia", "results/fherc20-refundskip");
    }

    function test_arbitrumSepolia() public {
        _run("arbitrumSepolia", "results/fherc20-refundskip");
    }

    function _run(string memory chain, string memory prefix) internal {
        _fork(chain);
        _takeOverSigners();
        // Identical handles share ACL slots across tokens, so each token starts from the same clean state.
        uint256 clean = vm.snapshotState();
        uint256 startNonce = nonce;
        bytes32[4][4] memory handles;
        uint256[2][4] memory indicators;
        uint256[4] memory events;
        for (uint256 v = 0; v < 4; v++) {
            vm.revertToState(clean);
            nonce = startNonce;
            string memory tag = ["original.", "constantsAllowThis.", "refundSkip.", "constantsRefundSkip."][v];
            address t = _deploy(v);
            FHERC20_Harness h = FHERC20_Harness(t);
            _txTo(t, alice, abi.encodeCall(h.mint, (alice, 1_000_000)));
            _txTo(t, alice, abi.encodeCall(h.mint, (bob, 1_000)));

            vm.recordLogs();
            _record(string.concat(tag, "transferAndCallToNewEOA"), _transferAndCall(t, alice, dave));
            events[v] = _checkLogs(t, v, "newEOA", vm.getRecordedLogs());
            vm.recordLogs();
            _record(string.concat(tag, "transferAndCallToHolderEOA"), _transferAndCall(t, alice, bob));
            _checkLogs(t, v, "holderEOA", vm.getRecordedLogs());
            _record(string.concat(tag, "transferToHolder"), _transfer(t, alice, bob));

            handles[v] = _handles(t);
            indicators[v] = [IToken(t).balanceOf(alice), IToken(t).balanceOf(dave)];
        }
        // Constants do not change the computation: A == original, and D + A == D alone.
        for (uint256 i = 0; i < 4; i++) {
            assertEq(handles[1][i], handles[0][i], "A differs from original");
            assertEq(handles[3][i], handles[2][i], "D + A differs from D alone");
        }
        vm.serializeUint("evidence", "confidentialTransferEvents.original", events[0]);
        vm.serializeUint("evidence", "confidentialTransferEvents.refundSkip", events[2]);
        vm.serializeUint("evidence", "indicator.alice.original", indicators[0][0]);
        vm.serializeUint("evidence", "indicator.alice.refundSkip", indicators[2][0]);
        vm.serializeUint("evidence", "indicator.dave.original", indicators[0][1]);
        evidence = vm.serializeUint("evidence", "indicator.dave.refundSkip", indicators[2][1]);
        vm.writeJson(evidence, string.concat(prefix, "-evidence-", _stem(chain), ".json"));
        _write(chain, string.concat(prefix, "-", _stem(chain), ".json"), SOURCE_COMMIT);
    }

    /// On the original path, finds the refund `select` and proves its plaintext is 0 from its inputs:
    /// select(TRUE, ZERO, sent) is ZERO by definition. Returns the token's ConfidentialTransfer count.
    function _checkLogs(address t, uint256 v, string memory label, Vm.Log[] memory logs)
        internal
        returns (uint256 transferEvents)
    {
        uint256 refundSelects;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == t && logs[i].topics[0] == CONFIDENTIAL_TRANSFER) transferEvents++;
            if (logs[i].emitter != TM || logs[i].topics[0] != TASK_CREATED) continue;
            (uint256 ctHash, string memory op, uint256 in1, uint256 in2, uint256 in3) =
                abi.decode(logs[i].data, (uint256, string, uint256, uint256, uint256));
            if (keccak256(bytes(op)) != keccak256("select")) continue;
            if (bytes32(in1) == FHEConstants.TRUE_EBOOL_HANDLE && bytes32(in2) == FHEConstants.ZERO_EUINT64_HANDLE) {
                refundSelects++;
                if (v == 0) {
                    string memory k = string.concat("refundSelect.", label);
                    vm.serializeBytes32("evidence", string.concat(k, ".refundHandle"), bytes32(ctHash));
                    vm.serializeBytes32("evidence", string.concat(k, ".condition"), bytes32(in1));
                    vm.serializeBytes32("evidence", string.concat(k, ".ifTrue"), bytes32(in2));
                    vm.serializeBytes32("evidence", string.concat(k, ".ifFalse"), bytes32(in3));
                }
            }
        }
        // The original (and A) run exactly one refund select(TRUE, ZERO, sent); D runs none.
        assertEq(refundSelects, v < 2 ? 1 : 0, string.concat("refund selects on ", label));
    }

    function _deploy(uint256 v) internal returns (address) {
        if (v == 0) return address(new FHERC20_Harness("Gas", "GAS", 6, ""));
        if (v == 1) return address(new FHERC20ConstantsAllowThis_Harness("Gas", "GAS", 6, ""));
        if (v == 2) return address(new FHERC20RefundSkip_Harness("Gas", "GAS", 6, ""));
        return address(new FHERC20ConstantsRefundSkip_Harness("Gas", "GAS", 6, ""));
    }

    function _handles(address t) internal view returns (bytes32[4] memory out) {
        address[3] memory who = [alice, bob, dave];
        for (uint256 i = 0; i < 3; i++) {
            out[i] = euint64.unwrap(IToken(t).confidentialBalanceOf(who[i]));
        }
        out[3] = euint64.unwrap(IToken(t).confidentialTotalSupply());
    }

    function _transferAndCall(address t, address from, address to) internal returns (uint256) {
        (bytes32 h, bytes memory p) = _input(from, t);
        return _txTo(
            t, from, abi.encodeWithSignature("confidentialTransferAndCall(address,bytes32,bytes,bytes)", to, h, p, "")
        );
    }

    function _transfer(address t, address from, address to) internal returns (uint256) {
        (bytes32 h, bytes memory p) = _input(from, t);
        return _txTo(t, from, abi.encodeWithSignature("confidentialTransfer(address,bytes32,bytes)", to, h, p));
    }

    function _stem(string memory chain) internal pure returns (string memory) {
        return keccak256(bytes(chain)) == keccak256("sepolia") ? "sepolia" : "arbitrum-sepolia";
    }
}
