// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

import {ForkBase, TM} from "./ForkBase.sol";
import {UnsignedEncryptedInput} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";

interface ITMSignatures {
    function verifyDecryptResultSafe(uint256 ctHash, uint256 result, bytes calldata signature)
        external
        view
        returns (bool);
    function batchVerifyInputs(UnsignedEncryptedInput[] memory inputs, address sender, bytes memory signature)
        external
        returns (uint256[] memory);
}

contract SignersTest is ForkBase {
    uint8 constant EUINT32 = 4;

    function _check(string memory chain) internal {
        _fork(chain);
        _takeOverSigners();
        assertEq(tm.verifierSigner(), signer);
        assertEq(tm.decryptResultSigner(), signer);

        // The decrypt digest reads only the type bits of the handle, so a synthetic handle is enough.
        uint256 ct = (uint256(keccak256("ct")) & ~uint256(0xffff)) | (uint256(EUINT32) << 8);
        assertTrue(ITMSignatures(TM).verifyDecryptResultSafe(ct, 7, _signDecrypt(ct, 7)));
        assertFalse(ITMSignatures(TM).verifyDecryptResultSafe(ct, 8, _signDecrypt(ct, 7)));

        uint256[] memory hashes = new uint256[](1);
        uint8[] memory utypes = new uint8[](1);
        hashes[0] = uint256(keccak256("input"));
        utypes[0] = EUINT32;
        UnsignedEncryptedInput[] memory inputs = new UnsignedEncryptedInput[](1);
        inputs[0] = UnsignedEncryptedInput(hashes[0], 0, EUINT32);
        address sender = address(0xA11CE);
        ITMSignatures(TM).batchVerifyInputs(inputs, sender, _signInputs(hashes, utypes, sender, address(this)));
    }

    function test_sepolia() public {
        _check("sepolia");
    }

    function test_arbitrumSepolia() public {
        _check("arbitrumSepolia");
    }
}
