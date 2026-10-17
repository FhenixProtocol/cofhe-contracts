import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { deployOnChainFixture } from "../onChain/OnChain.fixture";

const { ethers } = hre;

const INT8_MIN = -128;
const INT8_MAX = 127;

/**
 * Task-handle metadata stores security zones as int8. Configuring a range outside
 * [-128, 127] would let distinct zones alias in the handle (e.g. 0 and 256).
 * Regression for https://github.com/FhenixProtocol/cofhe-contracts/issues/154
 */
describe("security zone bounds fit int8 metadata", function () {
  let owner: HardhatEthersSigner;
  let taskManager: any;

  before(async function () {
    const fixture = await deployOnChainFixture();
    [owner] = await ethers.getSigners();
    taskManager = fixture.taskManager;
  });

  it("accepts the full int8 range", async function () {
    await expect(taskManager.connect(owner).setSecurityZones(INT8_MIN, INT8_MAX)).to.not.be
      .reverted;
  });

  it("rejects a max above int8 (0..256 aliases zone 0)", async function () {
    await expect(taskManager.connect(owner).setSecurityZones(0, 256))
      .to.be.revertedWithCustomError(taskManager, "InvalidSecurityZone")
      .withArgs(256, INT8_MIN, INT8_MAX);
  });

  it("rejects a min below int8", async function () {
    await expect(taskManager.connect(owner).setSecurityZones(-129, 0))
      .to.be.revertedWithCustomError(taskManager, "InvalidSecurityZone")
      .withArgs(-129, INT8_MIN, INT8_MAX);
  });

  it("rejects setSecurityZoneMax above int8", async function () {
    await taskManager.connect(owner).setSecurityZones(0, 1);
    await expect(taskManager.connect(owner).setSecurityZoneMax(256))
      .to.be.revertedWithCustomError(taskManager, "InvalidSecurityZone")
      .withArgs(256, INT8_MIN, INT8_MAX);
  });
});
