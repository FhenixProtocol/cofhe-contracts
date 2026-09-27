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

    function _fork(string memory chain) internal {
        chainName = chain;
        // Latest block; the block number goes into the results JSON.
        vm.createSelectFork(chain);
        acl = tm.acl();
    }

    function _impl(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
    }
}
