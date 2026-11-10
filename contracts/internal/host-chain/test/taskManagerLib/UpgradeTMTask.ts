import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";

import { installAddressBook, registerTaskManager } from "../helpers/addressBook";
import { deployLinkedTaskManagerFactory } from "../taskManagerFactory";
import { resolveTaskManager } from "../../utils/addressBook";
import { guardedSalt } from "../../utils/addressBookDeterministic";
import { CREATEX_ADDRESS } from "../../utils/deployCreateX";

const { ethers } = hre;

const ENV_KEYS = [
  "AGGREGATOR_KEY",
  "VERIFIER_ADDRESS",
  "DECRYPT_RESULT_SIGNER",
  "TM_ADMIN_ADDRESS",
  "TM_ADMIN_DELAY",
  "SAFE_ADMIN_ADDRESS",
  "SAFE_OWNER_KEY",
  "SAFE_BATCH_OUT",
  "MAINTENANCE_ADDRESS",
  "REGISTER_TASK_MANAGER",
  "FULL_REDEPLOY",
] as const;

async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let message = "";
  try {
    await promise;
  } catch (error: any) {
    message = String(error?.message ?? error);
  }
  expect(message).to.match(pattern);
}

async function libraryAddress(): Promise<string> {
  const lib = await hre.artifacts.readArtifact("TaskManagerLib");
  return ethers.getCreate2Address(CREATEX_ADDRESS, guardedSalt(), ethers.keccak256(lib.bytecode));
}

// Deploys the stack with `deployer` as admin; task:upgradeTM then runs as signer #2, which holds no role.
function useDeployedStack() {
  const saved: Record<string, string | undefined> = {};
  const ctx: { taskManager: any; deployer: any; upgrader: any } = { taskManager: null, deployer: null, upgrader: null };

  before(async function () {
    this.timeout(300_000);
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    await ethers.provider.send("hardhat_reset", []);
    const signers = await ethers.getSigners();
    ctx.deployer = signers[0];
    ctx.upgrader = signers[2];

    // deploy.ts loads ../.env with dotenv, which never overrides a set variable, so set every one.
    process.env.AGGREGATOR_KEY = ethers.Wallet.createRandom().privateKey;
    process.env.VERIFIER_ADDRESS = ethers.ZeroAddress;
    process.env.DECRYPT_RESULT_SIGNER = ethers.ZeroAddress;
    process.env.TM_ADMIN_ADDRESS = ctx.deployer.address;
    process.env.TM_ADMIN_DELAY = "";
    process.env.SAFE_ADMIN_ADDRESS = "";
    process.env.SAFE_OWNER_KEY = "";
    process.env.SAFE_BATCH_OUT = "";
    process.env.MAINTENANCE_ADDRESS = "";
    process.env.REGISTER_TASK_MANAGER = "";
    process.env.FULL_REDEPLOY = "";

    await installAddressBook(ctx.deployer);
    await hre.run("deploy", { reset: true });
    ctx.taskManager = await ethers.getContractAt("TaskManager", await resolveTaskManager(hre));
  });

  after(function () {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  return ctx;
}

// task:upgradeTM deploys TaskManagerLib together with the implementation, after its role checks:
// an upgrade it refuses must not have sent a transaction.
describe("task:upgradeTM refusals send nothing", function () {
  const ctx = useDeployedStack();

  // The deploy already placed the library; remove it so a run that deploys it too early sends a transaction.
  beforeEach(async function () {
    await ethers.provider.send("hardhat_setCode", [await libraryAddress(), "0x"]);
  });

  it("without UPGRADER_ROLE and without a Safe", async function () {
    this.timeout(300_000);
    const nonceBefore = await ethers.provider.getTransactionCount(ctx.upgrader.address);
    await expectRejection(hre.run("task:upgradeTM"), /does not hold UPGRADER_ROLE/);
    expect(await ethers.provider.getTransactionCount(ctx.upgrader.address)).to.equal(nonceBefore);
  });

  it("with UPGRADER_ROLE but not the default admin", async function () {
    this.timeout(300_000);
    const { taskManager, deployer, upgrader } = ctx;
    await (await taskManager.connect(deployer).grantRole(await taskManager.UPGRADER_ROLE(), upgrader.address)).wait();
    const nonceBefore = await ethers.provider.getTransactionCount(upgrader.address);
    await expectRejection(hre.run("task:upgradeTM"), /Refusing to upgrade: default admin is/);
    expect(await ethers.provider.getTransactionCount(upgrader.address)).to.equal(nonceBefore);
  });
});

// The mainnet path: the Safe holds UPGRADER_ROLE, so the task deploys the library and the linked
// implementation, then writes the Safe batch that upgrades the proxy. The proxy here starts on an
// implementation linked to a library at an ordinary address, so the CREATE2 address has never held
// code, as on a chain that has not seen this library version: only the task can put it there.
describe("task:upgradeTM through the Safe", function () {
  const saved: Record<string, string | undefined> = {};
  let taskManager: any;
  let deployer: any;

  before(async function () {
    this.timeout(300_000);
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    await ethers.provider.send("hardhat_reset", []);
    [deployer] = await ethers.getSigners();
    const addressBook = await installAddressBook(deployer);
    const TaskManager = await deployLinkedTaskManagerFactory();
    const implementation = await TaskManager.deploy();
    const proxy = await ethers.deployContract("ERC1967Proxy", [
      await implementation.getAddress(),
      TaskManager.interface.encodeFunctionData("initialize", [deployer.address, 0]),
    ]);
    await registerTaskManager(addressBook, await proxy.getAddress());
    taskManager = TaskManager.attach(await proxy.getAddress());
  });

  after(function () {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("deploys the library and the linked implementation, and writes the upgrade batch", async function () {
    this.timeout(300_000);
    const safe = ethers.Wallet.createRandom().address;
    await (await taskManager.connect(deployer).grantRole(await taskManager.UPGRADER_ROLE(), safe)).wait();
    const batchFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-tm-")), "batch.json");
    process.env.SAFE_ADMIN_ADDRESS = safe;
    process.env.SAFE_OWNER_KEY = "";
    process.env.SAFE_BATCH_OUT = batchFile;
    expect(await ethers.provider.getCode(await libraryAddress())).to.equal("0x");

    await hre.run("task:upgradeTM");

    const batch = JSON.parse(fs.readFileSync(batchFile, "utf8"));
    expect(batch.meta.createdFromSafeAddress).to.equal(safe);
    const proxy = await taskManager.getAddress();
    expect(batch.transactions.map((t: any) => t.to)).to.deep.equal([proxy, proxy]);
    const [newImplementation, data] = taskManager.interface.decodeFunctionData("upgradeToAndCall", batch.transactions[0].data);
    expect(data).to.equal("0x");
    expect(taskManager.interface.decodeFunctionData("incVersion", batch.transactions[1].data)).to.have.length(0);

    const lib = await libraryAddress();
    expect(await ethers.provider.getCode(lib)).to.not.equal("0x");
    const implementationCode = (await ethers.provider.getCode(newImplementation)).toLowerCase();
    expect(implementationCode).to.not.equal("0x");
    expect(implementationCode).to.include(lib.slice(2).toLowerCase());
  });
});
