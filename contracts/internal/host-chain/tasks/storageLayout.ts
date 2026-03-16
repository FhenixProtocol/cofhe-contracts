import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import {
  validate,
  solcInputOutputDecoder,
  concatRunData,
  getContractVersion,
  getStorageLayout,
  getStorageUpgradeReport,
  withValidationDefaults,
  type ValidationDataCurrent,
  type StorageLayout,
} from "@openzeppelin/upgrades-core";

const TRACKED_CONTRACTS = ["TaskManager", "ACL", "PlaintextsStorage"];

const SNAPSHOT_FILE = "storage-layout-snapshot.json";

interface Snapshot {
  version: number;
  contracts: Record<string, StorageLayout>;
}

async function extractLayouts(
  hre: HardhatRuntimeEnvironment
): Promise<Record<string, StorageLayout>> {
  const buildInfoDir = path.join(hre.config.paths.artifacts, "build-info");
  if (!fs.existsSync(buildInfoDir)) {
    throw new Error(
      "No build-info directory found. Run `pnpm compile` first."
    );
  }

  const buildInfoFiles = fs
    .readdirSync(buildInfoDir)
    .filter((f) => f.endsWith(".json"));

  if (buildInfoFiles.length === 0) {
    throw new Error("No build-info files found. Run `pnpm compile` first.");
  }

  let validationData: ValidationDataCurrent | undefined;

  for (const file of buildInfoFiles) {
    const buildInfo = JSON.parse(
      fs.readFileSync(path.join(buildInfoDir, file), "utf8")
    );
    const decodeSrc = solcInputOutputDecoder(buildInfo.input, buildInfo.output);
    const runData = validate(
      buildInfo.output,
      decodeSrc,
      buildInfo.solcVersion,
      buildInfo.input
    );
    validationData = concatRunData(runData, validationData);
  }

  if (!validationData) {
    throw new Error("No validation data could be extracted.");
  }

  const layouts: Record<string, StorageLayout> = {};

  for (const contractName of TRACKED_CONTRACTS) {
    let found = false;
    for (const runData of validationData.log) {
      const fqn = Object.keys(runData).find((key) =>
        key.endsWith(`:${contractName}`)
      );
      if (fqn) {
        const version = getContractVersion(runData, fqn);
        layouts[contractName] = getStorageLayout(validationData, version);
        found = true;
        break;
      }
    }

    if (!found) {
      throw new Error(
        `Contract ${contractName} not found in compiled artifacts.`
      );
    }
  }

  return layouts;
}

task("task:storage-layout", "Extract and validate storage layout snapshot")
  .addFlag("check", "Check current layout is upgrade-compatible with snapshot")
  .setAction(async function (taskArguments, hre) {
    await hre.run("compile");

    const layouts = await extractLayouts(hre);
    const snapshotPath = path.join(hre.config.paths.root, SNAPSHOT_FILE);

    if (taskArguments.check) {
      if (!fs.existsSync(snapshotPath)) {
        console.log(
          chalk.red(
            `No snapshot file found at ${SNAPSHOT_FILE}. Run 'pnpm storage-layout:generate' first.`
          )
        );
        process.exit(1);
      }

      const committed: Snapshot = JSON.parse(
        fs.readFileSync(snapshotPath, "utf8")
      );

      const opts = withValidationDefaults({});
      let failed = false;

      for (const name of TRACKED_CONTRACTS) {
        const original = committed.contracts[name];
        const updated = layouts[name];

        if (!original) {
          console.log(
            chalk.yellow(
              `WARN: ${name} not found in snapshot — skipping compatibility check.`
            )
          );
          continue;
        }

        const report = getStorageUpgradeReport(original, updated, opts);

        if (report.ok) {
          console.log(
            chalk.green(`OK: ${name} — storage layout is upgrade-compatible.`)
          );
        } else {
          console.log(
            chalk.red(`FAIL: ${name} — storage layout is NOT upgrade-compatible:`)
          );
          console.log(report.explain(true));
          failed = true;
        }
      }

      if (failed) {
        console.log(
          chalk.red(
            "\nStorage layout incompatibility detected. This would break UUPS upgrades."
          )
        );
        process.exit(1);
      }
    } else {
      const snapshot: Snapshot = { version: 1, contracts: layouts };
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n");
      console.log(
        chalk.green(`Storage layout snapshot written to ${SNAPSHOT_FILE}`)
      );

      for (const name of TRACKED_CONTRACTS) {
        const layout = layouts[name];
        const slotCount = layout.storage.length;
        const nsCount = Object.keys(layout.namespaces ?? {}).length;
        console.log(
          chalk.cyan(
            `  ${name}: ${slotCount} storage slots, ${nsCount} namespaces`
          )
        );
      }
    }
  });
