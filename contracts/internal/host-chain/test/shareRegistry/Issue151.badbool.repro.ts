import { expect } from "chai";
import hre from "hardhat";
const { ethers, upgrades } = hre;

describe("Issue 151 follow-up: non-boolean revoker return", function () {
  let issuer: any;
  let recipient: any;
  let registry: any;
  let bad: any;
  let honest: any;

  function acp(overrides: any = {}) {
    return {
      issuer: issuer.address,
      expiration: 4102444800n,
      recipient: recipient.address,
      revokerData: 0n,
      revokerContract: ethers.ZeroAddress,
      scope: 2,
      contracts: [],
      handles: [ethers.id("balance")],
      sealingKey: ethers.ZeroHash,
      issuerSignature: "0x" + "11".repeat(65),
      recipientSignature: "0x",
      ...overrides,
    };
  }

  before(async function () {
    [, issuer, recipient] = await ethers.getSigners();
  });

  beforeEach(async function () {
    const factory = await ethers.getContractFactory("ACPShareRegistry");
    registry = await upgrades.deployProxy(factory, [issuer.address], { kind: "uups", initializer: "initialize" });
    await registry.waitForDeployment();
    bad = await (await ethers.getContractFactory("BadBoolRevoker")).deploy();
    await bad.waitForDeployment();
    honest = await (await ethers.getContractFactory("HonestRevoker")).deploy();
    await honest.waitForDeployment();
  });

  it("sharesFor must skip a share whose revoker returns the word 2", async function () {
    await registry.connect(issuer).share(acp({ revokerData: 1n, revokerContract: await bad.getAddress(), handles: [ethers.id("poison")] }), "0x");
    await registry.connect(issuer).share(acp({ revokerData: 1n, revokerContract: await honest.getAddress(), handles: [ethers.id("ok")] }), "0x");
    const res = await registry.sharesFor(recipient.address);
    expect(res[0].length).to.equal(1);
  });

  it("sharesForPage must skip it too", async function () {
    await registry.connect(issuer).share(acp({ revokerData: 1n, revokerContract: await bad.getAddress(), handles: [ethers.id("poison")] }), "0x");
    await registry.connect(issuer).share(acp({ revokerData: 1n, revokerContract: await honest.getAddress(), handles: [ethers.id("ok")] }), "0x");
    const res = await registry.sharesForPage(recipient.address, 0, 10);
    expect(res[0].length).to.equal(1);
  });
});
