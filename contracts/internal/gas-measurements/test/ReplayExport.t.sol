// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {Vm} from "forge-std/Vm.sol";
import {ProbeArgs, IProbe} from "./ProbeArgs.sol";
import {ProbeList} from "../src/GasProbe.sol";
import {externalEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {FHERC20_Harness} from "@fhenixprotocol/confidential-contracts/test/FHERC20_Harness.sol";

/// Holds an FHERC20 balance and measures its own transfer call, so a transfer can be replayed
/// as a plain eth_call.
contract TransferMeter {
    function send(FHERC20_Harness token, address to, bytes32 h, bytes calldata proof) external returns (uint256 used) {
        uint256 g = gasleft();
        token.confidentialTransfer(to, externalEuint64.wrap(h), proof);
        used = g - gasleft();
    }
}

/// Exports every probe row, and two FHERC20 transfers, as replayable eth_calls: the calldata signed
/// for each target chain, and the exact accounts and pre-call storage the call touches on a Sepolia
/// fork. script/replay.py sends them to real nodes with that state as an override, so each node's
/// own EVM (geth, Arbitrum Nitro) measures the call. Skipped unless REPLAY_EXPORT=true; one test per probe contract.
contract ReplayExportTest is ProbeArgs {
    // Ethereum, Arbitrum One, Sepolia, Arbitrum Sepolia.
    uint256[4] internal TARGETS = [uint256(1), 42161, 11155111, 421614];
    uint256 constant PROBE_CONTRACTS = 11;

    mapping(bytes32 => uint256) internal seenInRow;
    mapping(address => bool) internal codeWritten;
    uint256 internal rowNumber;
    string internal rowsFile;
    string internal codesFile;

    // One test per probe contract keeps each test's memory small; each writes its own files.
    function test_export00() public {
        _exportProbe(0);
    }

    function test_export01() public {
        _exportProbe(1);
    }

    function test_export02() public {
        _exportProbe(2);
    }

    function test_export03() public {
        _exportProbe(3);
    }

    function test_export04() public {
        _exportProbe(4);
    }

    function test_export05() public {
        _exportProbe(5);
    }

    function test_export06() public {
        _exportProbe(6);
    }

    function test_export07() public {
        _exportProbe(7);
    }

    function test_export08() public {
        _exportProbe(8);
    }

    function test_export09() public {
        _exportProbe(9);
    }

    function test_export10() public {
        _exportProbe(10);
    }

    function test_exportTransfers() public {
        if (!_start("transfers")) return;
        _exportTransfers();
    }

    function test_probeContractCount() public pure {
        assertEq(ProbeList.names().length, PROBE_CONTRACTS, "add or remove a test_exportNN function");
    }

    function _start(string memory name) internal returns (bool) {
        vm.skip(!vm.envOr("REPLAY_EXPORT", false));
        _fork("sepolia");
        _takeOverSigners();
        rowsFile = string.concat("results/replay/rows-", name, ".jsonl");
        codesFile = string.concat("results/replay/codes-", name, ".jsonl");
        vm.writeFile(rowsFile, "");
        vm.writeFile(codesFile, "");
        return true;
    }

    function _exportProbe(uint256 index) internal {
        string memory name = ProbeList.names()[index];
        if (!_start(name)) return;
        address probe = deployCode(string.concat("GasProbe.sol:", name));
        IProbe(probe).setup();
        (string[] memory ids, uint8[] memory kinds, uint8[] memory utypes, uint8[] memory sizes) =
            IProbe(probe).rowSpecs();
        for (uint256 i = 0; i < ids.length; i++) {
            bytes[4] memory data;
            for (uint256 c = 0; c < 4; c++) {
                vm.chainId(TARGETS[c]);
                data[c] = abi.encodeWithSignature(
                    string.concat(ids[i], "(bytes)"), _args(probe, ids[i], kinds[i], utypes[i], sizes[i])
                );
            }
            vm.chainId(11155111);
            _exportCall(ids[i], probe, data);
        }
    }

    function _exportTransfers() internal {
        TransferMeter meter = new TransferMeter();
        FHERC20_Harness token = new FHERC20_Harness("Gas", "GAS", 6, "");
        token.mint(address(meter), 1_000_000);
        token.mint(address(0xB0B), 1_000);
        _exportTransfer("fherc20.transferToHolder", meter, token, address(0xB0B));
        _exportTransfer("fherc20.transferToNewHolder", meter, token, address(0xCA201));
    }

    function _exportTransfer(string memory id, TransferMeter meter, FHERC20_Harness token, address to) internal {
        uint256[] memory hashes = new uint256[](1);
        uint8[] memory utypes = new uint8[](1);
        hashes[0] = uint256(keccak256(abi.encode(id)));
        utypes[0] = 5; // euint64
        bytes[4] memory data;
        for (uint256 c = 0; c < 4; c++) {
            vm.chainId(TARGETS[c]);
            data[c] = abi.encodeCall(
                meter.send, (token, to, bytes32(hashes[0]), _signInputs(hashes, utypes, address(meter), address(token)))
            );
        }
        vm.chainId(11155111);
        _exportCall(id, address(meter), data);
    }

    // Runs the call on the fork (so later rows see its effects) and records what it touched.
    function _exportCall(string memory id, address to, bytes[4] memory data) internal {
        rowNumber++;
        vm.startStateDiffRecording();
        (bool ok, bytes memory ret) = to.call(data[2]);
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        if (!ok) {
            emit log_named_string("row failed", id);
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }

        string memory storageJson = "";
        string memory accountsJson = "";
        for (uint256 i = 0; i < accesses.length; i++) {
            address account = accesses[i].account;
            if (_skip(account)) continue;
            bytes32 accountKey = keccak256(abi.encode(account));
            if (seenInRow[accountKey] != rowNumber) {
                seenInRow[accountKey] = rowNumber;
                accountsJson = _append(accountsJson, string.concat('"', vm.toString(account), '"'));
                _writeCode(account);
            }
            for (uint256 j = 0; j < accesses[i].storageAccesses.length; j++) {
                Vm.StorageAccess memory s = accesses[i].storageAccesses[j];
                if (_skip(s.account)) continue;
                bytes32 key = keccak256(abi.encode(s.account, s.slot));
                if (seenInRow[key] == rowNumber) continue;
                seenInRow[key] = rowNumber;
                // The first access of a slot in this call holds its value before the call.
                storageJson = _append(
                    storageJson,
                    string.concat(
                        '["',
                        vm.toString(s.account),
                        '","',
                        vm.toString(s.slot),
                        '","',
                        vm.toString(s.previousValue),
                        '"]'
                    )
                );
            }
        }
        string memory line = string.concat(
            '{"id":"', id, '","from":"', vm.toString(address(this)), '","to":"', vm.toString(to), '","data":{'
        );
        for (uint256 c = 0; c < 4; c++) {
            line =
                string.concat(line, c == 0 ? "" : ",", '"', vm.toString(TARGETS[c]), '":"', vm.toString(data[c]), '"');
        }
        line = string.concat(line, '},"accounts":[', accountsJson);
        vm.writeLine(rowsFile, string.concat(line, '],"storage":[', storageJson, "]}"));
    }

    function _writeCode(address account) internal {
        if (codeWritten[account] || account.code.length == 0) return;
        codeWritten[account] = true;
        vm.writeLine(
            codesFile,
            string.concat('{"address":"', vm.toString(account), '","code":"', vm.toString(account.code), '"}')
        );
    }

    // Cheatcodes, the console, precompiles and this test contract are not part of the replayed state.
    function _skip(address a) internal view returns (bool) {
        return
            a == address(vm) || a == 0x000000000000000000636F6e736F6c652e6c6f67 || uint160(a) < 0x100
                || a == address(this);
    }

    function _append(string memory list, string memory item) internal pure returns (string memory) {
        return bytes(list).length == 0 ? item : string.concat(list, ",", item);
    }
}
