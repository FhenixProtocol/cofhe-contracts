/**
 * Round 1 repros — R-A1, R-A2, R-A3, R-A4 (ACL.sol).
 * Runs against the repo's own mock fixtures (placeholder task hashes only;
 * no coprocessor involved).
 */
import { expect } from "chai";
import hre from "hardhat";
import type { Contract } from "ethers";

import { deployDecryptResultFixture } from "../decryptResult/DecryptResult.fixture";

const { ethers } = hre;

describe("hunt R-A1 — delegateAccount can never succeed", function () {
  let taskManager: Contract;
  let acl: Contract;

  beforeEach(async function () {
    const fixture = await deployDecryptResultFixture();
    taskManager = fixture.taskManager as unknown as Contract;
    acl = fixture.acl as unknown as Contract;
  });

  it("the TaskManager exposes no delegateAccount entry point", async function () {
    expect(taskManager.interface.hasFunction("delegateAccount")).to.equal(false);
  });

  it("a direct delegateAccount call reverts, and allowedOnBehalf stays false", async function () {
    const [, , stranger] = await ethers.getSigners();
    await expect(
      acl.connect(stranger).delegateAccount(stranger.address, stranger.address),
    )
      .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
      .withArgs(stranger.address);
    expect(
      await acl.allowedOnBehalf(
        stranger.address,
        123n,
        stranger.address,
        stranger.address,
      ),
    ).to.equal(false);
  });
});

describe("hunt R-A2 — cleanTransientStorage is unreachable", function () {
  let taskManager: Contract;
  let acl: Contract;
  let harness: Contract;

  beforeEach(async function () {
    const fixture = await deployDecryptResultFixture();
    taskManager = fixture.taskManager as unknown as Contract;
    acl = fixture.acl as unknown as Contract;
    const Harness = await ethers.getContractFactory("HuntHarness");
    harness = await Harness.deploy(await taskManager.getAddress());
    await harness.waitForDeployment();
  });

  it("the TaskManager exposes no cleanTransientStorage entry point", async function () {
    expect(taskManager.interface.hasFunction("cleanTransientStorage")).to.equal(
      false,
    );
  });

  it("a direct cleanTransientStorage call reverts", async function () {
    const [, , stranger] = await ethers.getSigners();
    await expect(
      acl.connect(stranger).cleanTransientStorage(),
    )
      .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
      .withArgs(stranger.address);
  });

  it("a transient grant is still visible to a second call in the same transaction", async function () {
    await (await harness.transientAcrossCalls()).wait();
    const handle = await harness.lastHandle();
    expect(await harness.lastBool()).to.equal(true); // live in-tx …
    expect(await acl.isAllowed(handle, await harness.getAddress())).to.equal(
      false, // … and gone at tx end. Nothing ever clears it mid-tx.
    );
  });
});

describe("hunt R-A3 / R-A4 — shares via ShareOrchestrator (one tx each)", function () {
  let taskManager: Contract;
  let acl: Contract;
  let orchestrator: Contract;
  let sharer1: Contract;
  let sharer2: Contract;
  let receiver: Contract;

  beforeEach(async function () {
    const fixture = await deployDecryptResultFixture();
    taskManager = fixture.taskManager as unknown as Contract;
    acl = fixture.acl as unknown as Contract;
    const Orchestrator = await ethers.getContractFactory("ShareOrchestrator");
    orchestrator = await Orchestrator.deploy(await taskManager.getAddress());
    await orchestrator.waitForDeployment();
    const Sharer = await ethers.getContractFactory("ShareSharer");
    sharer1 = await Sharer.deploy();
    await sharer1.waitForDeployment();
    sharer2 = await Sharer.deploy();
    await sharer2.waitForDeployment();
    const Receiver = await ethers.getContractFactory("ShareReceiver");
    receiver = await Receiver.deploy();
    await receiver.waitForDeployment();
  });

  it("R-A3 (fixed): a transient-only share receiver can NO LONGER globalize the handle", async function () {
    await (
      await orchestrator.runEscalation(
        await sharer1.getAddress(),
        await receiver.getAddress(),
      )
    ).wait();
    expect(await orchestrator.escReceived()).to.equal(true);
    expect(await orchestrator.escGlobalized()).to.equal(false);
    expect(await acl.globalAllowed(await orchestrator.escHandle())).to.equal(
      false,
    );
  });

  it("R-A3 (fixed): a transient-only share receiver can NO LONGER mark the handle decryptable", async function () {
    await (
      await orchestrator.runEscalationDecrypt(
        await sharer1.getAddress(),
        await receiver.getAddress(),
      )
    ).wait();
    expect(await orchestrator.escDecryptReceived()).to.equal(true);
    expect(await orchestrator.escDecryptMarked()).to.equal(false);
    expect(
      await acl.isAllowedForDecryption(
        await orchestrator.escDecryptHandle(),
      ),
    ).to.equal(false);
  });

  it("R-A4: a second share overwrites the first — first claim fails, second succeeds", async function () {
    await (
      await orchestrator.runOverwrite(
        await sharer1.getAddress(),
        await sharer2.getAddress(),
        await receiver.getAddress(),
      )
    ).wait();
    expect(await orchestrator.owFirst()).to.equal(false); // first share destroyed
    expect(await orchestrator.owSecond()).to.equal(true);
  });
});
