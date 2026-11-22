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
const TX_GAS_CAP = 16_777_216n; // Ethereum's per-transaction cap (EIP-7825)
const LOG_WINDOW = 10_000;

interface RegistryRecord {
  address: string;
  block: number; // the deploy block, where the event scans in task:inspectFactoryRegistry start
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

export async function readRecord(hre: HardhatRuntimeEnvironment): Promise<RegistryRecord | null> {
  return readRecords(hre)[await chainKey(hre)] ?? null;
}

async function writeRecord(hre: HardhatRuntimeEnvironment, record: RegistryRecord): Promise<void> {
  const records = readRecords(hre);
  records[await chainKey(hre)] = record;
  fs.writeFileSync(recordFile(hre), JSON.stringify(records, null, 2) + "\n");
}

/** The deployed registry on this chain; throws when there is none. */
async function requireRegistry(hre: HardhatRuntimeEnvironment): Promise<{ registry: any; address: string; record: RegistryRecord }> {
  const record = await readRecord(hre);
  if (!record || (await hre.ethers.provider.getCode(record.address)) === "0x") {
    throw new Error(
      `No FactoryRegistry recorded for chain ${await chainKey(hre)} in ${recordFile(hre)}. ` +
        `Run task:deployFactoryRegistry first.`,
    );
  }
  const registry = await hre.ethers.getContractAt(REGISTRY_NAME, record.address);
  return { registry, address: record.address, record };
}

// ---------------------------------------------------------------------------------------------
// Who sends: the signer when it holds the role, otherwise the Safe at SAFE_ADMIN_ADDRESS - executed
// with SAFE_OWNER_KEY (an EOA final admin sends directly), else written as one Safe batch.
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
    const existing = await readRecord(hre);
    if (existing && (await ethers.provider.getCode(existing.address)) !== "0x") {
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
    const receipt = await proxy.deploymentTransaction()!.wait();
    // Recorded before the checks: if they fail, a re-run must find this proxy, not deploy a second one.
    await writeRecord(hre, { address, block: receipt.blockNumber });

    const problems: string[] = [];
    if ((await proxy.taskManager()) !== tmAddress) problems.push(`taskManager() is not ${tmAddress}`);
    if ((await proxy.defaultAdmin()) !== admin) problems.push(`defaultAdmin() is not ${admin}`);
    if ((await proxy.defaultAdminDelay()) !== delay) problems.push(`defaultAdminDelay() is not ${delay}`);
    for (const name of ["UPGRADER_ROLE", "FACTORY_APPROVER_ROLE", "REVOKER_ROLE"]) {
      if (!(await proxy.hasRole(await proxy[name](), admin))) problems.push(`${admin} lacks ${name}`);
    }
    if (problems.length > 0) {
      throw new Error(`FactoryRegistry at ${address} is not in the expected state: ${problems.join("; ")}.`);
    }

    console.log(chalk.green(`FactoryRegistry deployed at ${address} (block ${receipt.blockNumber}), admin ${admin}`));
    console.log(chalk.dim(`Recorded in ${recordFile(hre)} - commit it.`));
    console.log(chalk.dim(`Verify the source: npx hardhat verify --network ${hre.network.name} ${address}`));
    console.log(chalk.dim("Next: task:grantRegistryRole"));
  });

