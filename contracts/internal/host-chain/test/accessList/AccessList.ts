import { expect } from "chai";
import hre from "hardhat";
import type { Contract } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { deployOnChainFixture } from "../onChain/OnChain.fixture";

const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

// A valid euint8 return type and security zone within the fixture's configured range (-128..127).
const EUINT8 = 2;
const SECURITY_ZONE = 0;

// Dummy EncryptedInput; the access-list gate runs before input validation, so the
// contents are irrelevant for the blocked-path assertions.
const DUMMY_INPUT = { ctHash: 1n, securityZone: 0, utype: EUINT8, signature: "0x" };

describe("TaskManager access list", function () {
  let taskManager: Contract;
  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  before(async function () {
    await deployOnChainFixture();
    [owner, other] = await hre.ethers.getSigners();
    taskManager = await hre.ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS);
  });

  // Reset to a clean baseline (disabled, `other` not listed) so tests are order-independent.
  beforeEach(async function () {
    await taskManager.connect(owner).disableAccessList();
    await taskManager.connect(owner).removeFromAccessList([other.address]);
  });

  it("is disabled by default and lets any caller create tasks", async function () {
    expect(await taskManager.accessListEnabled()).to.equal(false);
    expect(await taskManager.accessList(other.address)).to.equal(false);
    await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE)).to.not.be.reverted;
  });

  it("blocks non-listed callers on all three intake functions when enabled", async function () {
    await taskManager.connect(owner).enableAccessList();

    await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE))
      .to.be.revertedWithCustomError(taskManager, "NotOnAccessList")
      .withArgs(other.address);

    await expect(taskManager.connect(other).createTask(EUINT8, 8 /* add */, [1n, 2n], []))
      .to.be.revertedWithCustomError(taskManager, "NotOnAccessList")
      .withArgs(other.address);

    await expect(taskManager.connect(other).verifyInput(DUMMY_INPUT, other.address))
      .to.be.revertedWithCustomError(taskManager, "NotOnAccessList")
      .withArgs(other.address);
  });

  it("lets a listed caller through, and re-blocks after removal", async function () {
    await taskManager.connect(owner).enableAccessList();

    await taskManager.connect(owner).addToAccessList([other.address]);
    expect(await taskManager.accessList(other.address)).to.equal(true);
    await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE)).to.not.be.reverted;

    await taskManager.connect(owner).removeFromAccessList([other.address]);
    await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE))
      .to.be.revertedWithCustomError(taskManager, "NotOnAccessList")
      .withArgs(other.address);
  });

  it("reopens to everyone once disabled again", async function () {
    await taskManager.connect(owner).enableAccessList();
    await taskManager.connect(owner).disableAccessList();
    await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE)).to.not.be.reverted;
  });

  it("restricts every admin function to the owner", async function () {
    await expect(taskManager.connect(other).enableAccessList())
      .to.be.revertedWithCustomError(taskManager, "OwnableUnauthorizedAccount");
    await expect(taskManager.connect(other).disableAccessList())
      .to.be.revertedWithCustomError(taskManager, "OwnableUnauthorizedAccount");
    await expect(taskManager.connect(other).addToAccessList([other.address]))
      .to.be.revertedWithCustomError(taskManager, "OwnableUnauthorizedAccount");
    await expect(taskManager.connect(other).removeFromAccessList([other.address]))
      .to.be.revertedWithCustomError(taskManager, "OwnableUnauthorizedAccount");
  });

  it("rejects the zero address when adding", async function () {
    await expect(taskManager.connect(owner).addToAccessList([hre.ethers.ZeroAddress]))
      .to.be.revertedWithCustomError(taskManager, "InvalidAddress");
  });

  it("emits events on toggle and membership changes", async function () {
    await expect(taskManager.connect(owner).enableAccessList())
      .to.emit(taskManager, "AccessListEnabledSet").withArgs(true);
    await expect(taskManager.connect(owner).disableAccessList())
      .to.emit(taskManager, "AccessListEnabledSet").withArgs(false);
    await expect(taskManager.connect(owner).addToAccessList([other.address]))
      .to.emit(taskManager, "AccessGranted").withArgs(other.address);
    await expect(taskManager.connect(owner).removeFromAccessList([other.address]))
      .to.emit(taskManager, "AccessRevoked").withArgs(other.address);
  });

  it("supports batch add in a single call", async function () {
    const [, , third] = await hre.ethers.getSigners();
    await taskManager.connect(owner).addToAccessList([other.address, third.address]);
    expect(await taskManager.accessList(other.address)).to.equal(true);
    expect(await taskManager.accessList(third.address)).to.equal(true);
    await taskManager.connect(owner).removeFromAccessList([other.address, third.address]);
  });
});
