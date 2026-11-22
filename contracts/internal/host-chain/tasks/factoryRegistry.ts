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
// The exact proxy that upgrades.deployProxy deploys: read from the plugin's own copy of upgrades-core.
const PROXY_DEPLOYED_BYTECODE: string = require(
  require.resolve("@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts-v5/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json", {
    paths: [require.resolve("@openzeppelin/hardhat-upgrades")],
  }),
).deployedBytecode;
// Ethereum's per-transaction cap (EIP-7825), less a 10% margin for the Safe's execTransaction and MultiSend.
const TX_GAS_CAP = (16_777_216n * 9n) / 10n;

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

/** Whether the registry controls this TaskManager's list: it writes to it and holds its role. */
async function controlsList(registry: any, address: string, tm: any, tmAddress: string): Promise<boolean> {
  return (await registry.taskManager()) === tmAddress && (await tm.hasRole(await tm.ACCESS_LIST_MANAGER_ROLE(), address));
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
    console.log(chalk.dim("Next: task:grantRegistryRole"));
  });

task("task:grantRegistryRole", "Grant the TaskManager's ACCESS_LIST_MANAGER_ROLE to the FactoryRegistry")
  .addFlag("yes", "Skip the confirmation prompt")
  .addOptionalParam("out", "Path for the Safe batch file, when one is written")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers } = hre;
    const { registry, address } = await requireRegistry(hre);
    const tmAddress = await resolveTaskManager(hre);
    const tm: any = await ethers.getContractAt("TaskManager", tmAddress);

    // The role lets the holder open or close the whole list, so check who controls the registry first.
    // Any contract can copy the implementation slot, so the recorded address must be the proxy itself.
    if ((await ethers.provider.getCode(address)) !== PROXY_DEPLOYED_BYTECODE) {
      throw new Error(`${address} is not the ERC1967 proxy that task:deployFactoryRegistry deploys. Check ${recordFile(hre)}.`);
    }
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
    const question = `Grant ACCESS_LIST_MANAGER_ROLE on TaskManager ${tmAddress} to FactoryRegistry ${address} on ${hre.network.name}?`;
    if (!(await confirm(question, taskArguments.yes))) {
      console.log(chalk.yellow("Aborted - nothing was sent."));
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
    const tmAddress = await resolveTaskManager(hre);
    const tm: any = await ethers.getContractAt("TaskManager", tmAddress);
    if (!(await controlsList(registry, address, tm, tmAddress))) {
      throw new Error(`The registry does not control TaskManager ${tmAddress}'s list. Run task:grantRegistryRole first.`);
    }

    const [parent] = await registry.nodeOf(factory);
    if (parent === address) {
      if (!(await tm.accessList(factory))) {
        // revokeAccess would unregister its whole tree; only the root's own entry is missing.
        throw new Error(
          `${factory} is approved in the registry but not on the TaskManager list (removed by hand?). ` +
            `Add it back with task:addToAccessList --accounts ${factory}.`,
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
      console.log(
        chalk.yellow(
          `${factory} is registered under ${parent}. It is unregistered first, in the same batch: ` +
            "every contract registered below it loses access too.",
        ),
      );
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
          `SAFE_OWNER_KEY to write it. Without a Safe, run task:revokeAccess, then task:approveFactory.`,
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
    const tmAddress = await resolveTaskManager(hre);
    const tm: any = await ethers.getContractAt("TaskManager", tmAddress);
    // Adopted nodes must stay removable: on a registry that does not control the list, unregister reverts.
    if (!(await controlsList(registry, address, tm, tmAddress))) {
      throw new Error(`The registry does not control TaskManager ${tmAddress}'s list. Run task:grantRegistryRole first.`);
    }
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

    const asRoots = parent === address;
    const data = asRoots
      ? registry.interface.encodeFunctionData("adoptFactories", [todo])
      : registry.interface.encodeFunctionData("adopt", [parent, todo]);
    const what = asRoots ? `adoptFactories(${todo.length} accounts)` : `adopt(${parent}, ${todo.length} accounts)`;
    const sender = await resolveSender(
      hre,
      registry,
      [{ role: await registry.FACTORY_APPROVER_ROLE(), name: "FACTORY_APPROVER_ROLE" }],
      `FactoryRegistry ${address}`,
    );
    // About 53k gas per account (250 measured at 13.3M): fail here rather than in the Safe.
    const gas = await ethers.provider.estimateGas({ from: sender.address, to: address, data });
    if (gas > TX_GAS_CAP) {
      throw new Error(`Adopting ${todo.length} accounts needs ${gas} gas, over the ${TX_GAS_CAP} cap. Split the list.`);
    }
    const sent = await send(
      hre,
      sender,
      [{ to: address, data, what }],
      { slug: "adopt", name: "CoFHE - adopt access-list entries into the FactoryRegistry", taskName: "task:adoptIntoRegistry" },
      taskArguments.out,
    );
    if (!sent) return;
    for (const account of todo) {
      if ((await registry.nodeOf(account))[0] !== parent) throw new Error(`The transaction executed but ${account} is not under ${parent}.`);
    }
    console.log(chalk.green(`${todo.length} account(s) adopted under ${parent}.`));
  });

task("task:revokeAccess", "Take CoFHE access away from accounts, through the FactoryRegistry or the TaskManager list")
  .addParam("accounts", "Comma-separated addresses")
  .addFlag("yes", "Skip the confirmation prompt")
  .addOptionalParam("out", "Path for the Safe batch file, when one is written")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers } = hre;
    const accounts = [...new Set((taskArguments.accounts as string).split(",").map((a) => ethers.getAddress(a.trim())))];
    if (accounts.includes(ethers.ZeroAddress)) throw new Error("refusing to revoke address(0).");
    const tmAddress = await resolveTaskManager(hre);
    const tm: any = await ethers.getContractAt("TaskManager", tmAddress);
    if (!(await tm.accessListEnabled())) {
      // While the list is disabled the TaskManager checks only the deny list, so a revoke blocks nothing yet.
      console.log(chalk.yellow("The access list is disabled - revoking blocks nothing now. To block now, use task:addToDenyList."));
    }
    const recorded = await recordedRegistry(hre);
    const live = recorded && (await controlsList(recorded.registry, recorded.address, tm, tmAddress)) ? recorded : null;
    const inTree = async (a: string) => (await recorded!.registry.nodeOf(a))[0] !== ethers.ZeroAddress;

    // A tree node goes through unregister, so its subtree goes with it and no node is left without access.
    const tracked = new Set<string>();
    const manual: string[] = [];
    for (const account of accounts) {
      if (live && (await inTree(account))) {
        tracked.add(account);
        continue;
      }
      if (recorded && !live && (await inTree(account))) {
        console.log(
          chalk.yellow(
            `${account} is in a FactoryRegistry tree, but the registry does not control this TaskManager list: ` +
              "contracts below it keep their access. Restore the role with task:grantRegistryRole and re-run.",
          ),
        );
      }
      if (await tm.accessList(account)) manual.push(account);
      else console.log(chalk.green(`${account}: no access to revoke - nothing to do`));
    }
    // Unregistering an ancestor already removes its descendants; a second unregister would revert the batch.
    const unregister: string[] = [];
    for (const account of tracked) {
      let covered = false;
      let a = (await live!.registry.nodeOf(account))[0];
      while (a !== live!.address && a !== ethers.ZeroAddress) {
        if (tracked.has(a)) covered = true;
        a = (await live!.registry.nodeOf(a))[0];
      }
      if (covered) console.log(chalk.dim(`${account}: removed with an account above it`));
      else unregister.push(account);
    }
    if (unregister.length === 0 && manual.length === 0) return;

    for (const account of unregister) {
      const [parent] = await live!.registry.nodeOf(account);
      const below = parent === live!.address ? `its ${await live!.registry.treeSizeOf(account)} contract(s)` : "every contract below it";
      console.log(chalk.yellow(`${account}: unregister it and ${below}`));
    }
    for (const account of manual) console.log(chalk.yellow(`${account}: remove it from the TaskManager list`));
    if (!(await confirm(`Revoke access on ${hre.network.name}?`, taskArguments.yes))) {
      console.log(chalk.yellow("Aborted - nothing was sent."));
      return;
    }

    type Call = { to: string; data: string; what: string };
    const groups: { sender: Sender; calls: Call[]; accounts: string[] }[] = [];
    if (unregister.length > 0) {
      const sender = await resolveSender(
        hre,
        live!.registry,
        [{ role: await live!.registry.REVOKER_ROLE(), name: "REVOKER_ROLE" }],
        `FactoryRegistry ${live!.address}`,
      );
      const calls = unregister.map((a) => ({
        to: live!.address,
        data: live!.registry.interface.encodeFunctionData("unregister", [a]),
        what: `unregister(${a})`,
      }));
      groups.push({ sender, calls, accounts: [...tracked] });
    }
    if (manual.length > 0) {
      const sender = await resolveSender(
        hre,
        tm,
        [{ role: await tm.ACCESS_LIST_MANAGER_ROLE(), name: "ACCESS_LIST_MANAGER_ROLE" }],
        `TaskManager ${tmAddress}`,
      );
      const call = {
        to: tmAddress,
        data: tm.interface.encodeFunctionData("removeFromAccessList", [manual]),
        what: `removeFromAccessList(${manual.length} accounts)`,
      };
      // The same Safe or signer sends both kinds in one batch.
      if (groups[0]?.sender.address === sender.address) {
        groups[0].calls.push(call);
        groups[0].accounts.push(...manual);
      } else {
        groups.push({ sender, calls: [call], accounts: manual });
      }
    }

    // A batch file runs all its calls in one transaction; the other paths send one transaction per call.
    for (const { sender, calls } of groups) {
      const oneTx = sender.kind === "safe" && sender.owner === null;
      let total = 0n;
      for (const c of calls) {
        const gas = await ethers.provider.estimateGas({ from: sender.address, to: c.to, data: c.data });
        total = oneTx ? total + gas : gas;
        if (total > TX_GAS_CAP) {
          throw new Error(`${c.what} brings the transaction to ${total} gas, over the ${TX_GAS_CAP} cap. Revoke fewer accounts per run.`);
        }
      }
    }
    if (taskArguments.out && groups.length > 1) console.log(chalk.yellow("--out is ignored: the calls need two senders."));

    for (const { sender, calls, accounts: groupAccounts } of groups) {
      const batch = { slug: "revoke-access", name: "CoFHE - revoke access", taskName: "task:revokeAccess" };
      if (!(await send(hre, sender, calls, batch, groups.length === 1 ? taskArguments.out : undefined))) continue;
      for (const account of groupAccounts) {
        if (await tm.accessList(account)) throw new Error(`The transaction executed but ${account} is still on the TaskManager list.`);
        if (live && (await inTree(account))) throw new Error(`The transaction executed but ${account} is still registered.`);
        console.log(chalk.green(`${account}: access revoked`));
      }
    }
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
