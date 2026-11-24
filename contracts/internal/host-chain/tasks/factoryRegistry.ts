import { config as dotenvConfig } from "dotenv";
import fs from "fs";
import { join, resolve } from "path";
import { task, types } from "hardhat/config";
import type { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";
import chalk from "chalk";

import { resolveTaskManager } from "../utils/addressBook";
import { confirm } from "../utils/confirm";
import { execTransactionThroughSafe, writeSafeBatch } from "../utils/safe";
import { implementationOf, runsCurrentBuild, waitForNonce } from "../utils/upgrade";
import { validateUpgrade } from "./storageLayout";

const dotenvConfigPath: string = process.env.DOTENV_CONFIG_PATH || "../.env";
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) });

const REGISTRY_SOURCE = "contracts/FactoryRegistry.sol";
const REGISTRY_NAME = "FactoryRegistry";

interface RegistryRecord {
  address: string;
}

// ---------------------------------------------------------------------------------------------
// The per-chain address record. It is committed, so every operator finds the same registry, and
// the deploy task refuses to deploy a second one.
// ---------------------------------------------------------------------------------------------

function recordFile(hre: HardhatRuntimeEnvironment): string {
  return process.env.FACTORY_REGISTRY_FILE?.trim() || join(hre.config.paths.root, "factory-registry.json");
}

async function chainKey(hre: HardhatRuntimeEnvironment): Promise<string> {
  return String((await hre.ethers.provider.getNetwork()).chainId);
}

