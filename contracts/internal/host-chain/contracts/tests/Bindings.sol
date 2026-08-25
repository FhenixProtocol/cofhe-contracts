// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

import {FHE, ebool, euint8, euint16, euint32, euint64, euint128, eaddress} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * Pins every value-returning binding in FHE.sol against its free-function form.
 *
 * Handles are content-addressed -- TaskManager derives them as
 * keccak256(operands || funcId) with no nonce -- so `ea.div(eb)` and `FHE.div(ea, eb)`
 * must produce the same handle. A forwarder that calls the wrong FHE function, or
 * swaps its operands, yields a different handle and reverts here.
 *
 * Operands must stay distinct at the call site so an operand swap is observable.
 * `unwrap` is the built-in value-type unwrap, never the Bindings one, so the
 * assertion never depends on a forwarder it is testing.
 */
contract Bindings {
    function bindingsBool(bool a, bool b) public {
        ebool ea = FHE.asEbool(a);
        ebool eb = FHE.asEbool(b);

        // comparison
        require(ebool.unwrap(ea.eq(eb)) == ebool.unwrap(FHE.eq(ea, eb)), "ebool.eq");
        require(ebool.unwrap(ea.ne(eb)) == ebool.unwrap(FHE.ne(ea, eb)), "ebool.ne");

        // bitwise / shift
        require(ebool.unwrap(ea.not()) == ebool.unwrap(FHE.not(ea)), "ebool.not");
        require(ebool.unwrap(ea.and(eb)) == ebool.unwrap(FHE.and(ea, eb)), "ebool.and");
        require(ebool.unwrap(ea.or(eb)) == ebool.unwrap(FHE.or(ea, eb)), "ebool.or");
        require(ebool.unwrap(ea.xor(eb)) == ebool.unwrap(FHE.xor(ea, eb)), "ebool.xor");

        // casts
        require(euint8.unwrap(ea.toU8()) == euint8.unwrap(FHE.asEuint8(ea)), "ebool.toU8");
        require(euint16.unwrap(ea.toU16()) == euint16.unwrap(FHE.asEuint16(ea)), "ebool.toU16");
        require(euint32.unwrap(ea.toU32()) == euint32.unwrap(FHE.asEuint32(ea)), "ebool.toU32");
        require(euint64.unwrap(ea.toU64()) == euint64.unwrap(FHE.asEuint64(ea)), "ebool.toU64");
        require(euint128.unwrap(ea.toU128()) == euint128.unwrap(FHE.asEuint128(ea)), "ebool.toU128");
    }

    function bindings8(uint8 a, uint8 b) public {
        euint8 ea = FHE.asEuint8(a);
        euint8 eb = FHE.asEuint8(b);

        // arithmetic
        require(euint8.unwrap(ea.add(eb)) == euint8.unwrap(FHE.add(ea, eb)), "euint8.add");
        require(euint8.unwrap(ea.mul(eb)) == euint8.unwrap(FHE.mul(ea, eb)), "euint8.mul");
        require(euint8.unwrap(ea.div(eb)) == euint8.unwrap(FHE.div(ea, eb)), "euint8.div");
        require(euint8.unwrap(ea.sub(eb)) == euint8.unwrap(FHE.sub(ea, eb)), "euint8.sub");
        require(euint8.unwrap(ea.rem(eb)) == euint8.unwrap(FHE.rem(ea, eb)), "euint8.rem");
        require(euint8.unwrap(ea.max(eb)) == euint8.unwrap(FHE.max(ea, eb)), "euint8.max");
        require(euint8.unwrap(ea.min(eb)) == euint8.unwrap(FHE.min(ea, eb)), "euint8.min");
        require(euint8.unwrap(ea.square()) == euint8.unwrap(FHE.square(ea)), "euint8.square");

        // comparison
        require(ebool.unwrap(ea.eq(eb)) == ebool.unwrap(FHE.eq(ea, eb)), "euint8.eq");
        require(ebool.unwrap(ea.ne(eb)) == ebool.unwrap(FHE.ne(ea, eb)), "euint8.ne");
        require(ebool.unwrap(ea.gt(eb)) == ebool.unwrap(FHE.gt(ea, eb)), "euint8.gt");
        require(ebool.unwrap(ea.gte(eb)) == ebool.unwrap(FHE.gte(ea, eb)), "euint8.gte");
        require(ebool.unwrap(ea.lt(eb)) == ebool.unwrap(FHE.lt(ea, eb)), "euint8.lt");
        require(ebool.unwrap(ea.lte(eb)) == ebool.unwrap(FHE.lte(ea, eb)), "euint8.lte");

        // bitwise / shift
        require(euint8.unwrap(ea.not()) == euint8.unwrap(FHE.not(ea)), "euint8.not");
        require(euint8.unwrap(ea.and(eb)) == euint8.unwrap(FHE.and(ea, eb)), "euint8.and");
        require(euint8.unwrap(ea.or(eb)) == euint8.unwrap(FHE.or(ea, eb)), "euint8.or");
        require(euint8.unwrap(ea.xor(eb)) == euint8.unwrap(FHE.xor(ea, eb)), "euint8.xor");
        require(euint8.unwrap(ea.shl(eb)) == euint8.unwrap(FHE.shl(ea, eb)), "euint8.shl");
        require(euint8.unwrap(ea.shr(eb)) == euint8.unwrap(FHE.shr(ea, eb)), "euint8.shr");
        require(euint8.unwrap(ea.rol(eb)) == euint8.unwrap(FHE.rol(ea, eb)), "euint8.rol");
        require(euint8.unwrap(ea.ror(eb)) == euint8.unwrap(FHE.ror(ea, eb)), "euint8.ror");

        // casts
        require(ebool.unwrap(ea.toBool()) == ebool.unwrap(FHE.asEbool(ea)), "euint8.toBool");
        require(euint16.unwrap(ea.toU16()) == euint16.unwrap(FHE.asEuint16(ea)), "euint8.toU16");
        require(euint32.unwrap(ea.toU32()) == euint32.unwrap(FHE.asEuint32(ea)), "euint8.toU32");
        require(euint64.unwrap(ea.toU64()) == euint64.unwrap(FHE.asEuint64(ea)), "euint8.toU64");
        require(euint128.unwrap(ea.toU128()) == euint128.unwrap(FHE.asEuint128(ea)), "euint8.toU128");
    }

    function bindings16(uint16 a, uint16 b) public {
        euint16 ea = FHE.asEuint16(a);
        euint16 eb = FHE.asEuint16(b);

        // arithmetic
        require(euint16.unwrap(ea.add(eb)) == euint16.unwrap(FHE.add(ea, eb)), "euint16.add");
        require(euint16.unwrap(ea.mul(eb)) == euint16.unwrap(FHE.mul(ea, eb)), "euint16.mul");
        require(euint16.unwrap(ea.div(eb)) == euint16.unwrap(FHE.div(ea, eb)), "euint16.div");
        require(euint16.unwrap(ea.sub(eb)) == euint16.unwrap(FHE.sub(ea, eb)), "euint16.sub");
        require(euint16.unwrap(ea.rem(eb)) == euint16.unwrap(FHE.rem(ea, eb)), "euint16.rem");
        require(euint16.unwrap(ea.max(eb)) == euint16.unwrap(FHE.max(ea, eb)), "euint16.max");
        require(euint16.unwrap(ea.min(eb)) == euint16.unwrap(FHE.min(ea, eb)), "euint16.min");
        require(euint16.unwrap(ea.square()) == euint16.unwrap(FHE.square(ea)), "euint16.square");

        // comparison
        require(ebool.unwrap(ea.eq(eb)) == ebool.unwrap(FHE.eq(ea, eb)), "euint16.eq");
        require(ebool.unwrap(ea.ne(eb)) == ebool.unwrap(FHE.ne(ea, eb)), "euint16.ne");
        require(ebool.unwrap(ea.gt(eb)) == ebool.unwrap(FHE.gt(ea, eb)), "euint16.gt");
        require(ebool.unwrap(ea.gte(eb)) == ebool.unwrap(FHE.gte(ea, eb)), "euint16.gte");
        require(ebool.unwrap(ea.lt(eb)) == ebool.unwrap(FHE.lt(ea, eb)), "euint16.lt");
        require(ebool.unwrap(ea.lte(eb)) == ebool.unwrap(FHE.lte(ea, eb)), "euint16.lte");

        // bitwise / shift
        require(euint16.unwrap(ea.not()) == euint16.unwrap(FHE.not(ea)), "euint16.not");
        require(euint16.unwrap(ea.and(eb)) == euint16.unwrap(FHE.and(ea, eb)), "euint16.and");
        require(euint16.unwrap(ea.or(eb)) == euint16.unwrap(FHE.or(ea, eb)), "euint16.or");
        require(euint16.unwrap(ea.xor(eb)) == euint16.unwrap(FHE.xor(ea, eb)), "euint16.xor");
        require(euint16.unwrap(ea.shl(eb)) == euint16.unwrap(FHE.shl(ea, eb)), "euint16.shl");
        require(euint16.unwrap(ea.shr(eb)) == euint16.unwrap(FHE.shr(ea, eb)), "euint16.shr");
        require(euint16.unwrap(ea.rol(eb)) == euint16.unwrap(FHE.rol(ea, eb)), "euint16.rol");
        require(euint16.unwrap(ea.ror(eb)) == euint16.unwrap(FHE.ror(ea, eb)), "euint16.ror");

        // casts
        require(ebool.unwrap(ea.toBool()) == ebool.unwrap(FHE.asEbool(ea)), "euint16.toBool");
        require(euint8.unwrap(ea.toU8()) == euint8.unwrap(FHE.asEuint8(ea)), "euint16.toU8");
        require(euint32.unwrap(ea.toU32()) == euint32.unwrap(FHE.asEuint32(ea)), "euint16.toU32");
        require(euint64.unwrap(ea.toU64()) == euint64.unwrap(FHE.asEuint64(ea)), "euint16.toU64");
        require(euint128.unwrap(ea.toU128()) == euint128.unwrap(FHE.asEuint128(ea)), "euint16.toU128");
    }

    function bindings32(uint32 a, uint32 b) public {
        euint32 ea = FHE.asEuint32(a);
        euint32 eb = FHE.asEuint32(b);

        // arithmetic
        require(euint32.unwrap(ea.add(eb)) == euint32.unwrap(FHE.add(ea, eb)), "euint32.add");
        require(euint32.unwrap(ea.mul(eb)) == euint32.unwrap(FHE.mul(ea, eb)), "euint32.mul");
        require(euint32.unwrap(ea.div(eb)) == euint32.unwrap(FHE.div(ea, eb)), "euint32.div");
        require(euint32.unwrap(ea.sub(eb)) == euint32.unwrap(FHE.sub(ea, eb)), "euint32.sub");
        require(euint32.unwrap(ea.rem(eb)) == euint32.unwrap(FHE.rem(ea, eb)), "euint32.rem");
        require(euint32.unwrap(ea.max(eb)) == euint32.unwrap(FHE.max(ea, eb)), "euint32.max");
        require(euint32.unwrap(ea.min(eb)) == euint32.unwrap(FHE.min(ea, eb)), "euint32.min");
        require(euint32.unwrap(ea.square()) == euint32.unwrap(FHE.square(ea)), "euint32.square");

        // comparison
        require(ebool.unwrap(ea.eq(eb)) == ebool.unwrap(FHE.eq(ea, eb)), "euint32.eq");
        require(ebool.unwrap(ea.ne(eb)) == ebool.unwrap(FHE.ne(ea, eb)), "euint32.ne");
        require(ebool.unwrap(ea.gt(eb)) == ebool.unwrap(FHE.gt(ea, eb)), "euint32.gt");
        require(ebool.unwrap(ea.gte(eb)) == ebool.unwrap(FHE.gte(ea, eb)), "euint32.gte");
        require(ebool.unwrap(ea.lt(eb)) == ebool.unwrap(FHE.lt(ea, eb)), "euint32.lt");
        require(ebool.unwrap(ea.lte(eb)) == ebool.unwrap(FHE.lte(ea, eb)), "euint32.lte");

        // bitwise / shift
        require(euint32.unwrap(ea.not()) == euint32.unwrap(FHE.not(ea)), "euint32.not");
        require(euint32.unwrap(ea.and(eb)) == euint32.unwrap(FHE.and(ea, eb)), "euint32.and");
        require(euint32.unwrap(ea.or(eb)) == euint32.unwrap(FHE.or(ea, eb)), "euint32.or");
        require(euint32.unwrap(ea.xor(eb)) == euint32.unwrap(FHE.xor(ea, eb)), "euint32.xor");
        require(euint32.unwrap(ea.shl(eb)) == euint32.unwrap(FHE.shl(ea, eb)), "euint32.shl");
        require(euint32.unwrap(ea.shr(eb)) == euint32.unwrap(FHE.shr(ea, eb)), "euint32.shr");
        require(euint32.unwrap(ea.rol(eb)) == euint32.unwrap(FHE.rol(ea, eb)), "euint32.rol");
        require(euint32.unwrap(ea.ror(eb)) == euint32.unwrap(FHE.ror(ea, eb)), "euint32.ror");

        // casts
        require(ebool.unwrap(ea.toBool()) == ebool.unwrap(FHE.asEbool(ea)), "euint32.toBool");
        require(euint8.unwrap(ea.toU8()) == euint8.unwrap(FHE.asEuint8(ea)), "euint32.toU8");
        require(euint16.unwrap(ea.toU16()) == euint16.unwrap(FHE.asEuint16(ea)), "euint32.toU16");
        require(euint64.unwrap(ea.toU64()) == euint64.unwrap(FHE.asEuint64(ea)), "euint32.toU64");
        require(euint128.unwrap(ea.toU128()) == euint128.unwrap(FHE.asEuint128(ea)), "euint32.toU128");
    }

    function bindings64(uint64 a, uint64 b) public {
        euint64 ea = FHE.asEuint64(a);
        euint64 eb = FHE.asEuint64(b);

        // arithmetic
        require(euint64.unwrap(ea.add(eb)) == euint64.unwrap(FHE.add(ea, eb)), "euint64.add");
        require(euint64.unwrap(ea.mul(eb)) == euint64.unwrap(FHE.mul(ea, eb)), "euint64.mul");
        require(euint64.unwrap(ea.div(eb)) == euint64.unwrap(FHE.div(ea, eb)), "euint64.div");
        require(euint64.unwrap(ea.sub(eb)) == euint64.unwrap(FHE.sub(ea, eb)), "euint64.sub");
        require(euint64.unwrap(ea.rem(eb)) == euint64.unwrap(FHE.rem(ea, eb)), "euint64.rem");
        require(euint64.unwrap(ea.max(eb)) == euint64.unwrap(FHE.max(ea, eb)), "euint64.max");
        require(euint64.unwrap(ea.min(eb)) == euint64.unwrap(FHE.min(ea, eb)), "euint64.min");
        require(euint64.unwrap(ea.square()) == euint64.unwrap(FHE.square(ea)), "euint64.square");

        // comparison
        require(ebool.unwrap(ea.eq(eb)) == ebool.unwrap(FHE.eq(ea, eb)), "euint64.eq");
        require(ebool.unwrap(ea.ne(eb)) == ebool.unwrap(FHE.ne(ea, eb)), "euint64.ne");
        require(ebool.unwrap(ea.gt(eb)) == ebool.unwrap(FHE.gt(ea, eb)), "euint64.gt");
        require(ebool.unwrap(ea.gte(eb)) == ebool.unwrap(FHE.gte(ea, eb)), "euint64.gte");
        require(ebool.unwrap(ea.lt(eb)) == ebool.unwrap(FHE.lt(ea, eb)), "euint64.lt");
        require(ebool.unwrap(ea.lte(eb)) == ebool.unwrap(FHE.lte(ea, eb)), "euint64.lte");

        // bitwise / shift
        require(euint64.unwrap(ea.not()) == euint64.unwrap(FHE.not(ea)), "euint64.not");
        require(euint64.unwrap(ea.and(eb)) == euint64.unwrap(FHE.and(ea, eb)), "euint64.and");
        require(euint64.unwrap(ea.or(eb)) == euint64.unwrap(FHE.or(ea, eb)), "euint64.or");
        require(euint64.unwrap(ea.xor(eb)) == euint64.unwrap(FHE.xor(ea, eb)), "euint64.xor");
        require(euint64.unwrap(ea.shl(eb)) == euint64.unwrap(FHE.shl(ea, eb)), "euint64.shl");
        require(euint64.unwrap(ea.shr(eb)) == euint64.unwrap(FHE.shr(ea, eb)), "euint64.shr");
        require(euint64.unwrap(ea.rol(eb)) == euint64.unwrap(FHE.rol(ea, eb)), "euint64.rol");
        require(euint64.unwrap(ea.ror(eb)) == euint64.unwrap(FHE.ror(ea, eb)), "euint64.ror");

        // casts
        require(ebool.unwrap(ea.toBool()) == ebool.unwrap(FHE.asEbool(ea)), "euint64.toBool");
        require(euint8.unwrap(ea.toU8()) == euint8.unwrap(FHE.asEuint8(ea)), "euint64.toU8");
        require(euint16.unwrap(ea.toU16()) == euint16.unwrap(FHE.asEuint16(ea)), "euint64.toU16");
        require(euint32.unwrap(ea.toU32()) == euint32.unwrap(FHE.asEuint32(ea)), "euint64.toU32");
        require(euint128.unwrap(ea.toU128()) == euint128.unwrap(FHE.asEuint128(ea)), "euint64.toU128");
    }

    function bindings128(uint128 a, uint128 b) public {
        euint128 ea = FHE.asEuint128(a);
        euint128 eb = FHE.asEuint128(b);

        // arithmetic
        require(euint128.unwrap(ea.add(eb)) == euint128.unwrap(FHE.add(ea, eb)), "euint128.add");
        require(euint128.unwrap(ea.mul(eb)) == euint128.unwrap(FHE.mul(ea, eb)), "euint128.mul");
        require(euint128.unwrap(ea.div(eb)) == euint128.unwrap(FHE.div(ea, eb)), "euint128.div");
        require(euint128.unwrap(ea.sub(eb)) == euint128.unwrap(FHE.sub(ea, eb)), "euint128.sub");
        require(euint128.unwrap(ea.rem(eb)) == euint128.unwrap(FHE.rem(ea, eb)), "euint128.rem");
        require(euint128.unwrap(ea.max(eb)) == euint128.unwrap(FHE.max(ea, eb)), "euint128.max");
        require(euint128.unwrap(ea.min(eb)) == euint128.unwrap(FHE.min(ea, eb)), "euint128.min");
        require(euint128.unwrap(ea.square()) == euint128.unwrap(FHE.square(ea)), "euint128.square");

        // comparison
        require(ebool.unwrap(ea.eq(eb)) == ebool.unwrap(FHE.eq(ea, eb)), "euint128.eq");
        require(ebool.unwrap(ea.ne(eb)) == ebool.unwrap(FHE.ne(ea, eb)), "euint128.ne");
        require(ebool.unwrap(ea.gt(eb)) == ebool.unwrap(FHE.gt(ea, eb)), "euint128.gt");
        require(ebool.unwrap(ea.gte(eb)) == ebool.unwrap(FHE.gte(ea, eb)), "euint128.gte");
        require(ebool.unwrap(ea.lt(eb)) == ebool.unwrap(FHE.lt(ea, eb)), "euint128.lt");
        require(ebool.unwrap(ea.lte(eb)) == ebool.unwrap(FHE.lte(ea, eb)), "euint128.lte");

        // bitwise / shift
        require(euint128.unwrap(ea.not()) == euint128.unwrap(FHE.not(ea)), "euint128.not");
        require(euint128.unwrap(ea.and(eb)) == euint128.unwrap(FHE.and(ea, eb)), "euint128.and");
        require(euint128.unwrap(ea.or(eb)) == euint128.unwrap(FHE.or(ea, eb)), "euint128.or");
        require(euint128.unwrap(ea.xor(eb)) == euint128.unwrap(FHE.xor(ea, eb)), "euint128.xor");
        require(euint128.unwrap(ea.shl(eb)) == euint128.unwrap(FHE.shl(ea, eb)), "euint128.shl");
        require(euint128.unwrap(ea.shr(eb)) == euint128.unwrap(FHE.shr(ea, eb)), "euint128.shr");
        require(euint128.unwrap(ea.rol(eb)) == euint128.unwrap(FHE.rol(ea, eb)), "euint128.rol");
        require(euint128.unwrap(ea.ror(eb)) == euint128.unwrap(FHE.ror(ea, eb)), "euint128.ror");

        // casts
        require(ebool.unwrap(ea.toBool()) == ebool.unwrap(FHE.asEbool(ea)), "euint128.toBool");
        require(euint8.unwrap(ea.toU8()) == euint8.unwrap(FHE.asEuint8(ea)), "euint128.toU8");
        require(euint16.unwrap(ea.toU16()) == euint16.unwrap(FHE.asEuint16(ea)), "euint128.toU16");
        require(euint32.unwrap(ea.toU32()) == euint32.unwrap(FHE.asEuint32(ea)), "euint128.toU32");
        require(euint64.unwrap(ea.toU64()) == euint64.unwrap(FHE.asEuint64(ea)), "euint128.toU64");
    }

    function bindingsAddress(address a, address b) public {
        eaddress ea = FHE.asEaddress(a);
        eaddress eb = FHE.asEaddress(b);

        // comparison
        require(ebool.unwrap(ea.eq(eb)) == ebool.unwrap(FHE.eq(ea, eb)), "eaddress.eq");
        require(ebool.unwrap(ea.ne(eb)) == ebool.unwrap(FHE.ne(ea, eb)), "eaddress.ne");

        // casts
        require(ebool.unwrap(ea.toBool()) == ebool.unwrap(FHE.asEbool(ea)), "eaddress.toBool");
        require(euint8.unwrap(ea.toU8()) == euint8.unwrap(FHE.asEuint8(ea)), "eaddress.toU8");
        require(euint16.unwrap(ea.toU16()) == euint16.unwrap(FHE.asEuint16(ea)), "eaddress.toU16");
        require(euint32.unwrap(ea.toU32()) == euint32.unwrap(FHE.asEuint32(ea)), "eaddress.toU32");
        require(euint64.unwrap(ea.toU64()) == euint64.unwrap(FHE.asEuint64(ea)), "eaddress.toU64");
        require(euint128.unwrap(ea.toU128()) == euint128.unwrap(FHE.asEuint128(ea)), "eaddress.toU128");
    }
}
