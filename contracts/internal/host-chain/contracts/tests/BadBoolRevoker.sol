// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

contract BadBoolRevoker {
    fallback() external {
        assembly {
            mstore(0, 2)
            return(0, 32)
        }
    }
}
