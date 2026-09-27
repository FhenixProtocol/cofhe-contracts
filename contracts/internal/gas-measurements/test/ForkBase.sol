// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";

address constant TM = 0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9;
bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

interface ITaskManagerAdmin {
    function getVersion() external view returns (uint8);
    function isEnabled() external view returns (bool);
    function acl() external view returns (address);
    function verifierSigner() external view returns (address);
    function decryptResultSigner() external view returns (address);
}

abstract contract ForkBase is Test {
    ITaskManagerAdmin internal tm = ITaskManagerAdmin(TM);
    address internal acl;
    string internal chainName;
    uint256 internal forkBlock;

    // Pins the chain's own latest block. block.number cannot be used to record it: on Arbitrum
    // it returns an L1 block number.
    function _fork(string memory chain) internal {
        chainName = chain;
        bytes memory latest = vm.rpc(chain, "eth_blockNumber", "[]");
        forkBlock = uint256(bytes32(latest)) >> (8 * (32 - latest.length));
        vm.createSelectFork(chain, forkBlock);
        acl = tm.acl();
    }

    // Throwaway key, used only inside the fork. We do not hold the real signer keys; swapping only the
    // address keeps the gas path the same (one SLOAD of the signer + ecrecover).
    uint256 internal signerKey = uint256(keccak256("pro-575-gas-signer"));
    address internal signer = vm.addr(uint256(keccak256("pro-575-gas-signer")));

    // Finds the address by value instead of a hard-coded slot, so a layout change fails loudly here.
    // The signers share packed slots with other fields, so every byte offset is searched.
    function _replaceAddress(address target, address oldValue, address newValue) internal {
        uint256 mask = type(uint160).max;
        for (uint256 slot = 0; slot < 64; slot++) {
            uint256 word = uint256(vm.load(target, bytes32(slot)));
            for (uint256 shift = 0; shift <= 96; shift += 8) {
                if ((word >> shift) & mask == uint160(oldValue)) {
                    word = (word & ~(mask << shift)) | (uint256(uint160(newValue)) << shift);
                    vm.store(target, bytes32(slot), bytes32(word));
                    return;
                }
            }
        }
        revert("address not found in storage");
    }

    function _takeOverSigners() internal {
        _replaceAddress(TM, tm.verifierSigner(), signer);
        _replaceAddress(TM, tm.decryptResultSigner(), signer);
    }

    // Mirrors TaskManager.extractBatchSigner / inputMessageHash; security zone is 0.
    function _signInputs(uint256[] memory ctHashes, uint8[] memory utypes, address sender, address consumer)
        internal
        view
        returns (bytes memory)
    {
        bytes memory concatenated;
        for (uint256 i = 0; i < ctHashes.length; i++) {
            bytes32 h = keccak256(abi.encodePacked(ctHashes[i], utypes[i], uint8(0), sender, block.chainid, consumer));
            concatenated = abi.encodePacked(concatenated, h);
        }
        return _sign(keccak256(concatenated));
    }

    // Mirrors TaskManager._computeDecryptResultHash: result(32) | encType(4) | chainId(8) | ctHash(32).
    function _signDecrypt(uint256 ctHash, uint256 result) internal view returns (bytes memory) {
        uint32 encType = uint32((ctHash & 0x7f00) >> 8);
        return _sign(keccak256(abi.encodePacked(result, encType, uint64(block.chainid), ctHash)));
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _impl(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
    }
}
