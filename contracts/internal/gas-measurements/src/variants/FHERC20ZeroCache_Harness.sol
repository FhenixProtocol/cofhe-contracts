// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { FHERC20ZeroCache } from "./FHERC20ZeroCache.sol";

contract FHERC20ZeroCache_Harness is FHERC20ZeroCache {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        string memory contractURI_
    ) FHERC20ZeroCache(name_, symbol_, decimals_, contractURI_) {}

    function mint(address account, uint64 value) public {
        _mint(account, FHE.asEuint64(value));
    }

    function burn(address account, uint64 value) public {
        _burn(account, FHE.asEuint64(value));
    }
}
