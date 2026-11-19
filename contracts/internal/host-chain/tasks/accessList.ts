import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { task } from "hardhat/config";
import chalk from "chalk";
import { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";

import { execTransactionThroughSafe, writeSafeBatch } from "../utils/safe";
import { resolveTaskManager } from "../utils/addressBook";

const dotenvConfigPath: string = process.env.DOTENV_CONFIG_PATH || "../.env";
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

/**
 * The Ledger account at LEDGER_ADDRESS as a signer. Refuses when the network is not set up for it
 * or the account lacks the role, so the device is never asked to sign a call that would revert.
 */
async function resolveLedgerSigner(hre: HardhatRuntimeEnvironment, tm: any, role: string) {
  const { ethers } = hre;
  const address = ethers.getAddress(requireEnv("LEDGER_ADDRESS"));
  const configured: string[] = (hre.network.config as any).ledgerAccounts ?? [];
  if (!configured.some((account) => account.toLowerCase() === address.toLowerCase())) {
    throw new Error(`Network ${hre.network.name} has no Ledger account ${address} - it is not set up in hardhat.config.ts.`);
  }
  if (!(await tm.hasRole(role, address))) {
    throw new Error(
      `The Ledger account (${address}) does not hold ACCESS_LIST_MANAGER_ROLE on the TaskManager. ` +
        `Grant it first with task:grantRole or task:grantRoleAsSafe.`,
    );
  }
  return ethers.getSigner(address);
}

/**
 * Adds contracts to the TaskManager's access list, the callers allowed to create tasks while it
 * is enabled.
 *
 * Sent directly when the signer holds ACCESS_LIST_MANAGER_ROLE (before the handover). Otherwise
 * the Safe at SAFE_ADMIN_ADDRESS has to: with `SAFE_OWNER_KEY` the call is executed through it
 * (an EOA final admin sends directly), otherwise one Safe Transaction Builder batch is written.
 * Accounts already listed are skipped, so a re-run after execution verifies.
 *
 * With `withLedger` the Ledger account at LEDGER_ADDRESS sends the call and confirms it on the
 * device; it must hold ACCESS_LIST_MANAGER_ROLE itself, and the Safe is never used.
 */
async function addToAccessList(hre: HardhatRuntimeEnvironment, taskArguments: TaskArguments, withLedger: boolean) {
  const { ethers } = hre;
  const accounts: string[] = [];
  for (const raw of String(taskArguments.accounts).split(",")) {
    if (!raw.trim()) {
      continue;
    }
    const account = ethers.getAddress(raw.trim());
    if (account === ethers.ZeroAddress) {
      throw new Error("refusing to add address(0) to the access list.");
    }
    if (!accounts.includes(account)) {
      accounts.push(account);
    }
  }
  if (accounts.length === 0) {
    throw new Error("--accounts is empty.");
  }

  const tmAddress = await resolveTaskManager(hre);
  const tm: any = await ethers.getContractAt("TaskManager", tmAddress);
  console.log(chalk.dim(`TaskManager: ${tmAddress} on ${hre.network.name}`));
  if (!(await tm.accessListEnabled())) {
    console.log(chalk.yellow("The access list is disabled - the accounts take effect once it is enabled."));
  }

  const pending: string[] = [];
  for (const account of accounts) {
    if (await tm.accessList(account)) {
      console.log(chalk.green(`${account}: already on the access list - nothing to do`));
      continue;
    }
    if ((await ethers.provider.getCode(account)) === "0x") {
      console.log(chalk.yellow(`${account}: no code on ${hre.network.name} - check it is the right contract`));
    }
    pending.push(account);
  }
  if (pending.length === 0) {
    console.log(chalk.green("Nothing to do - every account is already on the access list."));
    return;
  }

  const data = tm.interface.encodeFunctionData("addToAccessList", [pending]);
  const role = await tm.ACCESS_LIST_MANAGER_ROLE();
  const signer = withLedger ? await resolveLedgerSigner(hre, tm, role) : (await ethers.getSigners())[0];

  if (withLedger) {
    console.log(chalk.bold.blue(`Confirm addToAccessList on the Ledger (${signer.address})`));
    await (await tm.connect(signer).addToAccessList(pending)).wait();
  } else if (signer && (await tm.hasRole(role, signer.address))) {
    await (await tm.connect(signer).addToAccessList(pending)).wait();
  } else {
    const safeAddress = ethers.getAddress(requireEnv("SAFE_ADMIN_ADDRESS"));
    if (!(await tm.hasRole(role, safeAddress))) {
      throw new Error(
        `Neither the signer (${signer?.address ?? "none"}) nor SAFE_ADMIN_ADDRESS (${safeAddress}) holds ` +
          `ACCESS_LIST_MANAGER_ROLE on TaskManager ${tmAddress}. Run from the account that does.`,
      );
    }
    const ownerKey = process.env.SAFE_OWNER_KEY?.trim();
    if (!ownerKey) {
      const path = writeSafeBatch(hre, {
        safeAddress,
        slug: "add-to-access-list",
        name: "CoFHE - add to TaskManager access list",
        description:
          `Add ${pending.join(", ")} to the access list of TaskManager ${tmAddress}. ` +
          `Generated by task:addToAccessList.`,
        transactions: [{ to: tmAddress, data }],
        outPath: taskArguments.out,
      });
      console.log(chalk.bold.blue("\nSAFE_OWNER_KEY not set - wrote a Safe Transaction Builder batch:"));
      console.log(`  ${path}`);
      console.log(chalk.dim(`  includes: addToAccessList([${pending.join(", ")}])`));
      console.log(
        chalk.yellow(
          "Import it in the Safe app under Apps -> Transaction Builder, review the call, then " +
            "sign and execute. Re-run this task afterwards to verify.",
        ),
      );
      return;
    }
    const ownerSigner = new ethers.Wallet(ownerKey, ethers.provider);
    console.log(chalk.green(`Adding as Safe ${safeAddress}, sending as owner ${ownerSigner.address}`));
    if (ownerSigner.address.toLowerCase() === safeAddress.toLowerCase()) {
      await (await ownerSigner.sendTransaction({ to: tmAddress, data })).wait();
    } else {
      await execTransactionThroughSafe(hre, safeAddress, ownerSigner, tmAddress, data);
    }
  }

  for (const account of pending) {
    if (!(await tm.accessList(account))) {
      throw new Error(`${account}: the transaction executed but accessList(${account}) is still false.`);
    }
    console.log(chalk.green(`${account}: added to the access list`));
  }
}

task("task:addToAccessList", "Add one or more contracts to the TaskManager's access list")
  .addParam("accounts", "Comma-separated addresses to allow")
  .addOptionalParam("out", "Path for the Safe batch file, when one is written")
  .setAction(async function (taskArguments, hre) {
    await addToAccessList(hre, taskArguments, false);
  });

task("task:addToAccessListWithLedger", "Add contracts to the TaskManager's access list, signing with a Ledger")
  .addParam("accounts", "Comma-separated addresses to allow")
  .setAction(async function (taskArguments, hre) {
    await addToAccessList(hre, taskArguments, true);
  });
