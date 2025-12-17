// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract OnChain2 {
    euint64 public ctHash64;
    euint128 public ctHash128;
    euint256 public ctHash256;
    eaddress public ctHashAddress;

    function trivial64(uint64 a, uint64 b) public returns (euint64) {
        euint64 ea = FHE.asEuint64(a);
        euint64 eb = FHE.asEuint64(b);

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

        ctHash64 = ea;
        return ctHash64;
    }

    function trivial128(uint128 a, uint128 b) public returns (euint128) {
        euint128 ea = FHE.asEuint128(a);
        euint128 eb = FHE.asEuint128(b);

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

        ctHash128 = ea;
        return ctHash128;
    }

    function trivial256(uint256 a, uint256 b) public returns (euint256) {
        euint256 ea = FHE.asEuint256(a);
        euint256 eb = FHE.asEuint256(b);

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

        ctHash256 = ea;
        return ctHash256;
    }

    function trivialAddress(address a, address b) public returns (eaddress) {
        eaddress ea = FHE.asEaddress(a);
        eaddress eb = FHE.asEaddress(b);

        FHE.eq(ea, eb);

        ctHashAddress = ea;
        return ctHashAddress;
    }

    function notAllowedPersistently64() public returns (euint64) {
        ctHash64 = FHE.xor(ctHash64, ctHash64);
        return ctHash64;
    }

    function notAllowedPersistently128() public returns (euint128) {
        ctHash128 = FHE.xor(ctHash128, ctHash128);
        return ctHash128;
    }

    function notAllowedPersistently256() public returns (euint256) {
        ctHash256 = FHE.xor(ctHash256, ctHash256);
        return ctHash256;
    }

    function notAllowedPersistentlyAddress() public returns (ebool) {
        ebool ctHashBool = FHE.eq(ctHashAddress, ctHashAddress);
        return ctHashBool;
    }
}