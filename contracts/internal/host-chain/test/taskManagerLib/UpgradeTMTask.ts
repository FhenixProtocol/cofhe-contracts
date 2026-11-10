import { expect } from "chai";
import hre from "hardhat";

import { installAddressBook } from "../helpers/addressBook";
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

// task:upgradeTM deploys TaskManagerLib together with the implementation, after its role checks:
// an upgrade it refuses must not have sent a transaction.
describe("task:upgradeTM refusals send nothing", function () {
  const saved: Record<string, string | undefined> = {};
  let taskManager: any;
  let deployer: any;
  let upgrader: any;

  before(async function () {
    this.timeout(300_000);
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    await ethers.provider.send("hardhat_reset", []);
    const signers = await ethers.getSigners();
    deployer = signers[0];
    // The task's default signer; the deploy gives it no role.
    upgrader = signers[2];

    // deploy.ts loads ../.env with dotenv, which never overrides a set variable, so set every one.
    process.env.AGGREGATOR_KEY = ethers.Wallet.createRandom().privateKey;
    process.env.VERIFIER_ADDRESS = ethers.ZeroAddress;
    process.env.DECRYPT_RESULT_SIGNER = ethers.ZeroAddress;
    process.env.TM_ADMIN_ADDRESS = deployer.address;
    process.env.TM_ADMIN_DELAY = "";
    process.env.SAFE_ADMIN_ADDRESS = "";
    process.env.SAFE_OWNER_KEY = "";
    process.env.SAFE_BATCH_OUT = "";
    process.env.MAINTENANCE_ADDRESS = "";
    process.env.REGISTER_TASK_MANAGER = "";
    process.env.FULL_REDEPLOY = "";

    await installAddressBook(deployer);
    await hre.run("deploy", { reset: true });
    taskManager = await ethers.getContractAt("TaskManager", await resolveTaskManager(hre));
  });

  // The deploy already placed the library; remove it so a run that deploys it too early sends a transaction.
  beforeEach(async function () {
    const lib = await hre.artifacts.readArtifact("TaskManagerLib");
    const libAddress = ethers.getCreate2Address(CREATEX_ADDRESS, guardedSalt(), ethers.keccak256(lib.bytecode));
    await ethers.provider.send("hardhat_setCode", [libAddress, "0x"]);
  });

  after(function () {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("without UPGRADER_ROLE and without a Safe", async function () {
    this.timeout(300_000);
    const nonceBefore = await ethers.provider.getTransactionCount(upgrader.address);
    await expectRejection(hre.run("task:upgradeTM"), /does not hold UPGRADER_ROLE/);
    expect(await ethers.provider.getTransactionCount(upgrader.address)).to.equal(nonceBefore);
  });

  it("with UPGRADER_ROLE but not the default admin", async function () {
    this.timeout(300_000);
    await (await taskManager.connect(deployer).grantRole(await taskManager.UPGRADER_ROLE(), upgrader.address)).wait();
    const nonceBefore = await ethers.provider.getTransactionCount(upgrader.address);
    await expectRejection(hre.run("task:upgradeTM"), /Refusing to upgrade: default admin is/);
    expect(await ethers.provider.getTransactionCount(upgrader.address)).to.equal(nonceBefore);
  });
});