function readRecords(hre: HardhatRuntimeEnvironment): Record<string, RegistryRecord> {
  const file = recordFile(hre);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

async function readRecord(hre: HardhatRuntimeEnvironment): Promise<RegistryRecord | null> {
  return readRecords(hre)[await chainKey(hre)] ?? null;
}

async function writeRecord(hre: HardhatRuntimeEnvironment, record: RegistryRecord): Promise<void> {
  const records = readRecords(hre);
  records[await chainKey(hre)] = record;
  fs.writeFileSync(recordFile(hre), JSON.stringify(records, null, 2) + "\n");
}

/** The registry the record names on this chain; null when there is no record or no code there. */
async function recordedRegistry(hre: HardhatRuntimeEnvironment): Promise<{ registry: any; address: string } | null> {
  const record = await readRecord(hre);
  if (!record || (await hre.ethers.provider.getCode(record.address)) === "0x") return null;
  return { registry: await hre.ethers.getContractAt(REGISTRY_NAME, record.address), address: record.address };
}

/** The deployed registry on this chain; throws when there is none. */
async function requireRegistry(hre: HardhatRuntimeEnvironment): Promise<{ registry: any; address: string }> {
  const recorded = await recordedRegistry(hre);
  if (!recorded) {
    throw new Error(
      `No FactoryRegistry recorded for chain ${await chainKey(hre)} in ${recordFile(hre)}. ` +
        `Run task:deployFactoryRegistry first.`,
    );
  }
  return recorded;
}

// ---------------------------------------------------------------------------------------------
// Who sends the calls. The first case that applies wins:
//   1. The signer, when it holds every role the calls need. The signer is the first Hardhat account of
//      --network, from DEPLOYER_PRIVATE_KEY in .env. After the admin handover it holds no roles.
//   2. The Safe at SAFE_ADMIN_ADDRESS, when SAFE_OWNER_KEY is set: each call is executed through the Safe
//      with that owner key. On testnets the admin can be a plain wallet; then that wallet sends directly.
//   3. Otherwise the task writes all calls into one Safe batch file. The Safe owners sign it later, and a
//      re-run of the task verifies the result.
// ---------------------------------------------------------------------------------------------

type Sender = { kind: "signer"; signer: any; address: string } | { kind: "safe"; address: string; owner: any | null };

async function resolveSender(
  hre: HardhatRuntimeEnvironment,
  contract: any,
  roles: { role: string; name: string }[],
  label: string,
): Promise<Sender> {
  const { ethers } = hre;
  const [signer] = await ethers.getSigners();
  const holdsAll = async (account: string) => {
    for (const { role } of roles) if (!(await contract.hasRole(role, account))) return false;
    return true;
  };
  if (signer && (await holdsAll(signer.address))) {
    return { kind: "signer", signer, address: signer.address };
  }
  const raw = process.env.SAFE_ADMIN_ADDRESS?.trim();
  const names = roles.map((r) => r.name).join(" and ");
  if (!raw) {
    throw new Error(`The signer (${signer?.address ?? "none"}) lacks ${names} on ${label}, and SAFE_ADMIN_ADDRESS is not set.`);
  }
  const safe = ethers.getAddress(raw);
  if (!(await holdsAll(safe))) {
    throw new Error(
      `Neither the signer (${signer?.address ?? "none"}) nor SAFE_ADMIN_ADDRESS (${safe}) holds ${names} on ${label}. ` +
        `Run from the account that does.`,
    );
  }
  const ownerKey = process.env.SAFE_OWNER_KEY?.trim();
  return { kind: "safe", address: safe, owner: ownerKey ? new ethers.Wallet(ownerKey, ethers.provider) : null };
}

/** Sends `calls` as `sender`. Returns false when it only wrote a Safe batch for later execution. */
async function send(
  hre: HardhatRuntimeEnvironment,
  sender: Sender,
  calls: { to: string; data: string; what: string }[],
  batch: { slug: string; name: string; taskName: string },
  out?: string,
): Promise<boolean> {
  if (sender.kind === "signer") {
    for (const call of calls) await (await sender.signer.sendTransaction({ to: call.to, data: call.data })).wait();
    return true;
  }
  if (sender.owner) {
    console.log(chalk.green(`Sending as Safe ${sender.address}, owner ${sender.owner.address}`));
    for (const call of calls) {
      if (sender.owner.address.toLowerCase() === sender.address.toLowerCase()) {
        await (await sender.owner.sendTransaction({ to: call.to, data: call.data })).wait();
      } else {
        await execTransactionThroughSafe(hre, sender.address, sender.owner, call.to, call.data);
      }
    }
    return true;
  }
  const path = writeSafeBatch(hre, {
    safeAddress: sender.address,
    slug: batch.slug,
    name: batch.name,
    description: `${calls.map((c) => c.what).join("; ")}. Generated by ${batch.taskName}.`,
    transactions: calls.map(({ to, data }) => ({ to, data })),
    outPath: out,
  });
  console.log(chalk.bold.blue("\nSAFE_OWNER_KEY not set - wrote a Safe Transaction Builder batch:"));
  console.log(`  ${path}`);
  for (const call of calls) console.log(chalk.dim(`  includes: ${call.what}`));
  console.log(
    chalk.yellow(
      "Import it in the Safe app under Apps -> Transaction Builder, review the calls, then sign and " +
        "execute. Re-run this task afterwards to verify.",
    ),
  );
  return false;
}

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

task("task:deployFactoryRegistry", "Deploy the FactoryRegistry proxy on this chain, once")
  .addFlag("yes", "Skip the confirmation prompt")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, upgrades } = hre;
    const existing = await recordedRegistry(hre);
    if (existing) {
      console.log(chalk.green(`FactoryRegistry already deployed at ${existing.address} - nothing to do.`));
      console.log(chalk.dim("Run task:inspectFactoryRegistry to see its state."));
      return;
    }

    const [signer] = await ethers.getSigners();
    const tmAddress = await resolveTaskManager(hre);
    const tm: any = await ethers.getContractAt("TaskManager", tmAddress);
    const rawSafe = process.env.SAFE_ADMIN_ADDRESS?.trim();
    const admin = rawSafe ? ethers.getAddress(rawSafe) : signer.address;
    // The same delay as the TaskManager, so the registry's admin is never easier to move.
    const delay: bigint = await tm.defaultAdminDelay();

    const question = `Deploy FactoryRegistry on ${hre.network.name} with admin ${admin} and admin delay ${delay} s?`;
    if (!(await confirm(question, taskArguments.yes))) {
      console.log(chalk.yellow("Aborted - nothing was deployed."));
      return;
    }

    const Factory = await ethers.getContractFactory(REGISTRY_NAME, signer);
    // The proxy runs initialize in its own constructor, so nobody can front-run it.
    const proxy: any = await upgrades.deployProxy(Factory, [admin, delay], { kind: "uups", initializer: "initialize" });
    await proxy.waitForDeployment();
    const address = await proxy.getAddress();
    await writeRecord(hre, { address });

    console.log(chalk.green(`FactoryRegistry deployed at ${address}, admin ${admin}`));
    console.log(chalk.dim(`Recorded in ${recordFile(hre)} - commit it.`));
    console.log(chalk.dim(`Verify the source: npx hardhat verify --network ${hre.network.name} ${address}`));
  });

