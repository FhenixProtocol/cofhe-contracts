import { expect } from "chai";
import hre from "hardhat";
import type { Contract } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { deployOnChainFixture } from "../onChain/OnChain.fixture";


// A valid euint8 return type and security zone within the fixture's configured range (-128..127).
const EUINT8 = 2;
const SECURITY_ZONE = 0;

// Dummy UnsignedEncryptedInput batch; the access-list gate runs before input
// validation, so the contents are irrelevant for the blocked-path assertions.
const DUMMY_INPUTS = [{ ctHash: 1n, securityZone: 0, utype: EUINT8 }];

describe("TaskManager access list", function () {
  let taskManager: Contract;
  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  before(async function () {
    const fixture = await deployOnChainFixture();
    [owner, other] = await hre.ethers.getSigners();
    taskManager = fixture.taskManager;
  });

  // Reset to a clean baseline (disabled, `other` not listed) so tests are order-independent.
  beforeEach(async function () {
    await taskManager.connect(owner).disableAccessList();
    await taskManager.connect(owner).removeFromAccessList([other.address]);
    await taskManager.connect(owner).setDenyList([other.address], false);
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

    await expect(taskManager.connect(other).batchVerifyInputs(DUMMY_INPUTS, other.address, "0x"))
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
      .to.be.revertedWithCustomError(taskManager, "AccessControlUnauthorizedAccount");
    await expect(taskManager.connect(other).disableAccessList())
      .to.be.revertedWithCustomError(taskManager, "AccessControlUnauthorizedAccount");
    await expect(taskManager.connect(other).addToAccessList([other.address]))
      .to.be.revertedWithCustomError(taskManager, "AccessControlUnauthorizedAccount");
    await expect(taskManager.connect(other).removeFromAccessList([other.address]))
      .to.be.revertedWithCustomError(taskManager, "AccessControlUnauthorizedAccount");
  });

  it("names the ACCESS_LIST_MANAGER_ROLE in the revert for non-holders", async function () {
    const role = await taskManager.ACCESS_LIST_MANAGER_ROLE();
    await expect(taskManager.connect(other).enableAccessList())
      .to.be.revertedWithCustomError(taskManager, "AccessControlUnauthorizedAccount")
      .withArgs(other.address, role);
  });

  it("rejects the zero address when adding or removing", async function () {
    await expect(taskManager.connect(owner).addToAccessList([hre.ethers.ZeroAddress]))
      .to.be.revertedWithCustomError(taskManager, "InvalidAddress");
    await expect(taskManager.connect(owner).removeFromAccessList([hre.ethers.ZeroAddress]))
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

  describe("deny list", function () {
    it("blocks deny-listed callers on all three intake functions while the access list is disabled", async function () {
      await taskManager.connect(owner).setDenyList([other.address], true);
      expect(await taskManager.denyList(other.address)).to.equal(true);

      await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE))
        .to.be.revertedWithCustomError(taskManager, "OnDenyList")
        .withArgs(other.address);

      await expect(taskManager.connect(other).createTask(EUINT8, 8 /* add */, [1n, 2n], []))
        .to.be.revertedWithCustomError(taskManager, "OnDenyList")
        .withArgs(other.address);

      await expect(taskManager.connect(other).batchVerifyInputs(DUMMY_INPUTS, other.address, "0x"))
        .to.be.revertedWithCustomError(taskManager, "OnDenyList")
        .withArgs(other.address);
    });

    it("does not affect callers that are not deny-listed", async function () {
      const [, , third] = await hre.ethers.getSigners();
      await taskManager.connect(owner).setDenyList([third.address], true);
      await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE)).to.not.be.reverted;
      await taskManager.connect(owner).setDenyList([third.address], false);
    });

    it("lets a caller through again after removal", async function () {
      await taskManager.connect(owner).setDenyList([other.address], true);
      await taskManager.connect(owner).setDenyList([other.address], false);
      expect(await taskManager.denyList(other.address)).to.equal(false);
      await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE)).to.not.be.reverted;
    });

    it("is ignored while the access list is enabled", async function () {
      await taskManager.connect(owner).setDenyList([other.address], true);
      await taskManager.connect(owner).enableAccessList();
      await taskManager.connect(owner).addToAccessList([other.address]);
      await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE)).to.not.be.reverted;
    });

    it("restricts setDenyList to the ACCESS_LIST_MANAGER_ROLE", async function () {
      const role = await taskManager.ACCESS_LIST_MANAGER_ROLE();
      await expect(taskManager.connect(other).setDenyList([other.address], true))
        .to.be.revertedWithCustomError(taskManager, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, role);
      await expect(taskManager.connect(other).setDenyList([other.address], false))
        .to.be.revertedWithCustomError(taskManager, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, role);
    });

    it("rejects the zero address when adding or removing", async function () {
      await expect(taskManager.connect(owner).setDenyList([hre.ethers.ZeroAddress], true))
        .to.be.revertedWithCustomError(taskManager, "InvalidAddress");
      await expect(taskManager.connect(owner).setDenyList([hre.ethers.ZeroAddress], false))
        .to.be.revertedWithCustomError(taskManager, "InvalidAddress");
    });

    it("emits events on membership changes", async function () {
      await expect(taskManager.connect(owner).setDenyList([other.address], true))
        .to.emit(taskManager, "DenyListSet").withArgs(other.address, true);
      await expect(taskManager.connect(owner).setDenyList([other.address], false))
        .to.emit(taskManager, "DenyListSet").withArgs(other.address, false);
    });
  });
});
