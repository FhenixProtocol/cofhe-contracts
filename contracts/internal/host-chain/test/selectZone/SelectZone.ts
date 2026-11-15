import { expect } from "chai";
import hre from "hardhat";
import { deployOnChainFixture } from "../onChain/OnChain.fixture";

const { ethers } = hre;

// Security zone of a handle lives in its last byte, as int8.
const zoneOf = (handle: string) => Number(BigInt.asIntN(8, BigInt(handle) & 0xffn));

describe("TaskManager select: security zone of the control input", function () {
  let taskManager: any;
  let probe: any;

  before(async function () {
    const fixture = await deployOnChainFixture(); // zones -128..127 enabled
    taskManager = fixture.taskManager;
    probe = await (await ethers.getContractFactory("SelectZoneProbe")).deploy();
    await probe.waitForDeployment();
  });

  it("binary ops already reject operands from different zones", async function () {
    await expect(probe.addAcrossZones(0, 1))
      .to.be.revertedWithCustomError(taskManager, "InvalidTypeOrSecurityZone")
      .withArgs("add");
  });

  it("select accepts a control from the same zone as its branches", async function () {
    await probe.selectAcrossZones(1, 1);
    expect(zoneOf(await probe.lastResult())).to.equal(1);
  });

  it("select rejects a control from a different zone than its branches", async function () {
    await expect(probe.selectAcrossZones(0, 1))
      .to.be.revertedWithCustomError(taskManager, "InvalidTypeOrSecurityZone")
      .withArgs("select");
  });
});
