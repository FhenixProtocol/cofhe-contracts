// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;

/// @notice Stand-in for an address book whose `getTm` fails for a reason other than an unset id.
contract RevertingAddressBook {
    error Boom();

    address public owner;

    function getTm(uint256) external pure returns (address) {
        revert Boom();
    }
}
