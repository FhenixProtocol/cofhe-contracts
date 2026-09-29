// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, ebool, euint64, sharedEbool } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { FHEConstants } from "./FHEConstants.sol";

import { IERC7984Receiver } from "@fhenixprotocol/confidential-contracts/interfaces/IERC7984Receiver.sol";
import { FHERC20InvalidReceiver } from "@fhenixprotocol/confidential-contracts/FHERC20/utils/FHERC20Errors.sol";

/// @dev Library that provides common {FHERC20} utility functions.
library FHERC20UtilsConstants {
    /**
     * @dev Performs a transfer callback to the recipient of the transfer `to`. Should be invoked
     * after all transfers "withCallback" on a {FHERC20}.
     *
     * The transfer callback is not invoked on the recipient if the recipient has no code (i.e. is an EOA). If the
     * recipient has non-zero code, it must implement
     * {IERC7984Receiver-onConfidentialTransferReceived} and return a `sharedEbool` indicating
     * whether the transfer was accepted or not. If the decoded `ebool` is `false`, the transfer
     * function should try to refund the `from` address.
     *
     * Both encrypted values crossing this boundary are directed shares (see {IERC7984Receiver}):
     * `amount` is shared to `to`, and the returned flag is consumed with
     * `receiveEboolFromCall(_, to)` so that only a value `to` itself handed back is accepted.
     * Returns a plain `ebool` so callers are unaffected by the boundary's typing.
     */
    function checkOnTransferReceived(
        address operator,
        address from,
        address to,
        euint64 amount,
        bytes calldata data
    ) internal returns (ebool) {
        if (to.code.length > 0) {
            // `shareEuint64` grants `to` transient access itself and records this contract as the
            // sharer, so no separate `allowTransient` is needed. It reverts `SenderNotAllowed` if
            // we do not hold `amount`: you cannot share what you cannot use.
            try
                IERC7984Receiver(to).onConfidentialTransferReceived(operator, from, FHE.shareEuint64(amount, to), data)
            returns (sharedEbool retval) {
                // `to` is the address called immediately above, which is what makes this the
                // correct receive form: it checks who HANDED the value over, not merely who
                // created the share. Naming any other address would be exploitable.
                return FHE.receiveEboolFromCall(retval, to);
            } catch (bytes memory reason) {
                if (reason.length == 0) {
                    revert FHERC20InvalidReceiver(to);
                } else {
                    assembly ("memory-safe") {
                        revert(add(32, reason), mload(reason))
                    }
                }
            }
        } else {
            // No callback to make, so nothing was shared and there is nothing to receive.
            return FHEConstants.trueEbool();
        }
    }
}
