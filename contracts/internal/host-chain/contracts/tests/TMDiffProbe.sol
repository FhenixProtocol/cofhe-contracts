// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;

interface ITMAllowed {
    function isAllowed(uint256 ctHash, address account) external view returns (bool);
}

/// Differential-test caller: runs one TaskManager call, captures success + raw return/revert
/// data, and reads the ACL permissions for returned handles in the same tx (transient ones vanish after).
contract TMDiffProbe {
    event Result(bool success, bytes ret, bool[] allowed);

    function exec(address tm, bytes calldata data, uint8 mode) external {
        (bool ok, bytes memory ret) = tm.call(data);
        bool[] memory allowed;
        if (ok && mode == 1) {
            allowed = new bool[](1);
            allowed[0] = ITMAllowed(tm).isAllowed(abi.decode(ret, (uint256)), address(this));
        } else if (ok && mode == 2) {
            uint256[] memory hs = abi.decode(ret, (uint256[]));
            allowed = new bool[](hs.length);
            for (uint256 i = 0; i < hs.length; i++) {
                allowed[i] = ITMAllowed(tm).isAllowed(hs[i], address(this));
            }
        }
        emit Result(ok, ret, allowed);
    }

    function multi(address[] calldata targets, bytes[] calldata datas) external {
        for (uint256 i = 0; i < targets.length; i++) {
            (bool ok, bytes memory ret) = targets[i].call(datas[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
