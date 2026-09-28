// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.27;

import {ZamaForkBase, IExecutor} from "./ZamaForkBase.sol";
import {ZamaProbe} from "../src/ZamaProbe.sol";
import {ZamaToken} from "../src/ZamaToken.sol";

interface IVersioned {
    function getVersion() external view returns (string memory);
}

/// Runs every Zama probe row and the ERC7984 token flows on a fork; writes results/zama-<chain>.json.
/// Needs `isolate = true`: each call is its own transaction. Token rows are whole-transaction gas
/// (21,000 + calldata + execution); probe rows are the gasleft() delta around one FHE call.
contract ZamaGasTest is ZamaForkBase {
    address constant MAINNET_EXECUTOR = 0xD82385dADa1ae3E969447f20A3164F6213100e75;
    address constant SEPOLIA_EXECUTOR = 0x92C920834Ec8941d2C77D188936E1f7A6f49c127;
    uint8 constant K_INPUT = 1;

    string ops;
    string tokenRows;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address operator = makeAddr("operator");

    function test_mainnet() public {
        _run("mainnet", MAINNET_EXECUTOR, "results/zama-mainnet.json");
    }

    function test_sepolia() public {
        _run("sepolia", SEPOLIA_EXECUTOR, "results/zama-sepolia.json");
    }

    function _run(string memory chain, address executorAddress, string memory file) internal {
        _fork(chain, executorAddress);
        _takeOverSigners();
        _measureProbe();
        _measureToken();

        string memory root = "root";
        vm.serializeString(root, "chain", chain);
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "forkBlock", forkBlock);
        vm.serializeUint(root, "inputSignatures", threshold);
        _contract(root, "executor", address(executor));
        _contract(root, "acl", acl);
        _contract(root, "inputVerifier", address(verifier));
        _contract(root, "hcuLimit", executor.getHCULimitAddress());
        vm.serializeString(root, "ops", ops);
        vm.writeJson(vm.serializeString(root, "token", tokenRows), file);
    }

    function _contract(string memory root, string memory key, address proxy) internal {
        string memory o = vm.serializeAddress(key, "proxy", proxy);
        o = vm.serializeAddress(key, "impl", _impl(proxy));
        vm.serializeString(root, key, vm.serializeString(key, "version", IVersioned(proxy).getVersion()));
    }

    function _measureProbe() internal {
        ZamaProbe probe = new ZamaProbe();
        probe.setup();
        (string[] memory ids, string[] memory fns, uint8[] memory kinds) = probe.rowSpecs();
        for (uint256 i = 0; i < ids.length; i++) {
            bytes memory args;
            if (kinds[i] == K_INPUT) {
                (bytes32 h1, bytes memory p1) = _input(address(this), address(probe));
                (bytes32 h2, bytes memory p2) = _input(address(this), address(probe));
                args = abi.encode(h1, p1, h2, p2);
            }
            (bool ok, bytes memory ret) =
                address(probe).call(abi.encodeWithSignature(string.concat(fns[i], "(bytes)"), args));
            if (!ok) {
                emit log_named_string("row failed", ids[i]);
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            (uint256 first, uint256 extra) = abi.decode(ret, (uint256, uint256));
            assertGt(first, 0, ids[i]);
            vm.serializeUint(ids[i], "first", first);
            ops = vm.serializeString("ops", ids[i], vm.serializeUint(ids[i], "extra", extra));
        }
    }

    function _measureToken() internal {
        ZamaToken token = new ZamaToken();
        address t = address(token);
        token.mint(alice, 1_000_000);
        token.mint(bob, 1_000);
        _recordToken("transferToHolder", _transfer(t, alice, bob));
        _recordToken("transferToNewHolder", _transfer(t, alice, carol));
        _recordToken("transferAgain", _transfer(t, alice, bob));
        _recordToken("setOperator", _txTo(t, alice, abi.encodeCall(token.setOperator, (operator, type(uint48).max))));
        (bytes32 h, bytes memory p) = _input(operator, t);
        _recordToken(
            "transferFromByOperator",
            _txTo(
                t,
                operator,
                abi.encodeWithSignature("confidentialTransferFrom(address,address,bytes32,bytes)", alice, bob, h, p)
            )
        );
    }

    function _transfer(address t, address from, address to) internal returns (uint256) {
        (bytes32 h, bytes memory p) = _input(from, t);
        return _txTo(t, from, abi.encodeWithSignature("confidentialTransfer(address,bytes32,bytes)", to, h, p));
    }

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

    function _recordToken(string memory id, uint256 gas) internal {
        assertGt(gas, 21_000, id);
        tokenRows = vm.serializeUint("token", id, gas);
    }
}
