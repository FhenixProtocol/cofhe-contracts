// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {TokenGasBase} from "./TokenGasBase.sol";
import {FHERC20_Harness} from "@fhenixprotocol/confidential-contracts/test/FHERC20_Harness.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Plain OpenZeppelin ERC20, measured as the baseline for the confidential token numbers.
contract PlainToken is ERC20 {
    constructor() ERC20("Plain", "PLN") {}

    function mint(address to, uint256 value) external {
        _mint(to, value);
    }
}

/// Measures whole FHERC20 transactions on a fork and writes results/fherc20-<chain>.json.
contract Fherc20GasTest is TokenGasBase {
    string constant SOURCE_COMMIT = "5138cb8644b19b24a75caf3f383a17457e823e16";

    FHERC20_Harness token;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address operator = makeAddr("operator");

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
        address t = address(token);

        _record("transferToHolder", _transfer(alice, bob));
        _record("transferToNewHolder", _transfer(alice, carol));
        _record("transferAgain", _transfer(alice, bob));
        _record("setOperator", _txTo(t, alice, abi.encodeCall(token.setOperator, (operator, type(uint48).max))));
        (bytes32 h, bytes memory p) = _input(operator, t);
        _record(
            "transferFromByOperator",
            _txTo(
                t,
                operator,
                abi.encodeWithSignature("confidentialTransferFrom(address,address,bytes32,bytes)", alice, bob, h, p)
            )
        );

        PlainToken plain = new PlainToken();
        plain.mint(alice, 1_000_000);
        plain.mint(bob, 1_000);
        _record("erc20TransferToHolder", _txTo(address(plain), alice, abi.encodeCall(plain.transfer, (bob, 7))));
        _record("erc20TransferToNewHolder", _txTo(address(plain), alice, abi.encodeCall(plain.transfer, (carol, 7))));

        _write(chain, file, SOURCE_COMMIT);
    }

    function _transfer(address from, address to) internal returns (uint256) {
        (bytes32 h, bytes memory p) = _input(from, address(token));
        return
            _txTo(
                address(token), from, abi.encodeWithSignature("confidentialTransfer(address,bytes32,bytes)", to, h, p)
            );
    }
}
