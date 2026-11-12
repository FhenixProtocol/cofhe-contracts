import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";

import { installAddressBook } from "../helpers/addressBook";
import { requireLayoutMatchesSnapshot } from "../../tasks/storageLayout";
import { resolveTaskManager } from "../../utils/addressBook";

const { ethers, upgrades } = hre;

// task:upgradeTM validates an upgrade against the committed storage-layout snapshot, the layout of
// the deployed proxies. It must refuse a layout that does not match, not compare the build with itself.
describe("task:upgradeTM storage layout check", function () {
  const snapshotPath = path.join(hre.config.paths.root, "storage-layout-snapshot.json");

  function snapshotWith(change: (taskManagerStorage: any[]) => void): string {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    change(snapshot.contracts.TaskManager.storage);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "layout-")), "snapshot.json");
    fs.writeFileSync(file, JSON.stringify(snapshot));
    return file;
  }

  it("accepts the current build against the committed snapshot", async function () {
    this.timeout(300_000);
    await requireLayoutMatchesSnapshot(hre, "TaskManager");
  });

  it("refuses a build whose layout differs from the deployed one", async function () {
    this.timeout(300_000);
    const changed = snapshotWith((storage) => {
      storage[0].label = "variableTheDeployedProxyStillUses";
    });
    let message = "";
    try {
      await requireLayoutMatchesSnapshot(hre, "TaskManager", changed);
    } catch (error: any) {
      message = String(error?.message ?? error);
    }
    expect(message).to.match(/NOT upgrade-compatible/);
  });

  it("accepts the TaskManager implementation as upgrade-safe", async function () {
    this.timeout(300_000);
    await upgrades.validateImplementation(await ethers.getContractFactory("TaskManager"), { kind: "uups" });
  });
});

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

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

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

// Every upgrade path checks the build against the committed snapshot. A snapshot that differs from
// the build stands in for a build whose layout differs from the deployed proxies.
describe("every upgrade path refuses a layout that differs from the snapshot", function () {
  const snapshotPath = path.join(hre.config.paths.root, "storage-layout-snapshot.json");
  const saved: Record<string, string | undefined> = {};
  let taskManager: any;
  let upgrader: string;

  async function refusesWithChangedSnapshot(
    contractName: string,
    change: (layout: any) => void,
    proxy: string,
    run: () => Promise<unknown>,
  ) {
    const original = fs.readFileSync(snapshotPath, "utf8");
    const snapshot = JSON.parse(original);
    change(snapshot.contracts[contractName]);
    const implementationBefore = await implementationOf(proxy);
    const nonceBefore = await ethers.provider.getTransactionCount(upgrader);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
    try {
      await expectRejection(run(), new RegExp(`${contractName} storage layout is NOT upgrade-compatible`));
    } finally {
      fs.writeFileSync(snapshotPath, original);
    }
    expect(await implementationOf(proxy)).to.equal(implementationBefore);
    expect(await ethers.provider.getTransactionCount(upgrader)).to.equal(nonceBefore);
  }

  before(async function () {
    this.timeout(300_000);
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    await ethers.provider.send("hardhat_reset", []);
    const signers = await ethers.getSigners();
    // deploy.ts loads ../.env with dotenv, which never overrides a set variable, so set every one.
    process.env.AGGREGATOR_KEY = ethers.Wallet.createRandom().privateKey;
    process.env.VERIFIER_ADDRESS = ethers.ZeroAddress;
    process.env.DECRYPT_RESULT_SIGNER = ethers.ZeroAddress;
    process.env.TM_ADMIN_ADDRESS = signers[0].address;
    for (const key of ENV_KEYS.slice(4)) process.env[key] = "";
    await installAddressBook(signers[0]);
    await hre.run("deploy", { reset: true });
    taskManager = await ethers.getContractAt("TaskManager", await resolveTaskManager(hre));
    // hardhat deploy sends as signer #0; the tasks send as signer #2.
    upgrader = signers[2].address;
  });

  after(function () {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("task:upgradeTM", async function () {
    this.timeout(300_000);
    await refusesWithChangedSnapshot(
      "TaskManager",
      (layout) => (layout.storage[0].label = "variableTheDeployedProxyStillUses"),
      await taskManager.getAddress(),
      () => hre.run("task:upgradeTM"),
    );
  });

  it("hardhat deploy, upgrading the registered TaskManager in place", async function () {
    this.timeout(300_000);
    upgrader = (await ethers.getSigners())[0].address;
    try {
      await refusesWithChangedSnapshot(
        "TaskManager",
        (layout) => (layout.storage[0].label = "variableTheDeployedProxyStillUses"),
        await taskManager.getAddress(),
        () => hre.run("deploy", { reset: true }),
      );
    } finally {
      upgrader = (await ethers.getSigners())[2].address;
    }
  });

  it("task:upgradeACL", async function () {
    this.timeout(300_000);
    await refusesWithChangedSnapshot(
      "ACL",
      (layout) => (layout.namespaces["erc7201:cofhe.storage.ACL"][0].label = "variableTheDeployedProxyStillUses"),
      await taskManager.acl(),
      () => hre.run("task:upgradeACL"),
    );
  });

  it("task:upgradePlaintextsStorage", async function () {
    this.timeout(300_000);
    await refusesWithChangedSnapshot(
      "PlaintextsStorage",
      (layout) => (layout.storage[0].label = "variableTheDeployedProxyStillUses"),
      await taskManager.plaintextsStorage(),
      () => hre.run("task:upgradePlaintextsStorage"),
    );
  });

  it("task:upgradeShareRegistry", async function () {
    this.timeout(300_000);
    const acl = await ethers.getContractAt("ACL", await taskManager.acl());
    const registry: string = await acl.shareRegistry();
    // The task skips a proxy that already runs this exact build; one extra byte makes it a different build.
    const implementation = await implementationOf(registry);
    await ethers.provider.send("hardhat_setCode", [implementation, (await ethers.provider.getCode(implementation)) + "00"]);
    await refusesWithChangedSnapshot(
      "ACPShareRegistry",
      (layout) => (Object.values(layout.namespaces as Record<string, any[]>).find((items) => items.length)![0].label =
        "variableTheDeployedProxyStillUses"),
      registry,
      () => hre.run("task:upgradeShareRegistry", { yes: true }),
    );
  });
});
