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

async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let message = "";
  try {
    await promise;
  } catch (error: any) {
    message = String(error?.message ?? error);
  }
  expect(message).to.match(pattern);
}

describe("task:addToDenyList / task:removeFromDenyList (and *AsSafe)", function () {
  const saved: Record<string, string | undefined> = {};
  let taskManager: any;
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
    taskManager = await ethers.getContractAt("TaskManager", await resolveTaskManager(hre));
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

  it("adds and removes accounts as a signer holding ACCESS_LIST_MANAGER_ROLE", async function () {
    const a = ethers.Wallet.createRandom().address;
    const b = ethers.Wallet.createRandom().address;
    await hre.run("task:addToDenyList", { accounts: `${a},${b}` });
    expect(await taskManager.denyList(a)).to.equal(true);
    expect(await taskManager.denyList(b)).to.equal(true);

    await hre.run("task:removeFromDenyList", { accounts: a });
    expect(await taskManager.denyList(a)).to.equal(false);
    expect(await taskManager.denyList(b)).to.equal(true);
  });

  it("is a no-op when every account is already in the requested state", async function () {
    const a = ethers.Wallet.createRandom().address;
    await hre.run("task:removeFromDenyList", { accounts: a });
    expect(await taskManager.denyList(a)).to.equal(false);
  });

  it("refuses address(0) and malformed addresses", async function () {
    await expectRejection(hre.run("task:addToDenyList", { accounts: ethers.ZeroAddress }), /address\(0\)/);
    await expectRejection(hre.run("task:addToDenyList", { accounts: "0x1234" }), /invalid address/);
  });

  it("goes through the Safe with *AsSafe even when the signer holds the role", async function () {
    const a = ethers.Wallet.createRandom().address;
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deny-list-")), "batch.json");
    process.env.SAFE_OWNER_KEY = "";
    try {
      await hre.run("task:addToDenyListAsSafe", { accounts: a, out: outPath });
    } finally {
      process.env.SAFE_OWNER_KEY = finalAdmin.privateKey;
    }
    expect(JSON.parse(fs.readFileSync(outPath, "utf8")).transactions).to.have.length(1);
    expect(await taskManager.denyList(a)).to.equal(false);
  });

  describe("after the handover", function () {
    before(async function () {
      this.timeout(300_000);
      const [deployer] = await ethers.getSigners();
      await (await deployer.sendTransaction({ to: finalAdmin.address, value: ethers.parseEther("1") })).wait();
      await hre.run("task:acceptAdminAsSafe");
      await hre.run("task:renounceDeployerRoles");
    });

    it("refuses the signer-only tasks and points at *AsSafe", async function () {
      const a = ethers.Wallet.createRandom().address;
      await expectRejection(hre.run("task:addToDenyList", { accounts: a }), /task:addToDenyListAsSafe/);
    });

    it("adds and removes as the final admin", async function () {
      const a = ethers.Wallet.createRandom().address;
      await hre.run("task:addToDenyListAsSafe", { accounts: a });
      expect(await taskManager.denyList(a)).to.equal(true);
      await hre.run("task:removeFromDenyListAsSafe", { accounts: a });
      expect(await taskManager.denyList(a)).to.equal(false);
    });

    it("writes a Safe batch when SAFE_OWNER_KEY is unset, changing nothing on chain", async function () {
      const a = ethers.Wallet.createRandom().address;
      const b = ethers.Wallet.createRandom().address;
      const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deny-list-")), "batch.json");
      process.env.SAFE_OWNER_KEY = "";
      try {
        await hre.run("task:addToDenyListAsSafe", { accounts: `${a},${b}`, out: outPath });
      } finally {
        process.env.SAFE_OWNER_KEY = finalAdmin.privateKey;
      }

      const batch = JSON.parse(fs.readFileSync(outPath, "utf8"));
      expect(batch.transactions).to.have.length(1);
      expect(batch.transactions[0].to).to.equal(await taskManager.getAddress());
      expect(batch.transactions[0].data).to.equal(taskManager.interface.encodeFunctionData("setDenyList", [[a, b], true]));
      expect(await taskManager.denyList(a)).to.equal(false);
      expect(await taskManager.denyList(b)).to.equal(false);
    });

    it("refuses when SAFE_ADMIN_ADDRESS does not hold the role", async function () {
      const a = ethers.Wallet.createRandom().address;
      process.env.SAFE_ADMIN_ADDRESS = ethers.Wallet.createRandom().address;
      try {
        await expectRejection(hre.run("task:addToDenyListAsSafe", { accounts: a }), /ACCESS_LIST_MANAGER_ROLE/);
      } finally {
        process.env.SAFE_ADMIN_ADDRESS = finalAdmin.address;
      }
    });
  });
});
