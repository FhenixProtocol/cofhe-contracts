// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {TokenGasBase} from "./TokenGasBase.sol";
import {FHE, ebool, euint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {FHERC20_Harness} from "@fhenixprotocol/confidential-contracts/test/FHERC20_Harness.sol";
import {FHERC20ZeroCache_Harness} from "../src/variants/FHERC20ZeroCache_Harness.sol";
import {FHERC20ConstantsAllowThis_Harness} from "../src/variants/constants/FHERC20ConstantsAllowThis_Harness.sol";
import {FHERC20ConstantsGlobal_Harness} from "../src/variants/constants/FHERC20ConstantsGlobal_Harness.sol";
import {FHEConstants} from "../src/variants/constants/FHEConstants.sol";

interface IToken {
    function confidentialBalanceOf(address account) external view returns (euint64);
    function confidentialTotalSupply() external view returns (euint64);
}

/// One-time, chain-wide setup for constants variant B: anyone may then use the constant handles.
contract ConstantsRegistrar {
    function register() external {
        euint64 zero = FHE.asEuint64(0);
        ebool yes = FHE.asEbool(true);
        require(euint64.unwrap(zero) == FHEConstants.ZERO_EUINT64_HANDLE, "zero handle mismatch");
        require(ebool.unwrap(yes) == FHEConstants.TRUE_EBOOL_HANDLE, "true handle mismatch");
        FHE.allowGlobal(zero);
        FHE.allowGlobal(yes);
    }
}

/// Original FHERC20 vs zero cache vs constants (A: allowThis, B: global) on the same fork and inputs.
/// Writes results/fherc20-constants-<chain>.json.
contract Fherc20ConstantsGasTest is TokenGasBase {
    string constant SOURCE_COMMIT = "5138cb8644b19b24a75caf3f383a17457e823e16";
    uint256 constant TOKENS = 4;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address operator = makeAddr("operator");

    function test_sepolia() public {
        _run("sepolia", "results/fherc20-constants-sepolia.json");
    }

    function test_arbitrumSepolia() public {
        _run("arbitrumSepolia", "results/fherc20-constants-arbitrum-sepolia.json");
    }

    function _run(string memory chain, string memory file) internal {
        _fork(chain);
        _takeOverSigners();
        // All variants produce identical handles, and ACL entries are keyed by handle and account, not
        // by token. So each token runs on the same clean fork state; otherwise a later run would find
        // the slots already written and look too cheap.
        uint256 clean = vm.snapshotState();
        uint256 startNonce = nonce;
        bytes32[5] memory expected;
        for (uint256 v = 0; v < TOKENS; v++) {
            vm.revertToState(clean);
            nonce = startNonce; // same input handles for every token
            string memory tag = ["original.", "zeroCache.", "constantsAllowThis.", "constantsGlobal."][v];
            if (v == 3) {
                ConstantsRegistrar registrar = new ConstantsRegistrar();
                _record(
                    "constantsGlobal.oneTimeRegistrar",
                    _txTo(address(registrar), alice, abi.encodeCall(registrar.register, ()))
                );
            }
            address t = _deploy(v, tag);
            _flow(t, tag);
            bytes32[5] memory got = _handles(t);
            for (uint256 i = 0; i < 5; i++) {
                assertNotEq(got[i], bytes32(0), "no handle");
                if (v == 0) expected[i] = got[i];
                // Handles are pure functions of their inputs: equal handles mean the same encrypted computation.
                else assertEq(got[i], expected[i], string.concat(tag, " handle differs"));
            }
        }
        _write(chain, file, SOURCE_COMMIT);
    }

    function _deploy(uint256 v, string memory tag) internal returns (address t) {
        uint256 g = gasleft();
        if (v == 0) t = address(new FHERC20_Harness("Gas", "GAS", 6, ""));
        else if (v == 1) t = address(new FHERC20ZeroCache_Harness("Gas", "GAS", 6, ""));
        else if (v == 2) t = address(new FHERC20ConstantsAllowThis_Harness("Gas", "GAS", 6, ""));
        else t = address(new FHERC20ConstantsGlobal_Harness("Gas", "GAS", 6, ""));
        _record(string.concat(tag, "deploy"), g - gasleft());
    }

    // balances of alice, bob, carol, dave and the total supply
    function _handles(address t) internal view returns (bytes32[5] memory out) {
        address[4] memory who = [alice, bob, carol, dave];
        for (uint256 i = 0; i < 4; i++) {
            out[i] = euint64.unwrap(IToken(t).confidentialBalanceOf(who[i]));
        }
        out[4] = euint64.unwrap(IToken(t).confidentialTotalSupply());
    }

    function _flow(address t, string memory tag) internal {
        FHERC20_Harness h = FHERC20_Harness(t);
        _record(string.concat(tag, "mintFirst"), _txTo(t, alice, abi.encodeCall(h.mint, (alice, 1_000_000))));
        _record(string.concat(tag, "mintToNewAccount"), _txTo(t, alice, abi.encodeCall(h.mint, (bob, 1_000))));
        _record(string.concat(tag, "mintToHolder"), _txTo(t, alice, abi.encodeCall(h.mint, (bob, 500))));
        _record(string.concat(tag, "burn"), _txTo(t, alice, abi.encodeCall(h.burn, (bob, 100))));
        _record(string.concat(tag, "transferToHolder"), _transfer(t, alice, bob));
        _record(string.concat(tag, "transferToNewHolder"), _transfer(t, alice, carol));
        _txTo(t, alice, abi.encodeCall(h.setOperator, (operator, type(uint48).max)));
        (bytes32 hIn, bytes memory p) = _input(operator, t);
        _record(
            string.concat(tag, "transferFromByOperator"),
            _txTo(
                t,
                operator,
                abi.encodeWithSignature("confidentialTransferFrom(address,address,bytes32,bytes)", alice, bob, hIn, p)
            )
        );
        (hIn, p) = _input(alice, t);
        _record(
            string.concat(tag, "transferAndCallToEOA"),
            _txTo(
                t,
                alice,
                abi.encodeWithSignature("confidentialTransferAndCall(address,bytes32,bytes,bytes)", dave, hIn, p, "")
            )
        );
    }

    function _transfer(address t, address from, address to) internal returns (uint256) {
        (bytes32 h, bytes memory p) = _input(from, t);
        return _txTo(t, from, abi.encodeWithSignature("confidentialTransfer(address,bytes32,bytes)", to, h, p));
    }
}
