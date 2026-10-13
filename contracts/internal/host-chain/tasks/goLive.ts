import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { task } from "hardhat/config";
import chalk from "chalk";
import { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";

import { execTransactionThroughSafe, writeSafeBatch } from "../utils/safe";
import { resolveTaskManager } from "../utils/addressBook";
import { confirm } from "../utils/confirm";

const dotenvConfigPath: string = process.env.DOTENV_CONFIG_PATH || "../.env";
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) });

// The fail-closed signer placeholder: verification against it always fails.
const SIGNER_SENTINEL = "0x0000000000000000000000000000000000000001";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function parseAccounts(ethers: any, raw: string): string[] {
  const accounts: string[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
    const account = ethers.getAddress(entry);
    if (account === ethers.ZeroAddress) {
      throw new Error("refusing to access-list address(0).");
    }
    if (!accounts.includes(account)) {
      accounts.push(account);
    }
  }
  return accounts;
}

/**
 * The go-live preconditions from docs/mainnet-deployment.md: production signers, wired satellites
 * and the access list on - with it off, enable() would open intake to every caller.
 */
async function checkReadyForGoLive(ethers: any, tm: any, safeAddress: string) {
  const problems: string[] = [];
  for (const getter of ["verifierSigner", "decryptResultSigner"]) {
    const signer: string = await tm[getter]();
    if (signer === ethers.ZeroAddress || signer === SIGNER_SENTINEL) {
      problems.push(`${getter}() is ${signer}, a placeholder - run task:setSignersAsSafe first`);
    } else if (signer.toLowerCase() === safeAddress.toLowerCase()) {
      problems.push(`${getter}() is the Safe - it must be the service's signing key`);
    }
  }
  const aclAddress: string = await tm.acl();
  if (aclAddress === ethers.ZeroAddress) {
    problems.push("acl() is not set");
  } else {
    const acl: any = await ethers.getContractAt("ACL", aclAddress);
    if ((await acl.shareRegistry()) === ethers.ZeroAddress) {
      problems.push("ACL.shareRegistry() is not set");
    }
  }
  if ((await tm.plaintextsStorage()) === ethers.ZeroAddress) {
    problems.push("plaintextsStorage() is not set");
  }
  if (!(await tm.accessListEnabled())) {
    problems.push("accessListEnabled() is false - enable() would open intake to every caller");
  }
  if (problems.length > 0) {
    throw new Error(`Refusing to go live:\n  - ${problems.join("\n  - ")}`);
  }
}

/**
 * Opens task intake as the Safe: access-lists `accounts`, then calls enable().
 *
 * Same two paths as `task:setSignersAsSafe`: with `SAFE_OWNER_KEY` the calls are executed through
 * the Safe (threshold-1 Safes; an EOA final admin sends directly), otherwise one Safe Transaction
 * Builder batch is written - atomic, so intake never opens without the access list. Re-run after
 * execution to verify: listed accounts and an enabled TaskManager are reported as done.
 */
async function goLiveAsSafe(hre: HardhatRuntimeEnvironment, taskArguments: TaskArguments) {
  const { ethers } = hre;
  const safeAddress = ethers.getAddress(requireEnv("SAFE_ADMIN_ADDRESS"));
  const ownerKey = process.env.SAFE_OWNER_KEY?.trim();
  const ownerSigner = ownerKey ? new ethers.Wallet(ownerKey, ethers.provider) : null;
  const actsDirectly = ownerSigner !== null && ownerSigner.address.toLowerCase() === safeAddress.toLowerCase();

  const tmAddress = await resolveTaskManager(hre);
  const tm: any = await ethers.getContractAt("TaskManager", tmAddress);
  console.log(chalk.green(`TaskManager ${tmAddress} on ${hre.network.name}`));

  await checkReadyForGoLive(ethers, tm, safeAddress);

  const accounts = parseAccounts(ethers, taskArguments.accounts);
  const toList: string[] = [];
  for (const account of accounts) {
    if (await tm.accessList(account)) {
      console.log(chalk.green(`${account}: already on the access list - nothing to do`));
      continue;
    }
    if ((await ethers.provider.getCode(account)) === "0x") {
      console.log(chalk.yellow(`${account} has no code - task callers are normally contracts`));
    }
    toList.push(account);
  }
  const toEnable = !(await tm.isEnabled());
  if (!toEnable) {
    console.log(chalk.green("isEnabled() is already true - nothing to do"));
  } else if (accounts.length === 0) {
    console.log(chalk.yellow("No --accounts given: only callers already on the access list can create tasks."));
  }
  if (toList.length === 0 && !toEnable) {
    return;
  }

  const transactions: { label: string; data: string }[] = [];
  if (toList.length > 0) {
    const role = await tm.ACCESS_LIST_MANAGER_ROLE();
    if (!(await tm.hasRole(role, safeAddress))) {
      throw new Error(`Safe ${safeAddress} does not hold ACCESS_LIST_MANAGER_ROLE on TaskManager ${tmAddress}.`);
    }
    transactions.push({
      label: `addToAccessList(${toList.join(", ")})`,
      data: tm.interface.encodeFunctionData("addToAccessList", [toList]),
    });
  }
  if (toEnable) {
    if (!(await tm.hasRole(await tm.PAUSER_ROLE(), safeAddress))) {
      throw new Error(`Safe ${safeAddress} does not hold PAUSER_ROLE on TaskManager ${tmAddress}.`);
    }
    transactions.push({ label: "enable()", data: tm.interface.encodeFunctionData("enable") });
  }

  if (ownerSigner) {
    const question =
      `Go live on ${hre.network.name}: ${transactions.map((t) => t.label).join(", then ")} ` +
      `on TaskManager ${tmAddress} through Safe ${safeAddress}?`;
    if (!(await confirm(question, taskArguments.yes))) {
      console.log(chalk.yellow("Aborted - nothing was sent."));
      return;
    }
    for (const { label, data } of transactions) {
      if (actsDirectly) {
        await (await ownerSigner.sendTransaction({ to: tmAddress, data })).wait();
      } else {
        await execTransactionThroughSafe(hre, safeAddress, ownerSigner, tmAddress, data);
      }
      console.log(chalk.green(`${label}: executed`));
    }
    for (const account of toList) {
      if (!(await tm.accessList(account))) {
        throw new Error(`addToAccessList executed but accessList(${account}) is false`);
      }
    }
    if (!(await tm.isEnabled())) {
      throw new Error("enable() executed but isEnabled() is false");
    }
    console.log(chalk.green(`Live - intake is open to the ${accounts.length > 0 ? "listed" : "access-listed"} callers.`));
    return;
  }

  const path = writeSafeBatch(hre, {
    safeAddress,
    slug: "go-live",
    name: "CoFHE - go live",
    description:
      `${transactions.map((t) => t.label).join(", then ")} on TaskManager ${tmAddress}. ` +
      `Generated by task:goLiveAsSafe.`,
    transactions: transactions.map(({ data }) => ({ to: tmAddress, data })),
    outPath: taskArguments.out,
  });
  console.log(chalk.bold.blue("\nSAFE_OWNER_KEY not set - wrote a Safe Transaction Builder batch:"));
  console.log(`  ${path}`);
  console.log(chalk.dim("Import it under Apps -> Transaction Builder in the Safe app, review, sign, execute."));
  console.log(chalk.bold.blue("\nThe transactions it contains:"));
  for (const { label, data } of transactions) {
    console.log(`  ${label}`);
    console.log(`    to:    ${tmAddress}`);
    console.log(`    value: 0`);
    console.log(`    data:  ${data}`);
  }
  console.log(chalk.yellow("Re-run this task after execution to verify - a live TaskManager is reported as done."));
}

