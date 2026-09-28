// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {ForkBase} from "./ForkBase.sol";

interface IProbe {
    function setup() external;
    function rowSpecs()
        external
        pure
        returns (string[] memory ids, uint8[] memory kinds, uint8[] memory utypes, uint8[] memory sizes);
}

/// Builds the signed arguments of each probe row kind (see script/gen_probe.py).
abstract contract ProbeArgs is ForkBase {
    uint8 constant K_INPUT = 1;
    uint8 constant K_DECRYPT = 2;
    uint8 constant K_INPUT_BATCH = 3;
    uint8 constant K_DECRYPT_BATCH = 4;
    uint8 constant K_INPUT_BYTES = 5;
    uint8 constant EUINT32 = 4;

    function _args(address probe, string memory id, uint8 kind, uint8 utype, uint8 size)
        internal
        view
        returns (bytes memory)
    {
        if (kind == K_INPUT) {
            (bytes32 h1, bytes memory p1) = _signedInput(probe, id, 1, utype);
            (bytes32 h2, bytes memory p2) = _signedInput(probe, id, 2, utype);
            return abi.encode(h1, p1, h2, p2);
        }
        if (kind == K_INPUT_BYTES) {
            (bytes32 h1, bytes memory p1) = _signedInput(probe, id, 1, utype);
            (bytes32 h2, bytes memory p2) = _signedInput(probe, id, 2, utype);
            return
                abi.encode(abi.encode(uint256(h1), uint8(0), utype, p1), abi.encode(uint256(h2), uint8(0), utype, p2));
        }
        if (kind == K_DECRYPT) {
            // Same handles for publish, verify and get of one type, so get reads what publish stored.
            uint256 h1 = _decryptHandle("dec", utype, 1);
            uint256 h2 = _decryptHandle("dec", utype, 2);
            return abi.encode(bytes32(h1), _signDecrypt(h1, 1), bytes32(h2), _signDecrypt(h2, 1));
        }
        if (kind == K_INPUT_BATCH) {
            uint256[] memory hashes = new uint256[](size);
            uint8[] memory utypes = new uint8[](size);
            bytes32[] memory hs = new bytes32[](size);
            for (uint256 i = 0; i < size; i++) {
                hashes[i] = uint256(keccak256(abi.encode(id, i)));
                utypes[i] = utype;
                hs[i] = bytes32(hashes[i]);
            }
            return abi.encode(hs, _signInputs(hashes, utypes, address(this), probe));
        }
        if (kind == K_DECRYPT_BATCH) {
            bytes32[] memory hs = new bytes32[](size);
            bytes[] memory sigs = new bytes[](size);
            for (uint256 i = 0; i < size; i++) {
                uint256 h = _decryptHandle(string.concat("batch", vm.toString(size)), EUINT32, i);
                hs[i] = bytes32(h);
                sigs[i] = _signDecrypt(h, 1);
            }
            return abi.encode(hs, sigs);
        }
        return "";
    }

    // The probe forwards its own msg.sender (this test contract) as the input sender.
    function _signedInput(address probe, string memory id, uint256 n, uint8 utype)
        internal
        view
        returns (bytes32, bytes memory)
    {
        uint256[] memory hashes = new uint256[](1);
        uint8[] memory utypes = new uint8[](1);
        hashes[0] = uint256(keccak256(abi.encode(id, n)));
        utypes[0] = utype;
        return (bytes32(hashes[0]), _signInputs(hashes, utypes, address(this), probe));
    }

    // Synthetic handle: the TaskManager reads only the type bits (0x7f00) of a decrypt handle.
    function _decryptHandle(string memory tag, uint8 utype, uint256 n) internal pure returns (uint256) {
        return (uint256(keccak256(abi.encode(tag, utype, n))) & ~uint256(0xffff)) | (uint256(utype) << 8);
    }
}