task("task:grantRegistryRole", "Grant the TaskManager's ACCESS_LIST_MANAGER_ROLE to the FactoryRegistry")
  .addOptionalParam("out", "Path for the Safe batch file, when one is written")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers } = hre;
    const { registry, address } = await requireRegistry(hre);
    const tmAddress = await resolveTaskManager(hre);
    const tm: any = await ethers.getContractAt("TaskManager", tmAddress);

    // The role lets the holder open or close the whole list, so check who controls the registry first.
    if (!(await runsCurrentBuild(hre, address, REGISTRY_SOURCE, REGISTRY_NAME))) {
      throw new Error(
        `${address} is not a proxy running this FactoryRegistry build (implementation ` +
          `${await implementationOf(ethers, address)}). Grant the role only to a reviewed build.`,
      );
    }
    if ((await registry.taskManager()) !== tmAddress) {
      throw new Error(`The registry writes to ${await registry.taskManager()}, not to this TaskManager ${tmAddress}.`);
    }
    const [pendingAdmin] = await registry.pendingDefaultAdmin();
    if (pendingAdmin !== ethers.ZeroAddress) {
      throw new Error(`A default-admin transfer of the registry to ${pendingAdmin} is pending. Finish or cancel it first.`);
    }
    const [pendingDelay] = await registry.pendingDefaultAdminDelay();
    if (pendingDelay !== 0n || (await registry.defaultAdminDelay()) < (await tm.defaultAdminDelay())) {
      throw new Error("The registry's admin delay is, or is about to be, shorter than the TaskManager's.");
    }
    const [signer] = await ethers.getSigners();
    const rawSafe = process.env.SAFE_ADMIN_ADDRESS?.trim();
    const expectedAdmin = rawSafe ? ethers.getAddress(rawSafe) : signer.address;
    const admin = await registry.defaultAdmin();
    if (admin !== expectedAdmin) {
      throw new Error(`The registry's admin is ${admin}, not ${expectedAdmin}. Its upgrade key would control the role.`);
    }
    const upgrader = await registry.UPGRADER_ROLE();
    if (!(await registry.hasRole(upgrader, admin))) {
      throw new Error(`The registry's admin ${admin} does not hold UPGRADER_ROLE.`);
    }
    if (signer && signer.address !== admin && (await registry.hasRole(upgrader, signer.address))) {
      throw new Error(`The signer ${signer.address} still holds the registry's UPGRADER_ROLE. Revoke it first.`);
    }

    const role = await tm.ACCESS_LIST_MANAGER_ROLE();
    if (await tm.hasRole(role, address)) {
      console.log(chalk.green(`The registry ${address} already holds ACCESS_LIST_MANAGER_ROLE - nothing to do.`));
      return;
    }
    const sender = await resolveSender(
      hre,
      tm,
      [{ role: await tm.DEFAULT_ADMIN_ROLE(), name: "DEFAULT_ADMIN_ROLE" }],
      `TaskManager ${tmAddress}`,
    );
    const sent = await send(
      hre,
      sender,
      [
        {
          to: tmAddress,
          data: tm.interface.encodeFunctionData("grantRole", [role, address]),
          what: `grantRole(ACCESS_LIST_MANAGER_ROLE, ${address}) on TaskManager ${tmAddress}`,
        },
      ],
      { slug: "grant-registry-role", name: "CoFHE - grant the FactoryRegistry its TaskManager role", taskName: "task:grantRegistryRole" },
      taskArguments.out,
    );
    if (!sent) return;
    if (!(await tm.hasRole(role, address))) {
      throw new Error("The transaction executed but the registry still lacks ACCESS_LIST_MANAGER_ROLE.");
    }
    console.log(chalk.green(`The registry ${address} now holds ACCESS_LIST_MANAGER_ROLE.`));
  });

task("task:approveFactory", "Approve a factory as the root of a new tree in the FactoryRegistry")
  .addParam("factory", "The factory address")
  .addOptionalParam("out", "Path for the Safe batch file, when one is written")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers } = hre;
    const factory = ethers.getAddress(taskArguments.factory);
    if (factory === ethers.ZeroAddress) throw new Error("refusing to approve address(0).");
    const { registry, address } = await requireRegistry(hre);
    const tm: any = await ethers.getContractAt("TaskManager", await registry.taskManager());

    const [parent] = await registry.nodeOf(factory);
    if (parent === address) {
      if (!(await tm.accessList(factory))) {
        throw new Error(
          `${factory} is approved in the registry but not on the TaskManager list (removed by hand?). ` +
            `Run task:unregisterFromRegistry, then task:approveFactory again.`,
        );
      }
      console.log(chalk.green(`${factory} is already an approved factory - nothing to do.`));
      return;
    }
    if ((await ethers.provider.getCode(factory)) === "0x") {
      console.log(chalk.yellow(`${factory}: no code on ${hre.network.name}. An address without code is approved only if it is a wallet you trust.`));
    }
    if (parent === ethers.ZeroAddress && (await tm.accessList(factory))) {
      throw new Error(
        `${factory} is on the TaskManager list by hand. To keep its access, adopt it: ` +
          `task:adoptIntoRegistry --accounts ${factory}.`,
      );
    }

    const roles = [{ role: await registry.FACTORY_APPROVER_ROLE(), name: "FACTORY_APPROVER_ROLE" }];
    const calls: { to: string; data: string; what: string }[] = [];
    if (parent !== ethers.ZeroAddress) {
      // Someone registered the factory's address under another tree first: take it back.
      console.log(chalk.yellow(`${factory} is registered under ${parent}. It is unregistered first, in the same batch.`));
      roles.push({ role: await registry.REVOKER_ROLE(), name: "REVOKER_ROLE" });
      calls.push({
        to: address,
        data: registry.interface.encodeFunctionData("unregister", [factory]),
        what: `unregister(${factory})`,
      });
    }
    calls.push({
      to: address,
      data: registry.interface.encodeFunctionData("approveFactory", [factory]),
      what: `approveFactory(${factory})`,
    });

    const sender = await resolveSender(hre, registry, roles, `FactoryRegistry ${address}`);
    if (calls.length > 1 && !(sender.kind === "safe" && sender.owner === null)) {
      // Two separate transactions leave a gap in which the squatter's parent can register it again.
      throw new Error(
        `${factory} is squatted under ${parent}. Taking it back is atomic only as one Safe batch: unset ` +
          `SAFE_OWNER_KEY to write it. Without a Safe, run task:unregisterFromRegistry, then task:approveFactory.`,
      );
    }
    const sent = await send(
      hre,
      sender,
      calls,
      { slug: "approve-factory", name: "CoFHE - approve a factory in the FactoryRegistry", taskName: "task:approveFactory" },
      taskArguments.out,
    );
    if (!sent) return;
    const [now] = await registry.nodeOf(factory);
    if (now !== address || !(await tm.accessList(factory))) {
      throw new Error(`The transaction executed but ${factory} is not an approved factory on the TaskManager list.`);
    }
    console.log(chalk.green(`${factory} is approved and on the TaskManager list.`));
  });

