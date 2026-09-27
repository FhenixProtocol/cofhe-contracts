// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {ForkBase, TM} from "./ForkBase.sol";
import {FHERC20_Harness} from "@fhenixprotocol/confidential-contracts/test/FHERC20_Harness.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Plain OpenZeppelin ERC20, measured as the baseline for the FHERC20 numbers.
contract PlainToken is ERC20 {
    constructor() ERC20("Plain", "PLN") {}

    function mint(address to, uint256 value) external {
        _mint(to, value);
    }
}

/// Measures whole FHERC20 transactions on a fork and writes results/fherc20-<chain>.json.
/// Needs `isolate = true`: each token call is then its own transaction, and the gasleft() delta
/// around it is the full transaction gas (21,000 intrinsic + calldata + execution).
contract Fherc20GasTest is ForkBase {
    uint8 constant EUINT64 = 5;

    FHERC20_Harness token;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address operator = makeAddr("operator");
    string results;
    uint256 nonce;

    function test_sepolia() public {
        _run("sepolia", "results/fherc20-sepolia.json");
    }

    function test_arbitrumSepolia() public {
        _run("arbitrumSepolia", "results/fherc20-arbitrum-sepolia.json");
    }

    function _run(string memory chain, string memory file) internal {
        _fork(chain);
        _takeOverSigners();
        token = new FHERC20_Harness("Gas", "GAS", 6, "");
        token.mint(alice, 1_000_000);
        token.mint(bob, 1_000);

        (bytes32 h, bytes memory p) = _input(alice);
        _record("transferToHolder", _transfer(alice, bob, h, p));
        (h, p) = _input(alice);
        _record("transferToNewHolder", _transfer(alice, carol, h, p));
        (h, p) = _input(alice);
        _record("transferAgain", _transfer(alice, bob, h, p));

        _record("setOperator", _tx(alice, abi.encodeCall(token.setOperator, (operator, type(uint48).max))));
        (h, p) = _input(operator);
        _record(
            "transferFromByOperator",
            _tx(
                operator,
                abi.encodeWithSignature("confidentialTransferFrom(address,address,bytes32,bytes)", alice, bob, h, p)
            )
        );

        PlainToken plain = new PlainToken();
        plain.mint(alice, 1_000_000);
        plain.mint(bob, 1_000);
        _record("erc20TransferToHolder", _txTo(address(plain), alice, abi.encodeCall(plain.transfer, (bob, 7))));
        _record("erc20TransferToNewHolder", _txTo(address(plain), alice, abi.encodeCall(plain.transfer, (carol, 7))));

        vm.serializeString("root", "chain", chain);
        vm.serializeUint("root", "forkBlock", forkBlock);
        vm.serializeAddress("root", "tmImpl", _impl(TM));
        vm.serializeAddress("root", "aclImpl", _impl(acl));
        vm.serializeAddress("root", "plaintextsStorageImpl", _impl(tm.plaintextsStorage()));
        vm.serializeString("root", "fherc20Commit", "5138cb8644b19b24a75caf3f383a17457e823e16");
        vm.writeJson(vm.serializeString("root", "rows", results), file);
    }

    function _transfer(address from, address to, bytes32 h, bytes memory p) internal returns (uint256) {
        return _tx(from, abi.encodeWithSignature("confidentialTransfer(address,bytes32,bytes)", to, h, p));
    }

    // Calldata is encoded before the measurement, so the delta holds only the transaction.
    function _tx(address from, bytes memory data) internal returns (uint256) {
        return _txTo(address(token), from, data);
    }

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
    function _input(address sender) internal returns (bytes32, bytes memory) {
        uint256[] memory hashes = new uint256[](1);
        uint8[] memory utypes = new uint8[](1);
        hashes[0] = uint256(keccak256(abi.encode("fherc20", nonce++)));
        utypes[0] = EUINT64;
        return (bytes32(hashes[0]), _signInputs(hashes, utypes, sender, address(token)));
    }

    function _record(string memory id, uint256 gas) internal {
        assertGt(gas, 21_000, id);
        results = vm.serializeUint("rows", id, gas);
    }
}
