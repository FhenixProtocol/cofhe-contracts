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
  type ValidationDataCurrent,
  type StorageLayout,
} from "@openzeppelin/upgrades-core";

const TRACKED_CONTRACTS = ["TaskManager", "ACL", "PlaintextsStorage"];

const SNAPSHOT_FILE = "storage-layout-snapshot.json";

interface NormalizedLayout {
  storage: Array<{
    label: string;
    slot: string;
    offset: number;
    type: string;
  }>;
  types: Record<string, { label: string; numberOfBytes: string; members?: unknown[] }>;
  namespaces: Record<
    string,
    Array<{ label: string; slot: string; offset: number; type: string }>
  >;
}

interface Snapshot {
  version: number;
  contracts: Record<string, NormalizedLayout>;
}

/**
 * Strip AST node IDs from type identifiers.
 * e.g. "t_contract(ACL)8522" -> "t_contract(ACL)"
 *      "t_struct(TaskManagerStorage)12345_storage" -> "t_struct(TaskManagerStorage)_storage"
 */
function stripTypeIds(typeId: string): string {
  return typeId.replace(/\)\d+/g, ")");
}

function normalizeLayout(layout: StorageLayout): NormalizedLayout {
  const storage = layout.storage.map((item) => ({
    label: item.label,
    slot: item.slot ?? "0",
    offset: item.offset ?? 0,
    type: stripTypeIds(item.type),
  }));

  const types: NormalizedLayout["types"] = {};
  for (const [key, value] of Object.entries(layout.types)) {
    const normalizedKey = stripTypeIds(key);
    types[normalizedKey] = {
      label: value.label,
      numberOfBytes: value.numberOfBytes ?? "0",
    };
    if (value.members && Array.isArray(value.members)) {
      types[normalizedKey].members = value.members.map((m: any) => {
        if (typeof m === "string") return m;
        return {
          label: m.label,
          type: stripTypeIds(m.type),
          ...(m.offset !== undefined && { offset: m.offset }),
          ...(m.slot !== undefined && { slot: m.slot }),
        };
      });
    }
  }

  const namespaces: NormalizedLayout["namespaces"] = {};
  if (layout.namespaces) {
    for (const [ns, items] of Object.entries(layout.namespaces)) {
      namespaces[ns] = items.map((item) => ({
        label: item.label,
        slot: item.slot ?? "0",
        offset: item.offset ?? 0,
        type: stripTypeIds(item.type),
      }));
    }
  }

  return { storage, types, namespaces };
}

async function extractLayouts(
  hre: HardhatRuntimeEnvironment
): Promise<Record<string, NormalizedLayout>> {
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

  const layouts: Record<string, NormalizedLayout> = {};

  for (const contractName of TRACKED_CONTRACTS) {
    // Search all log entries for the contract
    let found = false;
    for (const runData of validationData.log) {
      const fqn = Object.keys(runData).find((key) =>
        key.endsWith(`:${contractName}`)
      );
      if (fqn) {
        const version = getContractVersion(runData, fqn);
        const layout = getStorageLayout(validationData, version);
        layouts[contractName] = normalizeLayout(layout);
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
  .addFlag("check", "Check current layout against committed snapshot")
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
      const current: Snapshot = { version: 1, contracts: layouts };

      const committedStr = JSON.stringify(committed, null, 2);
      const currentStr = JSON.stringify(current, null, 2);

      if (committedStr === currentStr) {
        console.log(
          chalk.green("Storage layout matches committed snapshot.")
        );
      } else {
        console.log(
          chalk.red("Storage layout has changed from committed snapshot!")
        );
        console.log(
          chalk.yellow(
            "If this change is intentional, run 'pnpm storage-layout:generate' and commit the updated snapshot."
          )
        );

        // Show which contracts changed
        for (const name of TRACKED_CONTRACTS) {
          const committedLayout = JSON.stringify(
            committed.contracts[name],
            null,
            2
          );
          const currentLayout = JSON.stringify(
            current.contracts[name],
            null,
            2
          );
          if (committedLayout !== currentLayout) {
            console.log(chalk.red(`  - ${name} storage layout changed`));
          }
        }

        process.exit(1);
      }
    } else {
      const snapshot: Snapshot = { version: 1, contracts: layouts };
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n");
      console.log(chalk.green(`Storage layout snapshot written to ${SNAPSHOT_FILE}`));

      for (const name of TRACKED_CONTRACTS) {
        const layout = layouts[name];
        const slotCount = layout.storage.length;
        const nsCount = Object.keys(layout.namespaces).length;
        console.log(
          chalk.cyan(
            `  ${name}: ${slotCount} storage slots, ${nsCount} namespaces`
          )
        );
      }
    }
  });
