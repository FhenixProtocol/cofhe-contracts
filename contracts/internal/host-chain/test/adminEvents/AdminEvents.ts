import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { deployOnChainFixture, TASK_MANAGER_ADDRESS } from "../onChain/OnChain.fixture";

const { ethers } = hre;

// The range the fixture initializes the TaskManager with.
const BASELINE_MIN = -128;
const BASELINE_MAX = 127;

/**
 * Every privileged entry point that mutates TaskManager configuration must announce itself, so
 * off-chain monitoring can alert on administrative changes. These tests pin the payloads: each
 * event carries both the value being replaced and the value replacing it, which is what lets an
 * alert be read without a follow-up RPC call.
 */
describe("TaskManager admin change events", function () {
  let taskManager: any;
  let admin: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let originalAcl: string;
  let originalPlaintextsStorage: string;

  before(async function () {
    await deployOnChainFixture();
    [admin, other] = await ethers.getSigners();
    taskManager = await ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS);
    originalAcl = await taskManager.acl();
    originalPlaintextsStorage = await taskManager.plaintextsStorage();
  });

  // Restore the fixture's configuration so the tests are order-independent.
  afterEach(async function () {
    await taskManager.connect(admin).setACLContract(originalAcl);
    await taskManager.connect(admin).setPlaintextsStorage(originalPlaintextsStorage);
    await taskManager.connect(admin).setSecurityZones(BASELINE_MIN, BASELINE_MAX);
    await taskManager.connect(admin).enable();
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
