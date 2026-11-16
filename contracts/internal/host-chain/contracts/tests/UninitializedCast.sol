// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

import {FHE, ebool, euint8, euint32, euint64, euint128, eaddress} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * Casts a handle that was never written (a zero handle) and compares the result with the cast of
 * an explicit encrypted zero of the same source type.
 *
 * The arithmetic, comparison, bitwise and select helpers in FHE.sol replace an uninitialized operand
 * with an encrypted zero before creating the task. The `asEuintN` casts from ebool, euintN and
 * eaddress (and the `toU*` bindings that forward to them) do the same, so a mapping slot that was
 * never written casts like a zero instead of reverting with ACLNotAllowed(0, caller).
 *
 * Handles are content-addressed -- TaskManager derives them from the operands and the function id,
 * with no nonce -- so "casts an encrypted zero" means exactly "returns the same handle as casting
 * FHE.asEuintM(0)". Each probe emits both handles and requires them to match.
 *
 * The mappings below are never written; every read returns the zero handle.
 */
contract UninitializedCast {
    mapping(address => euint32) internal balances32;
    mapping(address => euint64) internal balances64;
    mapping(address => ebool) internal flags;
    mapping(address => eaddress) internal owners;

    event Cast(string label, bytes32 got, bytes32 want);

    function _check(string memory label, bytes32 got, bytes32 want) private {
        emit Cast(label, got, want);
        require(got == want, label);
    }

    /// euint32 -> euint64
    function upcast(address user) external {
        bytes32 got = euint64.unwrap(FHE.asEuint64(balances32[user]));
        bytes32 want = euint64.unwrap(FHE.asEuint64(FHE.asEuint32(0)));
        _check("upcast", got, want);
    }

    /// euint64 -> euint8
    function downcast(address user) external {
        bytes32 got = euint8.unwrap(FHE.asEuint8(balances64[user]));
        bytes32 want = euint8.unwrap(FHE.asEuint8(FHE.asEuint64(0)));
        _check("downcast", got, want);
    }

    /// euint64.toU128(), which forwards to FHE.asEuint128(euint64)
    function binding(address user) external {
        bytes32 got = euint128.unwrap(balances64[user].toU128());
        bytes32 want = euint128.unwrap(FHE.asEuint128(FHE.asEuint64(0)));
        _check("binding", got, want);
    }

    /// ebool -> euint32; an uninitialized ebool casts as an encrypted false
    function fromBool(address user) external {
        bytes32 got = euint32.unwrap(FHE.asEuint32(flags[user]));
        bytes32 want = euint32.unwrap(FHE.asEuint32(FHE.asEbool(false)));
        _check("fromBool", got, want);
    }

    /// eaddress -> euint128; an uninitialized eaddress casts as an encrypted address(0)
    function fromAddress(address user) external {
        bytes32 got = euint128.unwrap(FHE.asEuint128(owners[user]));
        bytes32 want = euint128.unwrap(FHE.asEuint128(FHE.asEaddress(address(0))));
        _check("fromAddress", got, want);
    }

    /// Reference: `add` already treats an uninitialized operand as an encrypted zero.
    function add(address user) external {
        bytes32 got = euint64.unwrap(FHE.add(balances64[user], balances64[user]));
        bytes32 want = euint64.unwrap(FHE.add(FHE.asEuint64(0), FHE.asEuint64(0)));
        _check("add", got, want);
    }

    /// Control: an initialized value is cast as itself, not replaced by zero.
    function initialized(uint32 value) external {
        bytes32 got = euint64.unwrap(FHE.asEuint64(FHE.asEuint32(value)));
        bytes32 want = euint64.unwrap(FHE.asEuint64(FHE.asEuint32(0)));
        emit Cast("initialized", got, want);
    }
}