task("task:adoptIntoRegistry", "Move addresses already on the TaskManager list into a FactoryRegistry tree")
  .addParam("accounts", "Comma-separated addresses, all already on the TaskManager list")
  .addOptionalParam("parent", "The registered parent; omit to adopt the accounts as approved factories")
  .addOptionalParam("out", "Path for the Safe batch file, when one is written")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers } = hre;
    const { registry, address } = await requireRegistry(hre);
    const tm: any = await ethers.getContractAt("TaskManager", await registry.taskManager());
    const parent = taskArguments.parent ? ethers.getAddress(taskArguments.parent) : address;
    const accounts = [...new Set((taskArguments.accounts as string).split(",").map((a) => ethers.getAddress(a.trim())))];
    if (parent !== address && (await registry.nodeOf(parent))[0] === ethers.ZeroAddress) {
      throw new Error(`The parent ${parent} is not registered in FactoryRegistry ${address}.`);
    }

    const todo: string[] = [];
    for (const account of accounts) {
      const [now] = await registry.nodeOf(account);
      if (now === parent) {
        // Adopted on an earlier run; flag it if someone took it off the list by hand since.
        if (!(await tm.accessList(account))) {
          console.log(chalk.yellow(`${account} is adopted but no longer on the TaskManager list. Unregister it, or add it back by hand.`));
        }
        continue;
      }
      if (now !== ethers.ZeroAddress) throw new Error(`${account} is already registered under ${now}.`);
      if (!(await tm.accessList(account))) throw new Error(`${account} is not on the TaskManager list. Use task:approveFactory or register instead.`);
      todo.push(account);
    }
    if (todo.length === 0) {
      console.log(chalk.green("Every account is already adopted - nothing to do."));
      return;
    }
    console.log(chalk.yellow(`Adopting ${todo.length} account(s) under ${parent === address ? "the registry, as approved factories" : parent}.`));
    console.log(chalk.yellow("Their tree can now remove them, and they can register contracts. Check that they belong to it."));

    // shortcut: one call, about 53k gas per account (250 measured at 13.3M); past about 300 accounts it
    // passes Ethereum's 2^24 per-transaction cap, so split the list then.
    const calls = [
      parent === address
        ? {
            to: address,
            data: registry.interface.encodeFunctionData("adoptFactories", [todo]),
            what: `adoptFactories(${todo.length} accounts)`,
          }
        : {
            to: address,
            data: registry.interface.encodeFunctionData("adopt", [parent, todo]),
            what: `adopt(${parent}, ${todo.length} accounts)`,
          },
    ];
    const sender = await resolveSender(
      hre,
      registry,
      [{ role: await registry.FACTORY_APPROVER_ROLE(), name: "FACTORY_APPROVER_ROLE" }],
      `FactoryRegistry ${address}`,
    );
    const sent = await send(
      hre,
      sender,
      calls,
      { slug: "adopt", name: "CoFHE - adopt access-list entries into the FactoryRegistry", taskName: "task:adoptIntoRegistry" },
      taskArguments.out,
    );
    if (!sent) return;
    for (const account of todo) {
      if ((await registry.nodeOf(account))[0] !== parent) throw new Error(`The transaction executed but ${account} is not under ${parent}.`);
    }
    console.log(chalk.green(`${todo.length} account(s) adopted under ${parent}.`));
  });

