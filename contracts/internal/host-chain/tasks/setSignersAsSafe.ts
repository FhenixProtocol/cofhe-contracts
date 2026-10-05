import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { task } from "hardhat/config";
import chalk from "chalk";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { execTransactionThroughSafe, writeSafeBatch } from "../utils/safe";
import { addressBookAddress, taskManagerId } from "../utils/addressBook";

const dotenvConfigPath: string = process.env.DOTENV_CONFIG_PATH || "../.env";
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

interface SignerSetting {
  label: string;
  getter: "verifierSigner" | "decryptResultSigner";
  setter: "setVerifierSigner" | "setDecryptResultSigner";
  role: "VERIFIER_SIGNER_MANAGER_ROLE" | "DECRYPT_SIGNER_MANAGER_ROLE";
  slug: string;
}

const VERIFIER_SIGNER: SignerSetting = {
  label: "verifier signer",
  getter: "verifierSigner",
  setter: "setVerifierSigner",
  role: "VERIFIER_SIGNER_MANAGER_ROLE",
  slug: "set-verifier-signer",
};

const DECRYPT_RESULT_SIGNER: SignerSetting = {
  label: "decrypt-result signer",
  getter: "decryptResultSigner",
  setter: "setDecryptResultSigner",
  role: "DECRYPT_SIGNER_MANAGER_ROLE",
  slug: "set-decrypt-result-signer",
};

interface SignerChange {
  setting: SignerSetting;
  address: string;
}

/**
 * Sets the TaskManager's signers as the Safe, once the handover has moved the signer-manager
 * roles there.
 *
 * Same two paths as `task:acceptAdminAsSafe`: with `SAFE_OWNER_KEY` the calls are executed
 * through the Safe (threshold-1 Safes; an EOA final admin sends directly), otherwise one Safe
 * Transaction Builder batch is written for the Safe app. Re-run after execution to verify: a
 * signer that already matches is reported as done and skipped.
 */
async function setSignersAsSafe(hre: HardhatRuntimeEnvironment, changes: SignerChange[]) {
  const { ethers } = hre;
  const safeAddress = ethers.getAddress(requireEnv("SAFE_ADMIN_ADDRESS"));
  const ownerKey = process.env.SAFE_OWNER_KEY?.trim();
  const ownerSigner = ownerKey ? new ethers.Wallet(ownerKey, ethers.provider) : null;
  const actsDirectly = ownerSigner !== null && ownerSigner.address.toLowerCase() === safeAddress.toLowerCase();

  const book: any = await ethers.getContractAt("CoFHEAddressBook", addressBookAddress());
  const tmAddress: string = await book.getTm(taskManagerId());
  const tm: any = await ethers.getContractAt("TaskManager", tmAddress);
  console.log(chalk.green(`TaskManager ${tmAddress} (id ${taskManagerId()} in the address book)`));

  const pending: { setting: SignerSetting; target: string; current: string; data: string }[] = [];
  for (const { setting, address } of changes) {
    const target = ethers.getAddress(address);
    // address(0) is debug mode: the TaskManager skips signature verification entirely.
    if (target === ethers.ZeroAddress) {
      throw new Error(`refusing to set the ${setting.label} to address(0) - that disables verification.`);
    }
    if (target.toLowerCase() === safeAddress.toLowerCase()) {
      throw new Error(`refusing to set the ${setting.label} to the Safe - it must be the service's signing key, not an admin.`);
    }
    const role = await tm[setting.role]();
    if (!(await tm.hasRole(role, safeAddress))) {
      throw new Error(
        `Safe ${safeAddress} does not hold ${setting.role} on TaskManager ${tmAddress}. ` +
          `Was the handover step of the deployment run?`,
      );
    }
    const current: string = await tm[setting.getter]();
    if (current.toLowerCase() === target.toLowerCase()) {
      console.log(chalk.green(`${setting.label}: already ${current} - nothing to do`));
      continue;
    }
    pending.push({ setting, target, current, data: tm.interface.encodeFunctionData(setting.setter, [target]) });
  }
  if (pending.length === 0) {
    return;
  }

  if (ownerSigner) {
    console.log(chalk.green(`Setting as Safe ${safeAddress}, sending as owner ${ownerSigner.address}`));
    for (const { setting, target, current, data } of pending) {
      if (actsDirectly) {
        await (await ownerSigner.sendTransaction({ to: tmAddress, data })).wait();
      } else {
        await execTransactionThroughSafe(hre, safeAddress, ownerSigner, tmAddress, data);
      }
      const now: string = await tm[setting.getter]();
      if (now.toLowerCase() !== target.toLowerCase()) {
        throw new Error(`${setting.label}: transaction executed but the value is ${now}, expected ${target}`);
      }
      console.log(chalk.green(`${setting.label}: ${current} -> ${now}`));
    }
    return;
  }

  console.log(chalk.green(`SAFE_OWNER_KEY not set - writing a Safe batch file for ${safeAddress}`));
  const labels = pending.map((p) => p.setting.label).join(" and ");
  const path = writeSafeBatch(hre, {
    safeAddress,
    slug: pending.length === 1 ? pending[0].setting.slug : "set-signers",
    name: "CoFHE - set TaskManager signers",
    description: `Set the ${labels} on TaskManager ${tmAddress}. Generated by task:setSignersAsSafe.`,
    transactions: pending.map(({ data }) => ({ to: tmAddress, data })),
  });
  console.log(chalk.bold.blue("\nWrote a Safe Transaction Builder batch:"));
  console.log(`  ${path}`);
  console.log(chalk.dim("Import it under Apps -> Transaction Builder in the Safe app, review, sign, execute."));
  console.log(chalk.bold.blue("\nThe transactions it contains:"));
  for (const { setting, target, current, data } of pending) {
    console.log(`  ${setting.setter}: ${current} -> ${target}`);
    console.log(`    to:    ${tmAddress}`);
    console.log(`    value: 0`);
    console.log(`    data:  ${data}`);
  }
  console.log(chalk.yellow("Re-run this task after execution to verify - a matching signer is reported as done."));
}

task("task:setVerifierSignerAsSafe", "Set the TaskManager's verifier signer through the Safe")
  .addParam("address", "The zk-verifier's signing address")
  .setAction(async function (taskArguments, hre) {
    await setSignersAsSafe(hre, [{ setting: VERIFIER_SIGNER, address: taskArguments.address }]);
  });

task("task:setDecryptResultSignerAsSafe", "Set the TaskManager's decrypt-result signer through the Safe")
  .addParam("address", "The decryptor's (teecryptor) signing address")
  .setAction(async function (taskArguments, hre) {
    await setSignersAsSafe(hre, [{ setting: DECRYPT_RESULT_SIGNER, address: taskArguments.address }]);
  });

task("task:setSignersAsSafe", "Set both TaskManager signers through the Safe, in one batch")
  .addParam("verifier", "The zk-verifier's signing address")
  .addParam("decrypt", "The decryptor's (teecryptor) signing address")
  .setAction(async function (taskArguments, hre) {
    await setSignersAsSafe(hre, [
      { setting: VERIFIER_SIGNER, address: taskArguments.verifier },
      { setting: DECRYPT_RESULT_SIGNER, address: taskArguments.decrypt },
    ]);
  });
