import hre from "hardhat";
import { expect } from "chai";

import { deployDecryptResultFixture } from "../decryptResult/DecryptResult.fixture";

const { ethers } = hre;

const EUINT64_TFHE = 5;
const EUINT32_TFHE = 4;
const RANDOM_FUNCTION_ID = 27;
const SECURITY_ZONE = 0;

const METADATA_MASK = (1n << 16n) - 1n;

/// Mirrors TMCommon.appendMetadata: keep the top 30 bytes, rebuild the low two from
/// (isTrivial | uintType, securityZone).
function appendMetadata(preCtHash: bigint, uintType: number, securityZone: number): bigint {
  return (preCtHash & ~METADATA_MASK) | (BigInt(uintType) << 8n) | BigInt(securityZone & 0xff);
}

/// Mirrors TMCommon.calcPlaceholderKey for the random path: keccak over the 32-byte
/// inputs followed by a single function-id byte, then metadata.
function expectedHandle(seed: bigint, sender: string, uintType: number, securityZone: number): bigint {
  const preimage = ethers.concat([
    ethers.zeroPadValue(ethers.toBeHex(seed), 32),
    ethers.zeroPadValue(sender, 32),
    ethers.toBeHex(RANDOM_FUNCTION_ID, 1),
  ]);
  return appendMetadata(BigInt(ethers.keccak256(preimage)), uintType, securityZone);
}

/// A handle shaped like the result of an earlier operation: arbitrary top 30 bytes, a
/// valid type, a valid zone, and the isTriviallyEncrypted bit clear.
function existingHandle(uintType = EUINT64_TFHE, securityZone = SECURITY_ZONE): bigint {
  const body = BigInt(ethers.keccak256(ethers.toUtf8Bytes("some-existing-ciphertext")));
  return appendMetadata(body, uintType, securityZone);
}

async function handleFromTx(taskManager: any, tx: any): Promise<bigint> {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const parsed = taskManager.interface.parseLog(log);
      if (parsed?.name === "TaskCreated") return parsed.args.ctHash;
    } catch {
      // not a TaskManager log
    }
  }
  throw new Error("TaskCreated event not found");
}

