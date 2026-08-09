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

    // An unset REMOTE_RPC_URL leaves the 'remote' network with an empty url, which
    // fails deep inside the provider. Say what's actually wrong instead.
    if (hre.network.name === "remote" && !process.env.REMOTE_RPC_URL) {
      throw new Error(
        "--network remote requires REMOTE_RPC_URL (e.g. http://127.0.0.1:18547 pointing at a port-forward).",
      );
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

    const contract = new ethers.Contract(TM_PROXY_ADDRESS, artifact.abi, ethers.provider);
    const version = Number(await contract.getVersion());

    console.log(chalk.green(`Network:  ${hre.network.name} (chain ${chainId})`));
    console.log(chalk.green(`Proxy:    ${TM_PROXY_ADDRESS}`));
    console.log(chalk.green(`Version:  ${version}`));
    console.log(chalk.green(`Target:   ${uri}`));

    const existing = readRemoteJson(uri);

    // Timestamped rather than version-stamped: this task runs after
    // task:upgradeTM has already called incVersion(), so the chain reports the new
    // version while the artifact being replaced is still the old one. A timestamp
    // needs no such correspondence and cannot collide across repeat publishes.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupUri = `gs://${taskArguments.bucket}/deployments/${chainId}/TaskManager_${stamp}_bak.json`;

    // Merge rather than replace so any other top-level keys on the published
    // artifact survive a republish.
    const merged = {
      ...(existing ?? {}),
      address: TM_PROXY_ADDRESS,
      version,
      abi: artifact.abi,
    };

    const outDir = path.join(__dirname, "../artifacts/publish");
    fs.mkdirSync(outDir, { recursive: true });
    const localPath = path.join(outDir, "TaskManager.json");
    fs.writeFileSync(localPath, JSON.stringify(merged, null, 2), "utf8");

    if (taskArguments.dryRun) {
      console.log(
        existing
          ? chalk.yellow(`Would back up the current artifact to ${backupUri}`)
          : chalk.yellow("No published artifact at the target — this would be the first."),
      );
      console.log(chalk.yellow(`Dry run — nothing written. Staged locally at ${localPath}`));
      return;
    }

    try {
      if (existing) {
        gcloud(["storage", "cp", uri, backupUri]);
        console.log(chalk.green(`Backed up previous artifact to ${backupUri}`));
      }

      gcloud(["storage", "cp", localPath, uri]);
      console.log(chalk.green(`Published ${uri} at version ${version}`));
    } catch (error: any) {
      console.log(chalk.red("Upload failed — the generated artifact was kept locally."));
      console.log(chalk.red(`  ${localPath}`));
      console.log(chalk.red(`Push it manually with: gcloud storage cp ${localPath} ${uri}`));
      throw error;
    }
  });