task("task:upgradeFactoryRegistry", "Upgrade the FactoryRegistry proxy in place to this build")
  .addParam("onlyvalidate", "Only validate the storage layout", false, types.boolean)
  .addOptionalParam("out", "Path for the Safe batch file, when one is written")
  .addFlag("yes", "Skip the confirmation prompt")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers } = hre;
    const { registry, address } = await requireRegistry(hre);
    const oldImplementation = await implementationOf(ethers, address);
    if (await runsCurrentBuild(hre, address, REGISTRY_SOURCE, REGISTRY_NAME)) {
      console.log(chalk.green(`FactoryRegistry ${address} already runs this build - nothing to do.`));
      return;
    }
    const Factory = await ethers.getContractFactory(REGISTRY_NAME);
    await validateUpgrade(hre, REGISTRY_NAME, Factory);
    if (taskArguments.onlyvalidate) return;

    const sender = await resolveSender(
      hre,
      registry,
      [{ role: await registry.UPGRADER_ROLE(), name: "UPGRADER_ROLE" }],
      `FactoryRegistry ${address}`,
    );
    const question = `Upgrade FactoryRegistry ${address} on ${hre.network.name} as ${sender.address}?`;
    if (!(await confirm(question, taskArguments.yes))) {
      console.log(chalk.yellow("Aborted - nothing was deployed or sent."));
      return;
    }
    const [deployer] = await ethers.getSigners();
    if (!deployer) {
      throw new Error("Set a funded DEPLOYER_PRIVATE_KEY: it deploys the new implementation before the upgrade is sent.");
    }
    const implementation = await Factory.connect(deployer).deploy();
    await implementation.waitForDeployment();
    const newImplementation = await implementation.getAddress();
    await waitForNonce(ethers, deployer.address, implementation.deploymentTransaction()!.nonce);
    console.log(chalk.green(`New implementation: ${newImplementation}`));

    const sent = await send(
      hre,
      sender,
      [
        {
          to: address,
          data: registry.interface.encodeFunctionData("upgradeToAndCall", [newImplementation, "0x"]),
          what: `upgradeToAndCall(${newImplementation}, 0x) on FactoryRegistry ${address}`,
        },
      ],
      { slug: "upgrade-factory-registry", name: "CoFHE - upgrade the FactoryRegistry", taskName: "task:upgradeFactoryRegistry" },
      taskArguments.out,
    );
    if (!sent) {
      console.log(chalk.yellow("Re-run only after the batch executes: a re-run before that deploys another implementation."));
      return;
    }
    if (!(await runsCurrentBuild(hre, address, REGISTRY_SOURCE, REGISTRY_NAME))) {
      throw new Error(`The upgrade executed but ${address} does not run this build (was ${oldImplementation}).`);
    }
    console.log(chalk.green(`Upgraded: implementation ${oldImplementation} -> ${newImplementation}`));
  });

task("task:inspectFactoryRegistry", "Print the FactoryRegistry's state on this chain (read only)").setAction(
  async function (_taskArguments: TaskArguments, hre) {
    const { ethers } = hre;
    const { registry, address } = await requireRegistry(hre);
    const tmAddress = await resolveTaskManager(hre);
    const tm: any = await ethers.getContractAt("TaskManager", tmAddress);
    const [pendingAdmin, schedule] = await registry.pendingDefaultAdmin();

    console.log(chalk.bold(`FactoryRegistry ${address} on ${hre.network.name}`));
    console.log(`  implementation:      ${await implementationOf(ethers, address)}` +
      `${(await runsCurrentBuild(hre, address, REGISTRY_SOURCE, REGISTRY_NAME)) ? " (this build)" : " (NOT this build)"}`);
    console.log(`  default admin:       ${await registry.defaultAdmin()}, delay ${await registry.defaultAdminDelay()} s`);
    console.log(`  pending admin:       ${pendingAdmin === ethers.ZeroAddress ? "none" : `${pendingAdmin} after ${schedule}`}`);
    const pointer = await registry.taskManager();
    console.log(`  TaskManager:         ${pointer}${pointer === tmAddress ? "" : chalk.red(` (address book says ${tmAddress})`)}`);
    console.log(`  holds TM list role:  ${await tm.hasRole(await tm.ACCESS_LIST_MANAGER_ROLE(), address)}`);

    const safe = process.env.SAFE_ADMIN_ADDRESS?.trim();
    if (safe) {
      for (const name of ["DEFAULT_ADMIN_ROLE", "UPGRADER_ROLE", "FACTORY_APPROVER_ROLE", "REVOKER_ROLE"]) {
        console.log(`  Safe holds ${name.padEnd(22)} ${await registry.hasRole(await registry[name](), ethers.getAddress(safe))}`);
      }
    }
  },
);
