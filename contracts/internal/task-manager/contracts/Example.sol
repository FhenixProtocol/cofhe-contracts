// SPDX-License-Identifier: MIT

pragma solidity >=0.8.13 <0.9.0;

// import "./FHE.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {taskManagerAddress} from "./addresses/TaskManagerAddress.sol";

contract Example {
    error NotAllowed(address sender);

    event ctHashEvent(uint256 ctHash);

    function doAdd(uint32 a, uint32 b) public returns (euint32) {
        euint32 ea = FHE.asEuint32(a);
        euint32 eb = FHE.asEuint32(b);

        euint32 ctHash = FHE.add(ea, eb);
        FHE.allowThis(ctHash);

        emit ctHashEvent(euint32.unwrap(ctHash));
        return ctHash;
    }

    function doRandom() public returns (euint32) {
        euint32 ctHash = FHE.randomEuint32();
        FHE.allowThis(ctHash);

        emit ctHashEvent(euint32.unwrap(ctHash));
        return ctHash;
    }

    function doRandom8() public returns (euint8) {
        euint8 ctHash = FHE.randomEuint8();
        FHE.allowThis(ctHash);

        emit ctHashEvent(euint8.unwrap(ctHash));
        return ctHash;
    }

    // Helper function for bytesToHexString
    function byteToChar(uint8 value) internal pure returns (bytes1) {
        if (value < 10) {
            return bytes1(uint8(48 + value)); // 0-9
        } else {
            return bytes1(uint8(87 + value)); // a-f
        }
    }

    function bytesToHexString(bytes memory buffer) internal pure returns (string memory) {
        // Each byte takes 2 characters
        bytes memory hexChars = new bytes(buffer.length * 2);

        for(uint i = 0; i < buffer.length; i++) {
            uint8 value = uint8(buffer[i]);
            hexChars[i * 2] = byteToChar(value / 16);
            hexChars[i * 2 + 1] = byteToChar(value % 16);
        }

        return string(hexChars);
    }

    function uint256ToBytes32(uint256 value) internal pure returns (bytes memory) {
        bytes memory result = new bytes(32);
        assembly {
            mstore(add(result, 32), value)
        }
        return result;
    }

    function bytesToUint256(bytes memory b) internal pure returns (uint256) {
        require(b.length == 32, string(abi.encodePacked("Input bytes length must be 32, but got ", Strings.toString(b.length))));

        uint256 result;
        assembly {
            result := mload(add(b, 32))
        }
        return result;
    }

    function doDecrypt(uint256 ctHash) public {
        FHE.decrypt(euint32.wrap(ctHash));
    }
}
