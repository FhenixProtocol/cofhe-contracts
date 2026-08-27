import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { TaskManager } from "../../types";
import { deployOnChainFixture, TASK_MANAGER_ADDRESS } from "../onChain/OnChain.fixture";

const { ethers } = hre;

// The bounds this suite starts from. Set explicitly in `before` rather than assumed from the
// fixture, so the expected event arguments and the on-chain state have one source.
const BASELINE_MIN = -128;
const BASELINE_MAX = 127;

/**
 * Every privileged entry point that mutates TaskManager configuration must announce itself, so
 * off-chain monitoring can alert on administrative changes. These tests pin the payloads: each
 * event carries the value replacing the old one, and where a before-value exists it is carried
 * too, which is what lets an alert be read without a follow-up RPC call.
 */
describe("TaskManager admin change events", function () {
  let taskManager: TaskManager;
  let admin: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let originalAcl: string;
  let originalPlaintextsStorage: string;
  let snapshot: string;

  before(async function () {
    await deployOnChainFixture();
    [admin, other] = await ethers.getSigners();
    taskManager = (await ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS)) as unknown as TaskManager;
    originalAcl = await taskManager.acl();
    originalPlaintextsStorage = await taskManager.plaintextsStorage();
    await taskManager.connect(admin).setSecurityZones(BASELINE_MIN, BASELINE_MAX);
  });

  beforeEach(async function () {
    snapshot = await ethers.provider.send("evm_snapshot", []);
  });

  // Roll the chain back rather than replaying setters: `version` only ever increases, so no
  // sequence of admin calls can restore it.
  afterEach(async function () {
    await ethers.provider.send("evm_revert", [snapshot]);
  });

  it("reports which ACL contract replaced which", async function () {
    await expect(taskManager.connect(admin).setACLContract(other.address))
      .to.emit(taskManager, "ACLContractChanged")
      .withArgs(originalAcl, other.address);
  });

  it("reports which plaintexts storage replaced which", async function () {
    await expect(taskManager.connect(admin).setPlaintextsStorage(other.address))
      .to.emit(taskManager, "PlaintextsStorageChanged")
      .withArgs(originalPlaintextsStorage, other.address);
  });

  it("reports both security zone bounds when both are set", async function () {
    await expect(taskManager.connect(admin).setSecurityZones(-100, 100))
      .to.emit(taskManager, "SecurityZonesChanged")
      .withArgs(BASELINE_MIN, BASELINE_MAX, -100, 100);
  });

  it("reports the unchanged maximum when only the minimum is set", async function () {
    await expect(taskManager.connect(admin).setSecurityZoneMin(-64))
      .to.emit(taskManager, "SecurityZonesChanged")
      .withArgs(BASELINE_MIN, BASELINE_MAX, -64, BASELINE_MAX);
  });

  it("reports the unchanged minimum when only the maximum is set", async function () {
    await expect(taskManager.connect(admin).setSecurityZoneMax(64))
      .to.emit(taskManager, "SecurityZonesChanged")
      .withArgs(BASELINE_MIN, BASELINE_MAX, BASELINE_MIN, 64);
  });

  it("rejects an inverted range rather than announcing it as a normal change", async function () {
    await expect(taskManager.connect(admin).setSecurityZones(10, 5))
      .to.be.revertedWithCustomError(taskManager, "InvalidSecurityZone");
  });

  it("announces the kill switch being thrown", async function () {
    await expect(taskManager.connect(admin).disable())
      .to.emit(taskManager, "EnabledSet")
      .withArgs(false);
  });

  it("announces the kill switch being released", async function () {
    await taskManager.connect(admin).disable();

    await expect(taskManager.connect(admin).enable())
      .to.emit(taskManager, "EnabledSet")
      .withArgs(true);
  });

  it("reports the version it landed on", async function () {
    const nextVersion = Number(await taskManager.getVersion()) + 1;

    await expect(taskManager.connect(admin).incVersion())
      .to.emit(taskManager, "VersionIncremented")
      .withArgs(nextVersion);
  });
});
