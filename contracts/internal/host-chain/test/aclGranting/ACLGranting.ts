/**
 * ACL granting — who may write an ACL permission bit, and what a grant confers.
 *
 * Covers four of the access-control assumptions the ACL rests on:
 *
 *   1. ACL state is mutable only through the TaskManager. Every mutator opens with a
 *      `msg.sender != TASK_MANAGER_ADDRESS` guard, so the `requester` argument — which the
 *      TaskManager fills in with the true caller — can never be chosen by an attacker.
 *   3. You cannot grant access you do not hold. The persistent verbs re-check the requester
 *      against `isAllowed` before writing.
 *   4. The `requester == TASK_MANAGER_ADDRESS` bypass in `allowTransient` is not forgeable
 *      from outside, because guard (1) fires first.
 *   5. `isAllowed` is exactly transient OR persistent OR global. `allowedForDecryption` is a
 *      separate flag and confers no compute access.
 *
 * Handles are bootstrapped through RandomTaskCaller: `createRandomTask` grants the calling
 * contract transient access to the handle it derives, and the same transaction converts that
 * into a persistent grant for an EOA. That bootstrap is itself the proof that transient access
 * is live within a transaction — the `allow` leg can only succeed while it is.
 */

import { expect } from "chai";
import hre from "hardhat";
import type { Contract } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { deployDecryptResultFixture } from "../decryptResult/DecryptResult.fixture";

const { ethers } = hre;

const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";
const EUINT64_TFHE = 5;
const SECURITY_ZONE = 0;
const SEED = 0xacen;

const METADATA_MASK = (1n << 16n) - 1n;

/// A handle shaped like the result of an earlier operation — valid type and zone, isTrivial
/// clear — that nobody in these tests has ever been granted.
function unownedHandle(): bigint {
  const body = BigInt(ethers.keccak256(ethers.toUtf8Bytes("a handle nobody owns")));
  return (body & ~METADATA_MASK) | (BigInt(EUINT64_TFHE) << 8n) | BigInt(SECURITY_ZONE);
}

