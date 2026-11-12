// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13 <0.9.0;

import {ITaskManager} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";

/// @notice Share/receive counterparties for the R-A3 / R-A4 repros.
contract ShareReceiver {
    function receiveAndGlobalize(
        address tm,
        uint256 handle,
        address sharer
    ) external returns (bool received, bool globalized) {
        try ITaskManager(tm).receiveCtHash(handle, sharer) {
            received = true;
        } catch {
            received = false;
        }
        if (received) {
            try ITaskManager(tm).allowGlobal(handle) {
                globalized = true;
            } catch {
                globalized = false;
            }
        }
    }

    function receiveAndMarkDecryptable(
        address tm,
        uint256 handle,
        address sharer
    ) external returns (bool received, bool marked) {
        try ITaskManager(tm).receiveCtHash(handle, sharer) {
            received = true;
        } catch {
            received = false;
        }
        if (received) {
            // allowForDecryption is not on ITaskManager; call it by selector.
            (bool ok, ) = tm.call(
                abi.encodeWithSignature("allowForDecryption(uint256)", handle)
            );
            marked = ok;
        }
    }

    function tryReceive(
        address tm,
        uint256 handle,
        address sharer
    ) external returns (bool) {
        try ITaskManager(tm).receiveCtHash(handle, sharer) {
            return true;
        } catch {
            return false;
        }
    }
}

contract ShareSharer {
    function share(address tm, uint256 handle, address receiver) external {
        ITaskManager(tm).shareCtHash(handle, receiver);
    }
}

/// @notice Runs a whole share flow inside ONE transaction, which the
/// transient share slot requires.
contract ShareOrchestrator {
    ITaskManager public immutable tm;

    uint256 public escHandle;
    bool public escReceived;
    bool public escGlobalized;
    uint256 public escDecryptHandle;
    bool public escDecryptReceived;
    bool public escDecryptMarked;
    uint256 public owHandle;
    bool public owFirst;
    bool public owSecond;

    constructor(address _tm) {
        tm = ITaskManager(_tm);
    }

    // R-A3: holder -> share -> receiver receives -> receiver globalizes.
    function runEscalation(
        address sharer,
        address receiver
    )
        external
        returns (uint256 handle, bool received, bool globalized)
    {
        handle = tm.createRandomTask(5, 0xABCD, 0);
        tm.allow(handle, sharer);
        ShareSharer(sharer).share(address(tm), handle, receiver);
        (received, globalized) = ShareReceiver(receiver).receiveAndGlobalize(
            address(tm),
            handle,
            sharer
        );
        escHandle = handle;
        escReceived = received;
        escGlobalized = globalized;
    }

    // R-A3 (decrypt leg): holder -> share -> receiver receives -> receiver tries
    // to mark the handle decryptable.
    function runEscalationDecrypt(
        address sharer,
        address receiver
    )
        external
        returns (uint256 handle, bool received, bool marked)
    {
        handle = tm.createRandomTask(5, 0xABCD, 0);
        tm.allow(handle, sharer);
        ShareSharer(sharer).share(address(tm), handle, receiver);
        (received, marked) = ShareReceiver(receiver).receiveAndMarkDecryptable(
            address(tm),
            handle,
            sharer
        );
        escDecryptHandle = handle;
        escDecryptReceived = received;
        escDecryptMarked = marked;
    }

    // R-A4: two sharers share the same handle to the same receiver.
    function runOverwrite(
        address s1,
        address s2,
        address receiver
    )
        external
        returns (uint256 handle, bool firstClaim, bool secondClaim)
    {
        handle = tm.createRandomTask(5, 0xABCD, 0);
        tm.allow(handle, s1);
        tm.allow(handle, s2);
        ShareSharer(s1).share(address(tm), handle, receiver);
        ShareSharer(s2).share(address(tm), handle, receiver);
        firstClaim = ShareReceiver(receiver).tryReceive(
            address(tm),
            handle,
            s1
        );
        secondClaim = ShareReceiver(receiver).tryReceive(
            address(tm),
            handle,
            s2
        );
        owHandle = handle;
        owFirst = firstClaim;
        owSecond = secondClaim;
    }
}
