// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {TM} from "./ForkBase.sol";
import {ProbeArgs, IProbe} from "./ProbeArgs.sol";
import {ProbeList} from "../src/GasProbe.sol";

/// Runs every probe row on a fork and writes results/<chain>.json.
/// Needs `isolate = true` (foundry.toml): each probe call is then its own transaction,
/// so "first" starts from cold TaskManager and ACL state.
contract MeasureGasTest is ProbeArgs {
    string rows;

    function test_sepolia() public {
        _run("sepolia", "results/sepolia.json");
    }

    function test_arbitrumSepolia() public {
        _run("arbitrumSepolia", "results/arbitrum-sepolia.json");
    }

    function _run(string memory chain, string memory file) internal {
        _fork(chain);
        _takeOverSigners();
        string[] memory names = ProbeList.names();
        for (uint256 p = 0; p < names.length; p++) {
            address probe = deployCode(string.concat("GasProbe.sol:", names[p]));
            IProbe(probe).setup();
            _measureAll(probe);
        }
        string memory root = "root";
        vm.serializeString(root, "chain", chain);
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "forkBlock", forkBlock);
        vm.serializeUint(root, "tmVersion", tm.getVersion());
        vm.serializeAddress(root, "tmImpl", _impl(TM));
        vm.serializeAddress(root, "acl", acl);
        vm.serializeAddress(root, "aclImpl", _impl(acl));
        address plaintexts = tm.plaintextsStorage();
        vm.serializeAddress(root, "plaintextsStorage", plaintexts);
        vm.serializeAddress(root, "plaintextsStorageImpl", _impl(plaintexts));
        vm.writeJson(vm.serializeString(root, "rows", rows), file);
    }

    function _measureAll(address probe) internal {
        (string[] memory ids, uint8[] memory kinds, uint8[] memory utypes, uint8[] memory sizes) =
            IProbe(probe).rowSpecs();
        for (uint256 i = 0; i < ids.length; i++) {
            bytes memory args = _args(probe, ids[i], kinds[i], utypes[i], sizes[i]);
            (bool ok, bytes memory ret) = probe.call(abi.encodeWithSignature(string.concat(ids[i], "(bytes)"), args));
            if (!ok) {
                emit log_named_string("row failed", ids[i]);
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            (uint256 first, uint256 extra) = abi.decode(ret, (uint256, uint256));
            assertGt(first, 0, ids[i]);
            vm.serializeUint(ids[i], "first", first);
            rows = vm.serializeString("rows", ids[i], vm.serializeUint(ids[i], "extra", extra));
        }
    }
}
