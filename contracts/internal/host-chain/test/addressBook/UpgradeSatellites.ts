import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";

import { installAddressBook } from "../helpers/addressBook";
import { resolveTaskManager } from "../../utils/addressBook";

const { ethers } = hre;

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

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

// deploy.ts loads ../.env with dotenv, which never overrides a variable that is already set,
// so set every one it reads rather than deleting it.
function setDeployEnv(deployer: string, safe: string, safeOwnerKey: string) {
  process.env.AGGREGATOR_KEY = ethers.Wallet.createRandom().privateKey;
  process.env.VERIFIER_ADDRESS = ethers.ZeroAddress;
  process.env.DECRYPT_RESULT_SIGNER = ethers.ZeroAddress;
  process.env.TM_ADMIN_ADDRESS = deployer;
  process.env.TM_ADMIN_DELAY = "";
  process.env.SAFE_ADMIN_ADDRESS = safe;
  process.env.SAFE_OWNER_KEY = safeOwnerKey;
  process.env.SAFE_BATCH_OUT = "";
  process.env.MAINTENANCE_ADDRESS = "";
  process.env.REGISTER_TASK_MANAGER = "";
  process.env.FULL_REDEPLOY = "";
}

async function implementationOf(proxy: string): Promise<string> {
  return ethers.getAddress("0x" + (await ethers.provider.getStorage(proxy, IMPLEMENTATION_SLOT)).slice(-40));
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

describe("task:upgradeACL / task:upgradePlaintextsStorage after the handover", function () {
  const saved: Record<string, string | undefined> = {};
  let taskManagerAddress: string;
  let acl: any;
  let plaintextsStorage: any;
  let finalAdmin: any;

  before(async function () {
    this.timeout(300_000);
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    await ethers.provider.send("hardhat_reset", []);
    const [deployer] = await ethers.getSigners();
    // An EOA stands in for the Safe: SAFE_OWNER_KEY is then its own key and the task sends directly.
    finalAdmin = ethers.Wallet.createRandom().connect(ethers.provider);
    setDeployEnv(deployer.address, finalAdmin.address, finalAdmin.privateKey);

    await installAddressBook(deployer);
    await hre.run("deploy", { reset: true });
    await (await deployer.sendTransaction({ to: finalAdmin.address, value: ethers.parseEther("1") })).wait();
    await hre.run("task:acceptAdminAsSafe");
    await hre.run("task:renounceDeployerRoles");
    taskManagerAddress = await resolveTaskManager(hre);
    const taskManager = await ethers.getContractAt("TaskManager", taskManagerAddress);
    acl = await ethers.getContractAt("ACL", await taskManager.acl());
    plaintextsStorage = await ethers.getContractAt("PlaintextsStorage", await taskManager.plaintextsStorage());
  });

  after(function () {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it("upgrades the ACL as the Safe, keeping the TaskManager", async function () {
    this.timeout(300_000);
    const aclAddress = await acl.getAddress();
    const before = await implementationOf(aclAddress);
    await hre.run("task:upgradeACL");
    expect(await implementationOf(aclAddress)).to.not.equal(before);
    expect(await acl.getTaskManagerAddress()).to.equal(taskManagerAddress);
  });

  it("writes one Safe batch for PlaintextsStorage when SAFE_OWNER_KEY is unset, changing nothing on chain", async function () {
    this.timeout(300_000);
    const ptStorageAddress = await plaintextsStorage.getAddress();
    const before = await implementationOf(ptStorageAddress);
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-satellite-")), "batch.json");
    process.env.SAFE_OWNER_KEY = "";
    process.env.SAFE_BATCH_OUT = outPath;
    try {
      await hre.run("task:upgradePlaintextsStorage");
    } finally {
      process.env.SAFE_OWNER_KEY = finalAdmin.privateKey;
      process.env.SAFE_BATCH_OUT = "";
    }

    const batch = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(batch.transactions).to.have.length(1);
    expect(batch.transactions[0].to).to.equal(ptStorageAddress);
    const [newImplementation, call] = plaintextsStorage.interface.decodeFunctionData(
      "upgradeToAndCall",
      batch.transactions[0].data,
    );
    expect(await ethers.provider.getCode(newImplementation)).to.not.equal("0x");
    expect(call).to.equal(plaintextsStorage.interface.encodeFunctionData("setTaskManager", [taskManagerAddress]));
    expect(await implementationOf(ptStorageAddress)).to.equal(before);
  });

  it("refuses when SAFE_ADMIN_ADDRESS is not the default admin", async function () {
    this.timeout(300_000);
    process.env.SAFE_ADMIN_ADDRESS = ethers.Wallet.createRandom().address;
    try {
      await expectRejection(hre.run("task:upgradeACL"), /Refusing to upgrade ACL: default admin is/);
    } finally {
      process.env.SAFE_ADMIN_ADDRESS = finalAdmin.address;
    }
  });
});
