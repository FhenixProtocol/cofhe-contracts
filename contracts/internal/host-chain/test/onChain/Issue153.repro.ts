import hre from "hardhat";
const { ethers } = hre;

import { deployOnChainFixture } from "./OnChain.fixture";
import { expect } from "chai";

// Issue #153 — createTask's returned placeholder handle embeds the caller-supplied
// `returnType`, while the TaskCreated event reports the operation's real encryption
// type from extraInputs[1]. Nothing binds them: a caller gets a euint16 placeholder
// for a task the coprocessor will compute as euint8.

const EUINT8_TFHE = 2;
const EUINT16_TFHE = 3;
const TRIVIAL_ENCRYPT_FN = 26; // FunctionId.trivialEncrypt (contracts/ICofhe.sol)

describe("Issue #153 — placeholder returnType vs TaskCreated type divergence", function () {
  // PRE-FIX this tx succeeded and minted a euint16 handle for an euint8 task (issue #153).
  // POST-FIX createTask reverts with ReturnTypeMismatch(returnType=3, actualType=2) —
  // the revert data seen when this run executed against the patched contract.
  it("reverts when returnType diverges from the task's real type (#153 fixed behavior)", async function () {
    const { taskManager } = await deployOnChainFixture();
    const signers = await ethers.getSigners();
    const admin = signers[0];

    // trivialEncrypt(value=5, encType=EUINT8, zone=0) with returnType=EUINT16.
    // validateTrivialEncryptInputs validates extraInputs[1] (=EUINT8) against the
    // VALUE — passes. Nothing compares it to `returnType` — that's the bug.
    const value = 5n;
    const realEncType = 2n; // EUINT8_TFHE (plaintext extraInputs entry)
    const claimedReturnType = EUINT16_TFHE;

    await expect(
      taskManager
        .connect(admin)
        .createTask(claimedReturnType, TRIVIAL_ENCRYPT_FN, [], [
          value,
          realEncType,
          0n, // security zone
        ]),
    ).to.be.revertedWithCustomError(taskManager, "ReturnTypeMismatch");
    const receipt = { logs: [] as any[] }; // no state change on revert

    // Returned placeholder handle via eth_call on identical inputs (deterministic):
    // eth_call reproduces the same revert — no divergence is reachable anymore:
    await expect(
      ethers.provider.call({
        to: await taskManager.getAddress(),
        data: taskManager.interface.encodeFunctionData("createTask", [
          claimedReturnType,
          TRIVIAL_ENCRYPT_FN,
          [],
          [value, realEncType, 0n],
        ]),
      }),
    ).to.be.revertedWithCustomError(taskManager, "ReturnTypeMismatch");
  });

  it("accepts a task where returnType matches the real type (post-fix sanity)", async function () {
    const { taskManager } = await deployOnChainFixture();
    const signers = await ethers.getSigners();
    const admin = signers[0];

    const tx = await taskManager
      .connect(admin)
      .createTask(EUINT8_TFHE, TRIVIAL_ENCRYPT_FN, [], [
        5n,
        BigInt(EUINT8_TFHE),
        0n,
      ]);
    const receipt = await tx.wait();

    const retHex = await ethers.provider.call({
      to: await taskManager.getAddress(),
      data: taskManager.interface.encodeFunctionData("createTask", [
        EUINT8_TFHE,
        TRIVIAL_ENCRYPT_FN,
        [],
        [5n, BigInt(EUINT8_TFHE), 0n],
      ]),
    });
    const returnedHandle = BigInt(retHex);
    const handleType = Number((returnedHandle & 0x7f00n) >> 8n);
    expect(handleType).to.equal(EUINT8_TFHE);

    const createdEv = receipt.logs
      .map((l: any) => {
        try {
          return taskManager.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .find((e: any) => e.name === "TaskCreated");
    const eventType = Number(createdEv!.args.input2);
    expect(handleType).to.equal(eventType); // unified after fix
  });
});
