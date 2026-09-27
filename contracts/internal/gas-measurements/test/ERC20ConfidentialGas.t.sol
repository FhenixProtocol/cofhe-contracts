// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {TokenGasBase} from "./TokenGasBase.sol";
import {MockERC20Confidential} from "@fhenixprotocol/confidential-contracts/test/MockERC20Confidential.sol";

/// Exposes the internal observer setter, so the observer path can be measured.
contract ObservableToken is MockERC20Confidential {
    constructor() MockERC20Confidential("Hybrid", "HYB", 6) {}

    function setObserver(address observer) external {
        _setObserver(observer);
    }
}

/// Measures whole ERC20Confidential (hybrid public + confidential) transactions on a fork and
/// writes results/erc20confidential-<chain>.json. forge links ERC20ConfidentialLib automatically.
contract ERC20ConfidentialGasTest is TokenGasBase {
    string constant SOURCE_COMMIT = "5138cb8644b19b24a75caf3f383a17457e823e16";

    ObservableToken token;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address operator = makeAddr("operator");
    address observer = makeAddr("observer");

    function test_sepolia() public {
        _run("sepolia", "results/erc20confidential-sepolia.json");
    }

    function test_arbitrumSepolia() public {
        _run("arbitrumSepolia", "results/erc20confidential-arbitrum-sepolia.json");
    }

    function _run(string memory chain, string memory file) internal {
        _fork(chain);
        _takeOverSigners();
        token = new ObservableToken();
        token.mint(alice, 1_000_000);
        // bob keeps a public balance after shielding, so the public transfer to him is to a holder.
        token.mint(bob, 2_000);
        address t = address(token);

        _record("shield", _txTo(t, alice, abi.encodeWithSignature("shield(uint256)", 500_000)));
        _txTo(t, bob, abi.encodeWithSignature("shield(uint256)", 1_000));

        _record("confidentialTransferToHolder", _transfer(alice, bob));
        _record("confidentialTransferToNewHolder", _transfer(alice, carol));

        _record("setOperator", _txTo(t, alice, abi.encodeCall(token.setOperator, (operator, type(uint48).max))));
        (bytes32 h, bytes memory p) = _input(operator, t);
        _record(
            "confidentialTransferFromByOperator",
            _txTo(
                t,
                operator,
                abi.encodeWithSignature("confidentialTransferFrom(address,address,bytes32,bytes)", alice, bob, h, p)
            )
        );

        _record("publicTransferToHolder", _txTo(t, alice, abi.encodeWithSignature("transfer(address,uint256)", bob, 7)));
        _record(
            "publicTransferToNewHolder", _txTo(t, alice, abi.encodeWithSignature("transfer(address,uint256)", dave, 7))
        );

        token.setObserver(observer);
        _record("confidentialTransferToHolderWithObserver", _transfer(alice, bob));

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
