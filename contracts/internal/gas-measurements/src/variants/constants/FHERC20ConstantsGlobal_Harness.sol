// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { FHERC20Constants } from "./FHERC20Constants.sol";
import { FHEConstants } from "./FHEConstants.sol";


/// Constants variant B: relies on a one-time chain-wide allowGlobal of each constant; no per-token setup.
contract FHERC20ConstantsGlobal_Harness is FHERC20Constants {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        string memory contractURI_
    ) FHERC20Constants(name_, symbol_, decimals_, contractURI_) {}

    function mint(address account, uint64 value) public {
        _mint(account, FHE.asEuint64(value));
    }

    function burn(address account, uint64 value) public {
        _burn(account, FHE.asEuint64(value));
    }
}
