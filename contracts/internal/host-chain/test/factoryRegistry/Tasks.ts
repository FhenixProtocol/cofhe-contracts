import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { deployOnChainFixture } from "../onChain/OnChain.fixture";
import { runsCurrentBuild } from "../../utils/upgrade";

const { ethers, upgrades } = hre;

const ENV_KEYS = ["SAFE_ADMIN_ADDRESS", "SAFE_OWNER_KEY", "SAFE_BATCH_OUT", "FACTORY_REGISTRY_FILE"] as const;

async function fixture() {
  const { taskManager } = await deployOnChainFixture();
  const [owner, factory, other, worker] = await ethers.getSigners();
  await (await (taskManager as any).connect(owner).enableAccessList()).wait();
  return { tm: taskManager as any, owner, factory, other, worker };
}

async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let message = "";
  try {
    await promise;
  } catch (error: any) {
    message = String(error?.message ?? error);
  }
  expect(message).to.match(pattern);
}

function tempFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "factory-registry-")), name);
}

describe("FactoryRegistry tasks", function () {
  const saved: Record<string, string | undefined> = {};

  before(function () {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  });

  beforeEach(function () {
    // Set rather than deleted: dotenv never overrides a variable that is already present.
    process.env.SAFE_ADMIN_ADDRESS = "";
    process.env.SAFE_OWNER_KEY = "";
    process.env.SAFE_BATCH_OUT = "";
    process.env.FACTORY_REGISTRY_FILE = tempFile("factory-registry.json");
  });

  after(function () {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function deployed(): Promise<any> {
    await hre.run("task:deployFactoryRegistry", { yes: true });
    const chainId = String((await ethers.provider.getNetwork()).chainId);
    const record = JSON.parse(fs.readFileSync(process.env.FACTORY_REGISTRY_FILE!, "utf8"))[chainId];
    return ethers.getContractAt("FactoryRegistry", record.address);
  }

  it("deploys once, with the TaskManager's admin delay, and records the address", async function () {
    const { tm, owner } = await loadFixture(fixture);
    const registry = await deployed();
    expect(await registry.defaultAdmin()).to.equal(owner.address);
    expect(await registry.defaultAdminDelay()).to.equal(await tm.defaultAdminDelay());
    expect(await registry.taskManager()).to.equal(await tm.getAddress());

    await hre.run("task:deployFactoryRegistry", { yes: true }); // re-run: no second registry
    const again = await deployed();
    expect(await again.getAddress()).to.equal(await registry.getAddress());
  });

  it("upgrades a different build back to this one, keeping the tree and the roles", async function () {
    const { tm, owner, factory, worker } = await loadFixture(fixture);
    const registry = await deployed();
    await (await tm.connect(owner).grantRole(await tm.ACCESS_LIST_MANAGER_ROLE(), await registry.getAddress())).wait();
    await (await registry.connect(owner).approveFactory(factory.address)).wait();
    await (await registry.connect(factory).register([worker.address])).wait();
    const address = await registry.getAddress();
    await upgrades.upgradeProxy(address, await ethers.getContractFactory("FactoryRegistryV2Mock"), { kind: "uups" });

    await hre.run("task:upgradeFactoryRegistry", { onlyvalidate: true });
    expect(await runsCurrentBuild(hre, address, "contracts/FactoryRegistry.sol", "FactoryRegistry")).to.equal(false);
    await hre.run("task:upgradeFactoryRegistry", { yes: true });
    expect(await runsCurrentBuild(hre, address, "contracts/FactoryRegistry.sol", "FactoryRegistry")).to.equal(true);
    expect(await registry.nodeOf(worker.address)).to.deep.equal([factory.address, 1n]);
    expect(await registry.hasRole(await registry.UPGRADER_ROLE(), owner.address)).to.equal(true);

    await hre.run("task:upgradeFactoryRegistry", { yes: true }); // re-run: nothing to do
    await hre.run("task:inspectFactoryRegistry", {});
  });
});
