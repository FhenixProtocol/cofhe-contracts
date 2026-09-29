// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { IERC165 } from "@openzeppelin/contracts/interfaces/IERC165.sol";
import { ERC165 } from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import { IFHERC20, IERC7984 } from "@fhenixprotocol/confidential-contracts/interfaces/IFHERC20.sol";
import { FHERC20CoreZeroCache } from "./FHERC20CoreZeroCache.sol";

/**
 * @dev Reference implementation for {IFHERC20} — constructor-based host over {FHERC20Core}.
 *
 * All FHERC20 logic (encrypted balances/transfers, operators, indicator view layer, disclosure)
 * lives in {FHERC20Core}, shared with {FHERC20Upgradeable}. This contract only guards one-time
 * setup with a constructor and supplies the ERC-165 answers.
 *
 * See {FHERC20Core} for the full behavioral documentation.
 */
abstract contract FHERC20ZeroCache is Context, ERC165, FHERC20CoreZeroCache {
    constructor(string memory name_, string memory symbol_, uint8 decimals_, string memory contractURI_) {
        __FHERC20Core_init(name_, symbol_, decimals_, contractURI_);
    }

    // =========================================================================
    //  ERC-165
    // =========================================================================

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(IERC165, ERC165) returns (bool) {
        return
            interfaceId == type(IFHERC20).interfaceId ||
            interfaceId == type(IERC7984).interfaceId ||
            interfaceId == type(IERC20).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
