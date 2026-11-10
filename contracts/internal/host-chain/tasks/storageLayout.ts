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

const TRACKED_CONTRACTS = ["TaskManager", "ACL", "PlaintextsStorage", "ACPShareRegistry", "CoFHEAddressBook"];

const SNAPSHOT_FILE = "storage-layout-snapshot.json";

interface Snapshot {
  version: number;
  contracts: Record<string, StorageLayout>;
}

async function extractLayouts(
  hre: HardhatRuntimeEnvironment
): Promise<Record<string, StorageLayout>> {
  const layouts: Record<string, StorageLayout> = {};

  for (const contractName of TRACKED_CONTRACTS) {
    // Use the build-info the current artifact points to. artifacts/build-info can still hold older
    // builds of the same source, and picking one of those would check a stale layout.
    const artifact = await hre.artifacts.readArtifact(contractName);
    const fqn = `${artifact.sourceName}:${artifact.contractName}`;
    const buildInfo = await hre.artifacts.getBuildInfo(fqn);
    if (!buildInfo) {
      throw new Error(`No build-info for ${fqn}. Run \`pnpm compile\` first.`);
    }
    const decodeSrc = solcInputOutputDecoder(buildInfo.input, buildInfo.output);
    const runData = validate(buildInfo.output, decodeSrc, buildInfo.solcVersion, buildInfo.input);
    const validationData: ValidationDataCurrent = concatRunData(runData, undefined);
    layouts[contractName] = getStorageLayout(validationData, getContractVersion(runData, fqn));
  }

  return layouts;
}

/**
 * Throws unless the compiled storage layout of `contractName` is upgrade-compatible with the snapshot.
 * The committed snapshot is the layout of the deployed proxies, so an upgrade checks against it
 * instead of against the build it is about to deploy.
 */
export async function requireLayoutMatchesSnapshot(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  snapshotPath: string = path.join(hre.config.paths.root, SNAPSHOT_FILE)
): Promise<void> {
  await hre.run("compile");
  const committed: Snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const original = committed.contracts[contractName];
  if (!original) {
    throw new Error(`${contractName} is not in ${snapshotPath}, so its upgrade cannot be checked.`);
  }
  const updated = (await extractLayouts(hre))[contractName];
  const report = getStorageUpgradeReport(original, updated, withValidationDefaults({}));
  if (!report.ok) {
    throw new Error(
      `${contractName} storage layout is NOT upgrade-compatible with ${snapshotPath}:\n${report.explain(true)}`
    );
  }
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
