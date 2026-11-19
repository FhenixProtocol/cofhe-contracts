import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { deployOnChainFixture } from "../onChain/OnChain.fixture";
import { runsCurrentBuild } from "../../utils/upgrade";
import { logsOf } from "../helpers/logs";

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

  async function ready(): Promise<any> {
    const registry = await deployed();
    await hre.run("task:grantRegistryRole", {});
    return registry;
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

  it("grants the TaskManager role once, and refuses while an admin transfer is pending", async function () {
    const { tm, owner, other } = await loadFixture(fixture);
    const registry = await deployed();
    await (await registry.connect(owner).beginDefaultAdminTransfer(other.address)).wait();
    await expectRejection(hre.run("task:grantRegistryRole", {}), /pending/);

    await (await registry.connect(owner).cancelDefaultAdminTransfer()).wait();
    await (await registry.connect(owner).changeDefaultAdminDelay(1)).wait(); // a pending delay change
    await expectRejection(hre.run("task:grantRegistryRole", {}), /admin delay/);

    await (await registry.connect(owner).rollbackDefaultAdminDelay()).wait();
    await hre.run("task:grantRegistryRole", {});
    expect(await tm.hasRole(await tm.ACCESS_LIST_MANAGER_ROLE(), await registry.getAddress())).to.equal(true);
    await hre.run("task:grantRegistryRole", {}); // re-run: nothing to do
  });

  it("approves a factory once, and refuses an address ops listed by hand", async function () {
    const { tm, owner, factory, other } = await loadFixture(fixture);
    const registry = await ready();
    await hre.run("task:approveFactory", { factory: factory.address });
    expect((await registry.nodeOf(factory.address))[0]).to.equal(await registry.getAddress());
    expect(await tm.accessList(factory.address)).to.equal(true);
    await hre.run("task:approveFactory", { factory: factory.address }); // re-run: nothing to do

    await (await tm.connect(owner).addToAccessList([other.address])).wait();
    await expectRejection(hre.run("task:approveFactory", { factory: other.address }), /by hand/);

    await (await tm.connect(owner).removeFromAccessList([factory.address])).wait(); // ops removed it by hand
    await expectRejection(hre.run("task:approveFactory", { factory: factory.address }), /not on the TaskManager list/);
  });

  it("adopts a hand-listed factory and its contracts, keeping their access", async function () {
    const { tm, owner, factory, worker, other } = await loadFixture(fixture);
    const registry = await ready();
    await (await tm.connect(owner).addToAccessList([factory.address, worker.address])).wait();
    await expectRejection(hre.run("task:approveFactory", { factory: factory.address }), /task:adoptIntoRegistry/);

    await hre.run("task:adoptIntoRegistry", { accounts: factory.address });
    await hre.run("task:adoptIntoRegistry", { accounts: worker.address, parent: factory.address });
    expect(await registry.nodeOf(factory.address)).to.deep.equal([await registry.getAddress(), 0n]);
    expect(await registry.nodeOf(worker.address)).to.deep.equal([factory.address, 1n]);
    expect(await tm.accessList(worker.address)).to.equal(true);
    await hre.run("task:adoptIntoRegistry", { accounts: worker.address, parent: factory.address }); // re-run: nothing to do

    await expectRejection(hre.run("task:adoptIntoRegistry", { accounts: other.address, parent: factory.address }), /not on the TaskManager list/);
  });

  it("takes back a squatted factory address only as one atomic Safe batch", async function () {
    const { owner, factory, other } = await loadFixture(fixture);
    const safe = ethers.Wallet.createRandom().connect(ethers.provider);
    await (await owner.sendTransaction({ to: safe.address, value: ethers.parseEther("1") })).wait();
    process.env.SAFE_ADMIN_ADDRESS = safe.address;
    const registry = await ready(); // the Safe holds the registry roles
    process.env.SAFE_OWNER_KEY = safe.privateKey;
    await hre.run("task:approveFactory", { factory: factory.address });
    await (await registry.connect(factory).register([other.address])).wait(); // squats `other`

    // With SAFE_OWNER_KEY the two calls would be two transactions: refused.
    await expectRejection(hre.run("task:approveFactory", { factory: other.address }), /atomic only as one Safe batch/);

    // Without it, both calls go into one batch.
    process.env.SAFE_OWNER_KEY = "";
    const out = tempFile("batch.json");
    await hre.run("task:approveFactory", { factory: other.address, out });
    const batch = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(batch.transactions.map((t: any) => t.data)).to.deep.equal([
      registry.interface.encodeFunctionData("unregister", [other.address]),
      registry.interface.encodeFunctionData("approveFactory", [other.address]),
    ]);
  });

  it("unregisters a subtree, and refuses an unknown target", async function () {
    const { tm, factory, worker, other } = await loadFixture(fixture);
    const registry = await ready();
    await hre.run("task:approveFactory", { factory: factory.address });
    await (await registry.connect(factory).register([worker.address])).wait();

    await hre.run("task:unregisterFromRegistry", { target: factory.address });
    expect(await tm.accessList(factory.address)).to.equal(false);
    expect(await tm.accessList(worker.address)).to.equal(false);
    await expectRejection(hre.run("task:unregisterFromRegistry", { target: other.address }), /not registered/);
  });

  it("warns that unregistering blocks nothing while the access list is disabled", async function () {
    const { tm, owner, factory, worker } = await loadFixture(fixture);
    const registry = await ready();
    await hre.run("task:approveFactory", { factory: factory.address });
    await (await registry.connect(factory).register([worker.address])).wait();

    const enabled = await logsOf(() => hre.run("task:unregisterFromRegistry", { target: worker.address }));
    expect(enabled).not.to.match(/blocks nothing/);

    await (await registry.connect(factory).register([worker.address])).wait();
    await (await tm.connect(owner).disableAccessList()).wait();
    const disabled = await logsOf(() => hre.run("task:unregisterFromRegistry", { target: worker.address }));
    expect(disabled).to.match(/unregistering blocks nothing now.*task:addToDenyList/);
  });

  it("grants and revokes REVOKER_ROLE for an ops key", async function () {
    const { other } = await loadFixture(fixture);
    const registry = await deployed();
    const role = await registry.REVOKER_ROLE();
    await hre.run("task:setRegistryRevoker", { account: other.address });
    expect(await registry.hasRole(role, other.address)).to.equal(true);
    await hre.run("task:setRegistryRevoker", { account: other.address, revoke: true });
    expect(await registry.hasRole(role, other.address)).to.equal(false);
  });

  it("approves through the Safe, or writes a batch when SAFE_OWNER_KEY is unset", async function () {
    const { tm, owner, factory } = await loadFixture(fixture);
    const safe = ethers.Wallet.createRandom().connect(ethers.provider);
    await (await owner.sendTransaction({ to: safe.address, value: ethers.parseEther("1") })).wait();
    process.env.SAFE_ADMIN_ADDRESS = safe.address;
    const registry = await deployed(); // the Safe is the admin and holds every role
    await hre.run("task:grantRegistryRole", {}); // the signer still holds the TaskManager admin role

    const out = tempFile("batch.json");
    await hre.run("task:approveFactory", { factory: factory.address, out });
    const batch = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(batch.transactions[0].data).to.equal(registry.interface.encodeFunctionData("approveFactory", [factory.address]));
    expect(await tm.accessList(factory.address)).to.equal(false);

    process.env.SAFE_OWNER_KEY = safe.privateKey;
    await hre.run("task:approveFactory", { factory: factory.address });
    expect(await tm.accessList(factory.address)).to.equal(true);
  });

  it("upgrades a different build back to this one, keeping the tree and the roles", async function () {
    const { owner, factory, worker } = await loadFixture(fixture);
    const registry = await ready();
    await hre.run("task:approveFactory", { factory: factory.address });
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
