// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13 <0.9.0;

import {FHE, ebool, euint8, euint16, externalEuint8} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {ITaskManager, FunctionId} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";

/// @notice Discovery-only repro harness for the cofhe-contracts Round 1 hunt.
/// NOT part of the project. Each function isolates one candidate.
contract HuntHarness {
    ITaskManager public immutable tm;

    // Last-run outputs, readable after a transaction (return values are not
    // available from a TransactionResponse).
    uint256 public lastHandle;
    uint256 public lastZone;
    uint256 public lastTyp;
    bool public lastBool;

    constructor(address _tm) {
        tm = ITaskManager(_tm);
    }

    // R-F4: input verification via the bytes overload vs the external* overload.
    function asEuint8FromBytes(bytes memory data) external returns (euint8) {
        return FHE.asEuint8(data);
    }

    function asEuint8FromExternal(
        bytes32 hash,
        bytes memory proof
    ) external returns (euint8) {
        return FHE.asEuint8(externalEuint8.wrap(hash), proof);
    }

    // R-F1: or(uninitialized ebool, false) — the substituted default is
    // observable as a trivialEncrypt TaskCreated event with value 1.
    function orUninitWithFalse() external returns (ebool) {
        ebool uninit;
        ebool f = FHE.asEbool(false);
        return FHE.or(uninit, f);
    }

    function xorUninitWithTrue() external returns (ebool) {
        ebool uninit;
        ebool t = FHE.asEbool(true);
        return FHE.xor(uninit, t);
    }

    // R-F2: typed batch publish with more inputs than results.
    function publishBatchMismatch(
        ebool[] memory inputs,
        bool[] memory results,
        bytes[] memory sigs
    ) external {
        FHE.publishDecryptResultBatch(inputs, results, sigs);
    }

    // R-F5: cast of an uninitialized handle.
    function castUninit() external returns (euint8) {
        return FHE.asEuint8(euint16.wrap(bytes32(0)));
    }

    // R-F3: publish a raw (untyped) result, then read it back typed.
    function publishRaw(uint256 h, uint256 r, bytes memory sig) external {
        FHE.publishDecryptResult(h, r, sig);
    }

    function readEuint8(euint8 h) external view returns (uint8) {
        return FHE.getDecryptResult(h);
    }

    function readEbool(ebool h) external view returns (bool) {
        return FHE.getDecryptResult(h);
    }

    // R-T1 / R-T3 / R-T9: direct createTask passthrough.
    function createTask(
        uint8 rt,
        uint8 funcId,
        uint256[] memory enc,
        uint256[] memory extra
    ) external returns (uint256) {
        return tm.createTask(rt, FunctionId(funcId), enc, extra);
    }

    // R-T1: select with a zone-0 condition and zone-1 branches, all in one tx
    // (transient allowances from creation are live within the transaction).
    function selectCrossZone()
        external
        returns (uint256 handle, uint256 zone, uint256 typ)
    {
        uint256[] memory noEnc = new uint256[](0);
        uint256[] memory e0 = new uint256[](3);
        e0[0] = 1;
        e0[1] = 0; // EBOOL
        e0[2] = 0; // zone 0
        uint256 cond = tm.createTask(0, FunctionId.trivialEncrypt, noEnc, e0);
        uint256[] memory e1 = new uint256[](3);
        e1[0] = 5;
        e1[1] = 2; // EUINT8
        e1[2] = 1; // zone 1
        uint256 b1 = tm.createTask(2, FunctionId.trivialEncrypt, noEnc, e1);
        uint256[] memory e2 = new uint256[](3);
        e2[0] = 9;
        e2[1] = 2;
        e2[2] = 1; // zone 1
        uint256 b2 = tm.createTask(2, FunctionId.trivialEncrypt, noEnc, e2);
        uint256[] memory enc = new uint256[](3);
        enc[0] = cond;
        enc[1] = b1;
        enc[2] = b2;
        handle = tm.createTask(2, FunctionId.select, enc, new uint256[](0));
        zone = handle & 0xff;
        typ = (handle >> 8) & 0xff;
        lastHandle = handle;
        lastZone = zone;
        lastTyp = typ;
    }

    // R-T3: cast to EUINT16 but claim returnType EUINT8.
    function castMismatch() external returns (uint256 handle, uint256 typ) {
        uint256[] memory noEnc = new uint256[](0);
        uint256[] memory e = new uint256[](3);
        e[0] = 7;
        e[1] = 3; // EUINT16
        e[2] = 0; // zone 0
        uint256 h = tm.createTask(3, FunctionId.trivialEncrypt, noEnc, e);
        uint256[] memory enc = new uint256[](1);
        enc[0] = h;
        uint256[] memory extra = new uint256[](1);
        extra[0] = 3; // cast target EUINT16
        handle = tm.createTask(2, FunctionId.cast, enc, extra); // returnType EUINT8
        typ = (handle >> 8) & 0xff;
        lastHandle = handle;
        lastTyp = typ;
    }

    // R-T9: cast with no extra inputs at all.
    function castNoType() external returns (uint256 handle) {
        uint256[] memory noEnc = new uint256[](0);
        uint256[] memory e = new uint256[](3);
        e[0] = 7;
        e[1] = 3;
        e[2] = 0;
        uint256 h = tm.createTask(3, FunctionId.trivialEncrypt, noEnc, e);
        uint256[] memory enc = new uint256[](1);
        enc[0] = h;
        handle = tm.createTask(3, FunctionId.cast, enc, new uint256[](0));
        lastHandle = handle;
    }

    // R-A1 (fixed): create a handle and persist it to two accounts in one tx.
    function createAndAllowBoth(
        address a,
        address b
    ) external returns (uint256 handle) {
        handle = tm.createRandomTask(5, 0xABCD, 0);
        tm.allow(handle, a);
        tm.allow(handle, b);
        lastHandle = handle;
    }

    // R-A2: a transient grant is visible to a second call in the same tx.
    function transientAcrossCalls()
        external
        returns (uint256 handle, bool stillAllowed)
    {
        handle = tm.createRandomTask(5, 0x1234, 0);
        stillAllowed = tm.isAllowed(handle, address(this));
        lastHandle = handle;
        lastBool = stillAllowed;
    }
}
