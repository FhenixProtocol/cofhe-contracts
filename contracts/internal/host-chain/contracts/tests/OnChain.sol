// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

import {FHE, Impl, ebool, euint8, euint16, euint32} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract OnChain {
    ebool public ctHashBool;
    euint8 public ctHash8;
    euint16 public ctHash16;
    euint32 public ctHash32;

    function trivialBool(bool a, bool b) public returns (ebool) {
        ebool ea = FHE.asEbool(a);
        ebool eb = FHE.asEbool(b);

        FHE.and(ea, eb);
        FHE.or(ea, eb);
        FHE.xor(ea, eb);
        FHE.eq(ea, eb);
        FHE.ne(ea, eb);
        FHE.select(ebool.wrap(0), eb, ea);
        FHE.decrypt(ea);

        ctHashBool = ea;
        return ctHashBool;
    }

    function trivial8(uint8 a, uint8 b) public returns (euint8) {
        euint8 ea = FHE.asEuint8(a);
        euint8 eb = FHE.asEuint8(b);

        FHE.add(ea, eb);
        FHE.sub(ea, eb);
        FHE.mul(ea, eb);
        FHE.and(ea, eb);
        FHE.or(ea, eb);
        FHE.xor(ea, eb);
        FHE.div(ea, eb);
        FHE.rem(ea, eb);
        FHE.square(ea);
        FHE.shl(ea, eb);
        FHE.shr(ea, eb);
        FHE.ror(ea, eb);
        FHE.rol(ea, eb);
        FHE.eq(ea, eb);
        FHE.ne(ea, eb);
        FHE.gte(ea, eb);
        FHE.gt(ea, eb);
        FHE.lte(ea, eb);
        FHE.lt(ea, eb);
        FHE.min(ea, eb);
        FHE.max(ea, eb);
        FHE.not(ea);
        FHE.select(ebool.wrap(0), eb, ea);
        FHE.decrypt(ea);

        ctHash8 = ea;
        return ctHash8;
    }

    function trivial16(uint16 a, uint16 b) public returns (euint16) {
        euint16 ea = FHE.asEuint16(a);
        euint16 eb = FHE.asEuint16(b);

        FHE.add(ea, eb);
        FHE.sub(ea, eb);
        FHE.mul(ea, eb);
        FHE.and(ea, eb);
        FHE.or(ea, eb);
        FHE.xor(ea, eb);
        FHE.div(ea, eb);
        FHE.rem(ea, eb);
        FHE.square(ea);
        FHE.shl(ea, eb);
        FHE.shr(ea, eb);
        FHE.ror(ea, eb);
        FHE.rol(ea, eb);
        FHE.eq(ea, eb);
        FHE.ne(ea, eb);
        FHE.gte(ea, eb);
        FHE.gt(ea, eb);
        FHE.lte(ea, eb);
        FHE.lt(ea, eb);
        FHE.min(ea, eb);
        FHE.max(ea, eb);
        FHE.not(ea);
        FHE.select(ebool.wrap(0), eb, ea);
        FHE.decrypt(ea);

        ctHash16 = ea;
        return ctHash16;
    }

    function trivial32(uint32 a, uint32 b) public returns (euint32) {
        euint32 ea = FHE.asEuint32(a);
        euint32 eb = FHE.asEuint32(b);

        FHE.add(ea, eb);
        FHE.sub(ea, eb);
        FHE.mul(ea, eb);
        FHE.and(ea, eb);
        FHE.or(ea, eb);
        FHE.xor(ea, eb);
        FHE.div(ea, eb);
        FHE.rem(ea, eb);
        FHE.square(ea);
        FHE.shl(ea, eb);
        FHE.shr(ea, eb);
        FHE.ror(ea, eb);
        FHE.rol(ea, eb);
        FHE.eq(ea, eb);
        FHE.ne(ea, eb);
        FHE.gte(ea, eb);
        FHE.gt(ea, eb);
        FHE.lte(ea, eb);
        FHE.lt(ea, eb);
        FHE.min(ea, eb);
        FHE.max(ea, eb);
        FHE.not(ea);
        FHE.select(ebool.wrap(0), eb, ea);
        FHE.decrypt(ea);
        ctHash32 = ea;
        return ctHash32;
    }

    function notAllowedPersistentlyBool() public returns (ebool) {
        ctHashBool = FHE.not(ctHashBool);
        return ctHashBool;
    }

    function notAllowedPersistently8() public returns (euint8) {
        ctHash8 = FHE.xor(ctHash8, ctHash8);
        return ctHash8;
    }

    function notAllowedPersistently16() public returns (euint16) {
        ctHash16 = FHE.xor(ctHash16, ctHash16);
        return ctHash16;
    }

    function notAllowedPersistently32() public returns (euint32) {
        ctHash32 = FHE.xor(ctHash32, ctHash32);
        return ctHash32;
    }

    function cantEncryptMoreThanMaxUint32() public returns (euint32) {
        return FHE.asEuint32(1000000000000); // Value taken from a real world example
    }

    function cantEncryptWithFakeUintType() public returns (uint256) {
        return Impl.trivialEncrypt(15, 100, 0);
    }

    function cantEncryptWithFakeSecurityZone() public returns (euint32) {
        return FHE.asEuint32(16, 100);
    }

    function cantCastWithFakeType() public returns (uint256) {
        euint32 v = FHE.asEuint32(16);
        return Impl.cast(euint32.unwrap(v), 150);
    }
}