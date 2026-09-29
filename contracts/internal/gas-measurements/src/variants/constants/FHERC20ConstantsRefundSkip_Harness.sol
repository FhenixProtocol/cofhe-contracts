// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64, ebool } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { FHERC20ConstantsRefundSkip } from "./FHERC20ConstantsRefundSkip.sol";
import { FHEConstants } from "./FHEConstants.sol";


/// Variant D on top of A: constants (allowThis) + refund skip for recipients with no code.
contract FHERC20ConstantsRefundSkip_Harness is FHERC20ConstantsRefundSkip {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        string memory contractURI_
    ) FHERC20ConstantsRefundSkip(name_, symbol_, decimals_, contractURI_) {
        // The trivial encrypts make the handles transiently usable, so allowThis can persist them.
        euint64 zero = FHE.asEuint64(0);
        ebool yes = FHE.asEbool(true);
        require(euint64.unwrap(zero) == FHEConstants.ZERO_EUINT64_HANDLE, "zero handle mismatch");
        require(ebool.unwrap(yes) == FHEConstants.TRUE_EBOOL_HANDLE, "true handle mismatch");
        FHE.allowThis(zero);
        FHE.allowThis(yes);
    }

    function mint(address account, uint64 value) public {
        _mint(account, FHE.asEuint64(value));
    }

    function burn(address account, uint64 value) public {
        _burn(account, FHE.asEuint64(value));
    }
}
