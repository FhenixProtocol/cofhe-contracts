import chalk from "chalk";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

// Deterministic address of the TaskManager proxy (deployed via CREATE2).
// Kept in sync with src/services/contracts-deployer/deploy_contracts.sh in the cofhe superproject.
const TM_PROXY_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

// Only resolvable when this repo is checked out as a submodule of the cofhe superproject.
const ENVIRONMENTS_DIR = path.join(
  __dirname,
  "../../../../../deployments/generator/environments",
);

type AbiEntry = {
  type?: string;
  name?: string;
  inputs?: { type?: string }[];
};

function abiSignature(entry: AbiEntry): string {
  const inputs = (entry.inputs ?? []).map((i) => i.type ?? "?").join(",");
  return `${entry.type ?? "?"} ${entry.name ?? ""}(${inputs})`;
}

function listNetworks(hre: HardhatRuntimeEnvironment): string[] {
  return Object.keys(hre.config.networks).filter((n) => n !== "hardhat");
}

// Returns null when the superproject isn't available, so the caller can degrade
// to a hint instead of pretending it knows the bucket list.
function listBuckets(): { env: string; bucket: string }[] | null {
  if (!fs.existsSync(ENVIRONMENTS_DIR)) {
    return null;
  }

  return fs
    .readdirSync(ENVIRONMENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(ENVIRONMENTS_DIR, f), "utf8"),
      );
      return {
        env: path.basename(f, ".json"),
        bucket: parsed.gcsBucketName ?? "(none)",
      };
    })
    .filter((row) => row.bucket !== "(none)");
}

function printBuckets() {
  const buckets = listBuckets();

  if (buckets === null) {
    console.log(
      chalk.yellow(
        "  (bucket list unavailable — run from within the cofhe superproject to enumerate them)",
      ),
    );
    return;
  }

  // The env file basename is authoritative here: the "name" field inside these
  // files is inconsistent (devnet.json and staging.json both say "staging").
  for (const { env, bucket } of buckets) {
    console.log(`  ${env.padEnd(16)} ${bucket}`);
  }
}

function gcloud(args: string[]): string {
  return execFileSync("gcloud", args, { encoding: "utf8" });
}

function readRemoteJson(uri: string): Record<string, unknown> | null {
  try {
    return JSON.parse(gcloud(["storage", "cat", uri]));
  } catch {
    // Absent object, or unreadable — either way there is nothing to merge onto.
    return null;
  }
}

function reportAbiDelta(previous: AbiEntry[] | undefined, next: AbiEntry[]) {
  if (!previous) {
    console.log(chalk.yellow("No published artifact to compare against — this will be the first."));
    return;
  }

  const before = new Set(previous.map(abiSignature));
  const after = new Set(next.map(abiSignature));

  const added = [...after].filter((s) => !before.has(s));
  const removed = [...before].filter((s) => !after.has(s));

  if (added.length === 0 && removed.length === 0) {
    console.log(chalk.green("ABI is unchanged from what is already published."));
    return;
  }

  for (const s of added) {
    console.log(chalk.green(`  + ${s}`));
  }
  for (const s of removed) {
    console.log(chalk.red(`  - ${s}`));
  }
}

task("task:publishTMAbi")
  .addOptionalParam("bucket", "GCS bucket to publish the artifact to", "")
  .addFlag("dryRun", "Report what would be published without writing anything")
  .setAction(async function (taskArguments, hre) {
    const { ethers } = hre;

    // hardhat.config sets defaultNetwork, so an omitted --network silently resolves
    // to a real network rather than failing. Demand it explicitly instead.
    const networkWasExplicit =
      process.argv.includes("--network") || !!process.env.HARDHAT_NETWORK;

    if (!networkWasExplicit || hre.network.name === "hardhat") {
      console.log(
        chalk.red(
          "--network is required (publishing must never depend on the configured default).",
        ),
      );
      console.log("Available networks:");
      for (const n of listNetworks(hre)) {
        console.log(`  ${n}`);
      }
      throw new Error("--network is required");
    }

    if (!taskArguments.bucket) {
      console.log(chalk.red("--bucket is required."));
      console.log("Known environment buckets:");
      printBuckets();
      throw new Error("--bucket is required");
    }

    await hre.run("compile");

    const artifact = await hre.artifacts.readArtifact("TaskManager");

    // Publishing an artifact that points at an address with no code would hand
    // every consumer a contract that silently answers nothing. Refuse instead.
    const code = await ethers.provider.getCode(TM_PROXY_ADDRESS);
    if (code === "0x") {
      throw new Error(
        `No bytecode at ${TM_PROXY_ADDRESS} on network '${hre.network.name}' — wrong RPC, or the TaskManager was never deployed here.`,
      );
    }

    // Taken from the provider rather than a flag so the object path cannot drift
    // from the network actually connected to.
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const uri = `gs://${taskArguments.bucket}/deployments/${chainId}/TaskManager.json`;

    console.log(chalk.green(`Network:  ${hre.network.name} (chain ${chainId})`));
    console.log(chalk.green(`Proxy:    ${TM_PROXY_ADDRESS}`));
    console.log(chalk.green(`Target:   ${uri}`));

    const existing = readRemoteJson(uri);
    reportAbiDelta(existing?.abi as AbiEntry[] | undefined, artifact.abi as AbiEntry[]);

    // Merge rather than replace so any other top-level keys on the published
    // artifact survive a republish.
    const merged = {
      ...(existing ?? {}),
      address: TM_PROXY_ADDRESS,
      abi: artifact.abi,
    };

    const outDir = path.join(__dirname, "../artifacts/publish");
    fs.mkdirSync(outDir, { recursive: true });
    const localPath = path.join(outDir, "TaskManager.json");
    fs.writeFileSync(localPath, JSON.stringify(merged, null, 2), "utf8");

    if (taskArguments.dryRun) {
      console.log(chalk.yellow(`Dry run — nothing written. Staged locally at ${localPath}`));
      return;
    }

    try {
      if (existing) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupUri = `gs://${taskArguments.bucket}/deployments/${chainId}/TaskManager.json.bak-${stamp}`;
        gcloud(["storage", "cp", uri, backupUri]);
        console.log(chalk.green(`Backed up previous artifact to ${backupUri}`));
      }

      gcloud(["storage", "cp", localPath, uri]);
      console.log(chalk.green(`Published ${uri}`));
    } catch (error: any) {
      console.log(chalk.red("Upload failed — the generated artifact was kept locally."));
      console.log(chalk.red(`  ${localPath}`));
      console.log(chalk.red(`Push it manually with: gcloud storage cp ${localPath} ${uri}`));
      throw error;
    }
  });
