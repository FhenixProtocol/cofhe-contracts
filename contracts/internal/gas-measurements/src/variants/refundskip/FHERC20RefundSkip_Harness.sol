// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { FHERC20RefundSkip } from "./FHERC20RefundSkip.sol";

/// Variant D alone: skips the zero refund of transferAndCall when the recipient has no code.
contract FHERC20RefundSkip_Harness is FHERC20RefundSkip {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        string memory contractURI_
    ) FHERC20RefundSkip(name_, symbol_, decimals_, contractURI_) {}

    function mint(address account, uint64 value) public {
        _mint(account, FHE.asEuint64(value));
    }

    function burn(address account, uint64 value) public {
        _burn(account, FHE.asEuint64(value));
    }
}
