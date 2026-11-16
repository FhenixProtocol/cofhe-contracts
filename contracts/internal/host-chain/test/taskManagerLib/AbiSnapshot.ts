import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import hre from "hardhat";

// TaskManager's ABI is its public interface: SDKs, FHE.sol and indexers decode against it. Moving
// code into TaskManagerLib once dropped errors from it silently, so the ABI is pinned here.
// After an intended ABI change, regenerate the snapshot in the same PR:
//   UPDATE_ABI_SNAPSHOT=1 pnpm hardhat test test/taskManagerLib/AbiSnapshot.ts --network hardhat
const SNAPSHOT_FILE = path.join(hre.config.paths.root, "taskmanager-abi-snapshot.json");

type AbiEntry = { type: string; name?: string; inputs?: any[] };

function signature(entry: AbiEntry): string {
  const params = (entry.inputs ?? []).map((input: any) => input.type).join(",");
  return `${entry.type} ${entry.name ?? ""}(${params})`;
}

// Sorted, so the snapshot diff in a PR shows only what changed.
function canonical(abi: AbiEntry[]): AbiEntry[] {
  return [...abi].sort((a, b) => signature(a).localeCompare(signature(b)));
}

describe("TaskManager ABI", function () {
  it("matches the committed snapshot", async function () {
    const abi = canonical((await hre.artifacts.readArtifact("TaskManager")).abi);
    if (process.env.UPDATE_ABI_SNAPSHOT === "1") {
      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(abi, null, 2) + "\n");
    }
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
    expect(abi).to.deep.equal(snapshot);
  });

  // TaskManager re-declares these because ECDSA now reverts inside TaskManagerLib; an OpenZeppelin
  // upgrade that changes them must change the re-declarations too.
  it("declares every OpenZeppelin ECDSA error with the same signature", async function () {
    const tm = new Set((await hre.artifacts.readArtifact("TaskManager")).abi.map(signature));
    const ecdsaErrors = (await hre.artifacts.readArtifact("ECDSA")).abi.filter((e: AbiEntry) => e.type === "error");
    expect(ecdsaErrors).to.not.be.empty;
    for (const error of ecdsaErrors) {
      expect(tm.has(signature(error)), signature(error)).to.equal(true);
    }
  });
});