describe("createRandomTask", function () {
  let taskManager: any;
  let acl: any;
  let owner: any;
  let other: any;

  beforeEach(async function () {
    const fixture = await deployDecryptResultFixture();
    taskManager = fixture.taskManager;
    acl = fixture.acl;
    owner = fixture.owner;
    other = fixture.otherAccount;
  });

  describe("handle derivation", function () {
    it("derives the handle from keccak(seed || sender || funcId)", async function () {
      const seed = 42n;

      const returned = await taskManager
        .connect(owner)
        .createRandomTask.staticCall(EUINT64_TFHE, seed, SECURITY_ZONE);

      expect(returned).to.equal(expectedHandle(seed, owner.address, EUINT64_TFHE, SECURITY_ZONE));
    });

    it("does not return the seed as the handle", async function () {
      const handle = existingHandle();

      const returned = await taskManager
        .connect(other)
        .createRandomTask.staticCall(EUINT64_TFHE, handle, SECURITY_ZONE);

      expect(returned).to.not.equal(handle);
    });

    it("encodes the requested type and security zone in the metadata bytes", async function () {
      const returned: bigint = await taskManager
        .connect(owner)
        .createRandomTask.staticCall(EUINT32_TFHE, 99n, 3);

      expect(Number(returned & 0xffn)).to.equal(3);
      expect(Number((returned >> 8n) & 0x7fn)).to.equal(EUINT32_TFHE);
      expect(Number((returned >> 15n) & 0x1n)).to.equal(0);
    });

    it("carries the sender in input3 of TaskCreated", async function () {
      const seed = 42n;

      const receipt = await (
        await taskManager.connect(owner).createRandomTask(EUINT64_TFHE, seed, SECURITY_ZONE)
      ).wait();

      const parsed = receipt.logs
        .map((log: any) => {
          try {
            return taskManager.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((entry: any) => entry?.name === "TaskCreated");

      expect(parsed.args.operation).to.equal("random");
      expect(parsed.args.input1).to.equal(seed);
      expect(parsed.args.input2).to.equal(BigInt(SECURITY_ZONE));
      expect(parsed.args.input3).to.equal(BigInt(owner.address));
    });

    it("gives different callers different handles for the same seed", async function () {
      const seed = 7n;

      const fromOwner = await taskManager
        .connect(owner)
        .createRandomTask.staticCall(EUINT64_TFHE, seed, SECURITY_ZONE);
      const fromOther = await taskManager
        .connect(other)
        .createRandomTask.staticCall(EUINT64_TFHE, seed, SECURITY_ZONE);

      expect(fromOwner).to.not.equal(fromOther);
    });

    it("gives the same caller the same handle for the same seed", async function () {
      const seed = 7n;

      const first = await handleFromTx(
        taskManager,
        await taskManager.connect(owner).createRandomTask(EUINT64_TFHE, seed, SECURITY_ZONE)
      );
      const second = await handleFromTx(
        taskManager,
        await taskManager.connect(owner).createRandomTask(EUINT64_TFHE, seed, SECURITY_ZONE)
      );

      expect(second).to.equal(first);
    });
  });

  describe("access control", function () {
    it("grants nothing on a handle passed as the seed", async function () {
      const handle = existingHandle();

      await (await taskManager.connect(other).createRandomTask(EUINT64_TFHE, handle, SECURITY_ZONE)).wait();

      expect(await acl.isAllowed(handle, other.address)).to.equal(false);
      expect(await acl.persistAllowed(handle, other.address)).to.equal(false);
      expect(await acl.globalAllowed(handle)).to.equal(false);
    });

    it("cannot grant on a handle passed as the seed within one transaction", async function () {
      const handle = existingHandle();

      const Caller = await ethers.getContractFactory("RandomTaskCaller");
      const caller = await Caller.connect(other).deploy();
      await caller.waitForDeployment();

      await expect(
        caller.connect(other).createThenAllow(EUINT64_TFHE, handle, SECURITY_ZONE, handle, other.address)
      ).to.be.revertedWithCustomError(acl, "SenderNotAllowed");

      expect(await acl.isAllowed(handle, other.address)).to.equal(false);
    });

    it("grants on the returned handle only", async function () {
      const handle = existingHandle();

      const Caller = await ethers.getContractFactory("RandomTaskCaller");
      const caller = await Caller.connect(other).deploy();
      await caller.waitForDeployment();

      await (
        await caller.connect(other).createThenAllowReturned(EUINT64_TFHE, handle, SECURITY_ZONE, other.address)
      ).wait();

      const derived = await caller.lastHandle();
      expect(derived).to.not.equal(handle);
      expect(await acl.persistAllowed(derived, other.address)).to.equal(true);
      expect(await acl.persistAllowed(handle, other.address)).to.equal(false);
    });
  });

  describe("auto-generated seed", function () {
    it("produces a different handle on each call", async function () {
      const first = await handleFromTx(
        taskManager,
        await taskManager.connect(owner).createRandomTask(EUINT64_TFHE, 0, SECURITY_ZONE)
      );
      const second = await handleFromTx(
        taskManager,
        await taskManager.connect(owner).createRandomTask(EUINT64_TFHE, 0, SECURITY_ZONE)
      );

      expect(second).to.not.equal(first);
    });

    it("grants the caller access to the new handle", async function () {
      const Caller = await ethers.getContractFactory("RandomTaskCaller");
      const caller = await Caller.connect(owner).deploy();
      await caller.waitForDeployment();

      await (
        await caller.connect(owner).createThenAllowReturned(EUINT64_TFHE, 0, SECURITY_ZONE, owner.address)
      ).wait();

      expect(await acl.persistAllowed(await caller.lastHandle(), owner.address)).to.equal(true);
    });
  });
});