/**
 * The maintenance wallet's emergency stop: disable() halts task intake and result publishing on
 * the chain until a PAUSER_ROLE holder enables it again (task:goLiveAsSafe re-enables as the Safe).
 *
 * With MAINTENANCE_KEY the call is sent from that key. Without it - the maintenance wallet is a
 * Ledger - the call is printed for the hardware wallet to send; re-run to verify.
 */
async function disableTaskManager(hre: HardhatRuntimeEnvironment, taskArguments: TaskArguments) {
  const { ethers } = hre;
  const tmAddress = await resolveTaskManager(hre);
  const tm: any = await ethers.getContractAt("TaskManager", tmAddress);
  console.log(chalk.green(`TaskManager ${tmAddress} on ${hre.network.name}`));

  if (!(await tm.isEnabled())) {
    console.log(chalk.green("isEnabled() is already false - nothing to do"));
    return;
  }

  const pauserRole = await tm.PAUSER_ROLE();
  const key = process.env.MAINTENANCE_KEY?.trim();
  const signer = key ? new ethers.Wallet(key, ethers.provider) : null;
  const sender = signer ? signer.address : ethers.getAddress(requireEnv("MAINTENANCE_ADDRESS"));
  if (!(await tm.hasRole(pauserRole, sender))) {
    throw new Error(`${sender} does not hold PAUSER_ROLE on TaskManager ${tmAddress}.`);
  }
  const data = tm.interface.encodeFunctionData("disable");

  if (signer) {
    const question = `Disable TaskManager ${tmAddress} on ${hre.network.name} as ${sender}? Task intake stops.`;
    if (!(await confirm(question, taskArguments.yes))) {
      console.log(chalk.yellow("Aborted - nothing was sent."));
      return;
    }
    await (await signer.sendTransaction({ to: tmAddress, data })).wait();
    if (await tm.isEnabled()) {
      throw new Error("disable() executed but isEnabled() is still true");
    }
    console.log(chalk.green(`Disabled - task intake on ${hre.network.name} is closed.`));
    return;
  }

  console.log(chalk.bold.blue(`\nMAINTENANCE_KEY not set - send this from ${sender} (e.g. the Ledger):`));
  console.log(`  disable()`);
  console.log(`    to:    ${tmAddress}`);
  console.log(`    value: 0`);
  console.log(`    data:  ${data}`);
  console.log(chalk.dim("On Etherscan / Arbiscan: the TaskManager -> Write as Proxy -> disable, connected with the Ledger."));
  console.log(chalk.yellow("Re-run this task after it is mined to verify - a disabled TaskManager is reported as done."));
}

task("task:goLiveAsSafe", "Open TaskManager intake through the Safe: access-list callers, then enable()")
  .addOptionalParam("accounts", "Comma-separated contracts allowed to create tasks", "")
  .addOptionalParam("out", "Path for the Safe batch file, when one is written")
  .addFlag("yes", "Skip the confirmation prompt")
  .setAction(async function (taskArguments, hre) {
    await goLiveAsSafe(hre, taskArguments);
  });

task("task:disableTaskManager", "Emergency stop: disable() TaskManager intake as the maintenance wallet")
  .addFlag("yes", "Skip the confirmation prompt")
  .setAction(async function (taskArguments, hre) {
    await disableTaskManager(hre, taskArguments);
  });
