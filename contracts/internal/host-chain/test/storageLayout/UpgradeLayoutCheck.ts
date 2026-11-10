import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";

import { requireLayoutMatchesSnapshot } from "../../tasks/storageLayout";

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
