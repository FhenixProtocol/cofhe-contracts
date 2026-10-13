import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";

import { installAddressBook } from "../helpers/addressBook";
import { resolveTaskManager } from "../../utils/addressBook";

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
  "MAINTENANCE_KEY",
  "REGISTER_TASK_MANAGER",
  "FULL_REDEPLOY",
] as const;

// deploy.ts loads ../.env with dotenv, which never overrides a variable that is already set,
// so set every one it reads rather than deleting it.
function setDeployEnv(deployer: string, safe: string, safeOwnerKey: string, maintenance: string) {
  process.env.AGGREGATOR_KEY = ethers.Wallet.createRandom().privateKey;
  process.env.VERIFIER_ADDRESS = ethers.ZeroAddress;
  process.env.DECRYPT_RESULT_SIGNER = ethers.ZeroAddress;
  process.env.TM_ADMIN_ADDRESS = deployer;
  process.env.TM_ADMIN_DELAY = "";
  process.env.SAFE_ADMIN_ADDRESS = safe;
  process.env.SAFE_OWNER_KEY = safeOwnerKey;
  process.env.SAFE_BATCH_OUT = "";
  process.env.MAINTENANCE_ADDRESS = maintenance;
  process.env.MAINTENANCE_KEY = "";
  process.env.REGISTER_TASK_MANAGER = "";
  process.env.FULL_REDEPLOY = "";
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

describe("task:goLiveAsSafe / task:disableTaskManager", function () {
  const saved: Record<string, string | undefined> = {};
  let taskManager: any;
  let finalAdmin: any;
  let maintenance: any;
  let caller: string;

  before(async function () {
    this.timeout(300_000);
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    await ethers.provider.send("hardhat_reset", []);
    const [deployer] = await ethers.getSigners();
    // An EOA stands in for the Safe: SAFE_OWNER_KEY is then its own key and the task sends directly.
    finalAdmin = ethers.Wallet.createRandom().connect(ethers.provider);
    maintenance = ethers.Wallet.createRandom().connect(ethers.provider);
    setDeployEnv(deployer.address, finalAdmin.address, finalAdmin.privateKey, maintenance.address);

    await installAddressBook(deployer);
    await hre.run("deploy", { reset: true });
    for (const wallet of [finalAdmin, maintenance]) {
      await (await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") })).wait();
    }
    await hre.run("task:acceptAdminAsSafe");
    await hre.run("task:renounceDeployerRoles");
    taskManager = await ethers.getContractAt("TaskManager", await resolveTaskManager(hre));
    caller = await taskManager.acl();

    // Put the TaskManager in its mainnet post-deploy state: production signers, access list on, disabled.
    await hre.run("task:setSignersAsSafe", {
      verifier: ethers.Wallet.createRandom().address,
      decrypt: ethers.Wallet.createRandom().address,
    });
    const asAdmin = taskManager.connect(finalAdmin);
    await (await asAdmin.enableAccessList()).wait();
    await (await asAdmin.disable()).wait();
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

  it("refuses to go live while the access list is off", async function () {
    await (await taskManager.connect(finalAdmin).disableAccessList()).wait();
    try {
      await expectRejection(hre.run("task:goLiveAsSafe", { accounts: caller, yes: true }), /every caller/);
    } finally {
      await (await taskManager.connect(finalAdmin).enableAccessList()).wait();
    }
    expect(await taskManager.isEnabled()).to.equal(false);
  });

  it("writes one batch with addToAccessList then enable() when SAFE_OWNER_KEY is unset, changing nothing on chain", async function () {
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "go-live-")), "batch.json");
    process.env.SAFE_OWNER_KEY = "";
    try {
      await hre.run("task:goLiveAsSafe", { accounts: caller, out: outPath });
    } finally {
      process.env.SAFE_OWNER_KEY = finalAdmin.privateKey;
    }

    const batch = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const tmAddress = await taskManager.getAddress();
    expect(batch.transactions).to.have.length(2);
    expect(batch.transactions[0].to).to.equal(tmAddress);
    expect(batch.transactions[0].data).to.equal(taskManager.interface.encodeFunctionData("addToAccessList", [[caller]]));
    expect(batch.transactions[1].to).to.equal(tmAddress);
    expect(batch.transactions[1].data).to.equal(taskManager.interface.encodeFunctionData("enable"));
    expect(await taskManager.isEnabled()).to.equal(false);
    expect(await taskManager.accessList(caller)).to.equal(false);
  });

  it("access-lists the callers and enables as the final admin", async function () {
    await hre.run("task:goLiveAsSafe", { accounts: caller, yes: true });
    expect(await taskManager.accessList(caller)).to.equal(true);
    expect(await taskManager.isEnabled()).to.equal(true);
  });

  it("is a no-op once live", async function () {
    const before = await ethers.provider.getTransactionCount(finalAdmin.address);
    await hre.run("task:goLiveAsSafe", { accounts: caller, yes: true });
    expect(await ethers.provider.getTransactionCount(finalAdmin.address)).to.equal(before);
  });

  it("prints the disable() call without MAINTENANCE_KEY, changing nothing on chain", async function () {
    await hre.run("task:disableTaskManager", { yes: true });
    expect(await taskManager.isEnabled()).to.equal(true);
  });

  it("refuses a MAINTENANCE_KEY without PAUSER_ROLE", async function () {
    process.env.MAINTENANCE_KEY = ethers.Wallet.createRandom().privateKey;
    try {
      await expectRejection(hre.run("task:disableTaskManager", { yes: true }), /does not hold PAUSER_ROLE/);
    } finally {
      process.env.MAINTENANCE_KEY = "";
    }
    expect(await taskManager.isEnabled()).to.equal(true);
  });

  it("disables as the maintenance wallet, then is a no-op", async function () {
    process.env.MAINTENANCE_KEY = maintenance.privateKey;
    try {
      await hre.run("task:disableTaskManager", { yes: true });
      expect(await taskManager.isEnabled()).to.equal(false);
      const before = await ethers.provider.getTransactionCount(maintenance.address);
      await hre.run("task:disableTaskManager", { yes: true });
      expect(await ethers.provider.getTransactionCount(maintenance.address)).to.equal(before);
    } finally {
      process.env.MAINTENANCE_KEY = "";
    }
  });

  it("re-enables through the Safe after an emergency stop", async function () {
    await hre.run("task:goLiveAsSafe", { yes: true });
    expect(await taskManager.isEnabled()).to.equal(true);
  });
});
