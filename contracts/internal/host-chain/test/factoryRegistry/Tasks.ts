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

/** Everything `run` prints with console.log, joined by newlines. */
async function logsOf(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
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
    await hre.run("task:grantRegistryRole", { yes: true });
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
    await expectRejection(hre.run("task:grantRegistryRole", { yes: true }), /pending/);

    await (await registry.connect(owner).cancelDefaultAdminTransfer()).wait();
    await (await registry.connect(owner).changeDefaultAdminDelay(1)).wait(); // a pending delay change
    await expectRejection(hre.run("task:grantRegistryRole", { yes: true }), /admin delay/);

    await (await registry.connect(owner).rollbackDefaultAdminDelay()).wait();
    await hre.run("task:grantRegistryRole", { yes: true });
    expect(await tm.hasRole(await tm.ACCESS_LIST_MANAGER_ROLE(), await registry.getAddress())).to.equal(true);
    await hre.run("task:grantRegistryRole", { yes: true }); // re-run: nothing to do
  });

  it("refuses to grant the role when the record does not point at the deployed proxy", async function () {
    const { tm } = await loadFixture(fixture);
    const registry = await deployed();
    // The implementation carries the same build but is not the proxy: a copied slot must not pass.
    const implementation = await upgrades.erc1967.getImplementationAddress(await registry.getAddress());
    const chainId = String((await ethers.provider.getNetwork()).chainId);
    fs.writeFileSync(process.env.FACTORY_REGISTRY_FILE!, JSON.stringify({ [chainId]: { address: implementation } }));

    await expectRejection(hre.run("task:grantRegistryRole", { yes: true }), /not the ERC1967 proxy/);
    expect(await tm.hasRole(await tm.ACCESS_LIST_MANAGER_ROLE(), implementation)).to.equal(false);
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

  it("revokes a tree node with its subtree and a hand-listed account in one run", async function () {
    const { tm, owner, factory, worker, other } = await loadFixture(fixture);
    const registry = await ready();
    await hre.run("task:approveFactory", { factory: factory.address });
    await (await registry.connect(factory).register([worker.address])).wait();
    await (await tm.connect(owner).addToAccessList([other.address])).wait();
    const none = ethers.Wallet.createRandom().address;

    // worker sits below factory: it goes with it, and a second unregister would revert the batch.
    const logs = await logsOf(() =>
      hre.run("task:revokeAccess", { accounts: [worker.address, factory.address, other.address, none].join(","), yes: true }),
    );
    expect(logs).to.match(/removed with an account above it/);
    expect(logs).to.match(/no access to revoke/);
    for (const a of [factory.address, worker.address, other.address]) expect(await tm.accessList(a)).to.equal(false);
    expect((await registry.nodeOf(factory.address))[0]).to.equal(ethers.ZeroAddress);

    await hre.run("task:revokeAccess", { accounts: other.address, yes: true }); // re-run: nothing to do
  });

  it("removes a tracked account by hand when the registry no longer controls the list", async function () {
    const { tm, owner, factory, worker } = await loadFixture(fixture);
    const registry = await ready();
    await hre.run("task:approveFactory", { factory: factory.address });
    await (await registry.connect(factory).register([worker.address])).wait();
    await (await tm.connect(owner).revokeRole(await tm.ACCESS_LIST_MANAGER_ROLE(), await registry.getAddress())).wait();

    const logs = await logsOf(() => hre.run("task:revokeAccess", { accounts: worker.address, yes: true }));
    expect(logs).to.match(/does not control this TaskManager list/);
    expect(await tm.accessList(worker.address)).to.equal(false);
  });

  it("puts the unregister and the list removal into one Safe batch", async function () {
    const { tm, owner, factory, worker, other } = await loadFixture(fixture);
    const safe = ethers.Wallet.createRandom().connect(ethers.provider);
    await (await owner.sendTransaction({ to: safe.address, value: ethers.parseEther("1") })).wait();
    process.env.SAFE_ADMIN_ADDRESS = safe.address;
    const registry = await ready(); // the Safe holds the registry roles
    process.env.SAFE_OWNER_KEY = safe.privateKey;
    await hre.run("task:approveFactory", { factory: factory.address });
    await (await registry.connect(factory).register([worker.address])).wait();
    const listRole = await tm.ACCESS_LIST_MANAGER_ROLE();
    await (await tm.connect(owner).addToAccessList([other.address])).wait();
    await (await tm.connect(owner).grantRole(listRole, safe.address)).wait();
    await (await tm.connect(owner).revokeRole(listRole, owner.address)).wait();

    process.env.SAFE_OWNER_KEY = "";
    const out = tempFile("batch.json");
    await hre.run("task:revokeAccess", { accounts: `${factory.address},${other.address}`, yes: true, out });
    const batch = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(batch.transactions.map((t: any) => t.data)).to.deep.equal([
      registry.interface.encodeFunctionData("unregister", [factory.address]),
      tm.interface.encodeFunctionData("removeFromAccessList", [[other.address]]),
    ]);
    expect(await tm.accessList(other.address)).to.equal(true);
  });

  it("warns that revoking blocks nothing while the access list is disabled", async function () {
    const { tm, owner, other } = await loadFixture(fixture);
    await ready();
    await (await tm.connect(owner).addToAccessList([other.address])).wait();
    await (await tm.connect(owner).disableAccessList()).wait();
    const logs = await logsOf(() => hre.run("task:revokeAccess", { accounts: other.address, yes: true }));
    expect(logs).to.match(/revoking blocks nothing now.*task:addToDenyList/);
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
    await hre.run("task:grantRegistryRole", { yes: true }); // the signer still holds the TaskManager admin role

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