describe("ACL granting", function () {
  let taskManager: Contract;
  let acl: Contract;

  let holder: HardhatEthersSigner;
  let receiver: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  // A handle `holder` has a persistent grant on, and the contract that minted it.
  let handle: bigint;
  let minter: string;

  const UNOWNED = unownedHandle();

  beforeEach(async function () {
    const fixture = await deployDecryptResultFixture();
    taskManager = fixture.taskManager as unknown as Contract;
    acl = fixture.acl as unknown as Contract;

    // The fixture takes signers[0] (admin) and signers[1]; take three fresh ones so no test
    // subject also happens to hold a role.
    [, , holder, receiver, stranger] = await ethers.getSigners();

    const Caller = await ethers.getContractFactory("RandomTaskCaller");
    const caller = await Caller.connect(holder).deploy();
    await caller.waitForDeployment();
    await (
      await caller.connect(holder).createThenAllowReturned(EUINT64_TFHE, SEED, SECURITY_ZONE, holder.address)
    ).wait();

    handle = await caller.lastHandle();
    minter = await caller.getAddress();
  });

  describe("only the TaskManager may write ACL state", function () {
    it("rejects a direct allow", async function () {
      await expect(acl.connect(stranger).allow(handle, stranger.address, stranger.address))
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(stranger.address);
    });

    it("rejects a direct allowGlobal", async function () {
      await expect(acl.connect(stranger).allowGlobal(handle, stranger.address))
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(stranger.address);
    });

    it("rejects a direct allowForDecryption", async function () {
      await expect(acl.connect(stranger).allowForDecryption([handle], stranger.address))
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(stranger.address);
    });

    it("rejects a direct allowTransient", async function () {
      await expect(acl.connect(stranger).allowTransient(handle, stranger.address, stranger.address))
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(stranger.address);
    });

    it("rejects a direct batchAllowTransient", async function () {
      await expect(acl.connect(stranger).batchAllowTransient([handle], stranger.address, stranger.address))
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(stranger.address);
    });

    it("rejects a direct delegateAccount", async function () {
      await expect(acl.connect(stranger).delegateAccount(receiver.address, minter))
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(stranger.address);
    });

    it("rejects a direct cleanTransientStorage", async function () {
      await expect(acl.connect(stranger).cleanTransientStorage())
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(stranger.address);
    });

    it("rejects a direct call that names a real holder as the requester", async function () {
      // `requester` is attacker-chosen on a direct call, so naming someone who genuinely holds
      // the handle would launder the ownership check. The msg.sender guard has to fire first.
      await expect(acl.connect(stranger).allow(handle, stranger.address, holder.address))
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(stranger.address);

      expect(await acl.persistAllowed(handle, stranger.address)).to.equal(false);
    });

    it("rejects a direct allowTransient that names the TaskManager as the requester", async function () {
      // allowTransient waives the ownership check when requester == TASK_MANAGER_ADDRESS. Forging
      // that requester from outside must not reach the waiver.
      await expect(acl.connect(stranger).allowTransient(UNOWNED, stranger.address, TASK_MANAGER_ADDRESS))
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(stranger.address);

      expect(await acl.isAllowed(UNOWNED, stranger.address)).to.equal(false);
    });
  });

  describe("you cannot grant access you do not hold", function () {
    it("grants when the requester holds the handle", async function () {
      await (await taskManager.connect(holder).allow(handle, receiver.address)).wait();

      expect(await acl.persistAllowed(handle, receiver.address)).to.equal(true);
    });

    it("grants only the handle named, and only to the account named", async function () {
      await (await taskManager.connect(holder).allow(handle, receiver.address)).wait();

      expect(await acl.persistAllowed(UNOWNED, receiver.address)).to.equal(false);
      expect(await acl.persistAllowed(handle, stranger.address)).to.equal(false);
      expect(await acl.globalAllowed(handle)).to.equal(false);
    });

    it("reverts allow from an account that does not hold the handle", async function () {
      await expect(taskManager.connect(stranger).allow(handle, stranger.address))
        .to.be.revertedWithCustomError(acl, "SenderNotAllowed")
        .withArgs(stranger.address);
    });

    it("reverts allowGlobal from an account that does not hold the handle", async function () {
      await expect(taskManager.connect(stranger).allowGlobal(handle))
        .to.be.revertedWithCustomError(acl, "SenderNotAllowed")
        .withArgs(stranger.address);
    });

    it("reverts allowForDecryption from an account that does not hold the handle", async function () {
      await expect(taskManager.connect(stranger).allowForDecryption(handle))
        .to.be.revertedWithCustomError(acl, "SenderNotAllowed")
        .withArgs(stranger.address);
    });

    it("reverts allowTransient from an account that does not hold the handle", async function () {
      await expect(taskManager.connect(stranger).allowTransient(handle, stranger.address))
        .to.be.revertedWithCustomError(acl, "SenderNotAllowed")
        .withArgs(stranger.address);
    });

    it("lets a grantee re-grant, so a persistent grant is transitive", async function () {
      await (await taskManager.connect(holder).allow(handle, receiver.address)).wait();

      await (await taskManager.connect(receiver).allow(handle, stranger.address)).wait();

      expect(await acl.persistAllowed(handle, stranger.address)).to.equal(true);
    });
  });

  describe("isAllowed is transient OR persistent OR global", function () {
    it("counts a persistent grant as access, for that account only", async function () {
      await (await taskManager.connect(holder).allow(handle, receiver.address)).wait();

      expect(await acl.isAllowed(handle, receiver.address)).to.equal(true);
      expect(await acl.isAllowed(handle, stranger.address)).to.equal(false);
    });

    it("counts a global grant as access for any account", async function () {
      await (await taskManager.connect(holder).allowGlobal(handle)).wait();

      expect(await acl.globalAllowed(handle)).to.equal(true);
      expect(await acl.isAllowed(handle, stranger.address)).to.equal(true);
      // Global access is not a persistent pair — the two maps stay distinct.
      expect(await acl.persistAllowed(handle, stranger.address)).to.equal(false);
    });

    it("does not count decryption-eligibility as compute access", async function () {
      await (await taskManager.connect(holder).allowForDecryption(handle)).wait();

      expect(await acl.isAllowedForDecryption(handle)).to.equal(true);
      expect(await acl.isAllowed(handle, stranger.address)).to.equal(false);
    });

    it("drops transient access at the end of the transaction", async function () {
      // The bootstrap only got this far because the minting contract held transient access to
      // `handle` while its transaction ran — `allow` re-checks the requester. Once that
      // transaction ended the transient grant is gone, while the persistent one it produced stays.
      expect(await acl.persistAllowed(handle, holder.address)).to.equal(true);
      expect(await acl.allowedTransient(handle, minter)).to.equal(false);
      expect(await acl.isAllowed(handle, minter)).to.equal(false);
    });
  });
});