task("task:unregisterFromRegistry", "Remove a contract and everything below it from the FactoryRegistry")
  .addParam("target", "The contract to remove")
  .addOptionalParam("out", "Path for the Safe batch file, when one is written")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers } = hre;
    const target = ethers.getAddress(taskArguments.target);
    const { registry, address } = await requireRegistry(hre);
    const [parent, depth] = await registry.nodeOf(target);
    if (parent === ethers.ZeroAddress) {
      throw new Error(`${target} is not registered in FactoryRegistry ${address}.`);
    }
    const tm: any = await ethers.getContractAt("TaskManager", await registry.taskManager());
    if (!(await tm.accessListEnabled())) {
      // While the list is disabled the TaskManager checks only the deny list, so unregistering blocks nothing yet.
      console.log(
        chalk.yellow("The access list is disabled - unregistering blocks nothing now. To block now, use task:addToDenyList."),
      );
    }
    if (parent === address) {
      console.log(chalk.yellow(`${target} is an approved factory with ${await registry.treeSizeOf(target)} contracts below it.`));
    } else {
      console.log(chalk.dim(`${target} sits at depth ${depth} under ${parent}.`));
    }

    const sender = await resolveSender(
      hre,
      registry,
      [{ role: await registry.REVOKER_ROLE(), name: "REVOKER_ROLE" }],
      `FactoryRegistry ${address}`,
    );
    const data = registry.interface.encodeFunctionData("unregister", [target]);
    const gas = await ethers.provider.estimateGas({ from: sender.address, to: address, data });
    console.log(chalk.dim(`Estimated gas: ${gas}`));
    if (gas > TX_GAS_CAP) {
      throw new Error(`Unregistering ${target} needs ${gas} gas, over the ${TX_GAS_CAP} cap. Unregister contracts below it first.`);
    }
    const sent = await send(
      hre,
      sender,
      [{ to: address, data, what: `unregister(${target})` }],
      { slug: "unregister", name: "CoFHE - unregister from the FactoryRegistry", taskName: "task:unregisterFromRegistry" },
      taskArguments.out,
    );
    if (!sent) return;
    const [now] = await registry.nodeOf(target);
    if (now !== ethers.ZeroAddress) throw new Error(`The transaction executed but ${target} is still registered.`);
    console.log(chalk.green(`${target} and everything below it are unregistered.`));
  });

task("task:setRegistryRevoker", "Grant or revoke the FactoryRegistry's REVOKER_ROLE, e.g. for an ops key")
  .addParam("account", "The account")
  .addParam("revoke", "Revoke instead of grant", false, types.boolean)
  .addOptionalParam("out", "Path for the Safe batch file, when one is written")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers } = hre;
    const account = ethers.getAddress(taskArguments.account);
    const revoke: boolean = taskArguments.revoke;
    const { registry, address } = await requireRegistry(hre);
    const role = await registry.REVOKER_ROLE();
    if ((await registry.hasRole(role, account)) !== revoke) {
      console.log(chalk.green(`${account}: REVOKER_ROLE already ${revoke ? "revoked" : "held"} - nothing to do.`));
      return;
    }
    const method = revoke ? "revokeRole" : "grantRole";
    const sender = await resolveSender(
      hre,
      registry,
      [{ role: await registry.DEFAULT_ADMIN_ROLE(), name: "DEFAULT_ADMIN_ROLE" }],
      `FactoryRegistry ${address}`,
    );
    const sent = await send(
      hre,
      sender,
      [{ to: address, data: registry.interface.encodeFunctionData(method, [role, account]), what: `${method}(REVOKER_ROLE, ${account})` }],
      { slug: revoke ? "revoke-revoker" : "grant-revoker", name: "CoFHE - FactoryRegistry REVOKER_ROLE", taskName: "task:setRegistryRevoker" },
      taskArguments.out,
    );
    if (!sent) return;
    if ((await registry.hasRole(role, account)) === revoke) {
      throw new Error(`The transaction executed but ${account}'s REVOKER_ROLE did not change.`);
    }
    console.log(chalk.green(`${account}: REVOKER_ROLE ${revoke ? "revoked" : "granted"}.`));
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
    const { registry, address, record } = await requireRegistry(hre);
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

    // RPC providers cap one log query at about 10,000 blocks, so scan in windows.
    const latest = await ethers.provider.getBlockNumber();
    const roots = new Set<string>();
    for (let from = record.block; from <= latest; from += LOG_WINDOW) {
      const to = Math.min(from + LOG_WINDOW - 1, latest);
      for (const e of await registry.queryFilter(registry.filters.FactoryApproved(), from, to)) {
        roots.add((e as any).args.factory as string);
      }
    }
    console.log(`  approved factories:  ${roots.size === 0 ? "none" : ""}`);
    for (const root of roots) {
      const [parent] = await registry.nodeOf(root);
      const live = parent === address;
      console.log(`    ${root}  ${live ? `${await registry.treeSizeOf(root)} live contracts` : "unregistered"}`);
    }
  },
);
