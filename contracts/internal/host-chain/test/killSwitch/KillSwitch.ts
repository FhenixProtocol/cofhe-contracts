import { expect } from "chai";
import hre from "hardhat";
import type { Contract } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { deployOnChainFixture } from "../onChain/OnChain.fixture";

const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

// A valid euint8 return type and security zone within the fixture's configured range (-128..127).
const EUINT8 = 2;
const SECURITY_ZONE = 0;

describe("TaskManager isEnabled kill-switch", function () {
  let taskManager: Contract;
  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  before(async function () {
    await deployOnChainFixture();
    [owner, other] = await hre.ethers.getSigners();
    taskManager = await hre.ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS);
  });

  // Start every test from the enabled baseline so they are order-independent.
  beforeEach(async function () {
    await taskManager.connect(owner).enable();
  });

  it("gates createRandomTask when disabled", async function () {
    await taskManager.connect(owner).disable();

    await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE))
      .to.be.revertedWithCustomError(taskManager, "CofheIsUnavailable");
  });

  it("allows createRandomTask once re-enabled", async function () {
    await taskManager.connect(owner).disable();
    await taskManager.connect(owner).enable();

    await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE)).to.not.be.reverted;
  });
});
