import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { task } from "hardhat/config";
import chalk from "chalk";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { execTransactionThroughSafe, writeSafeBatch } from "../utils/safe";
import { renounceAllRoles } from "../utils/roles";

const dotenvConfigPath: string = process.env.DOTENV_CONFIG_PATH || "../.env";
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) });

// The canonical TaskManager proxy - the root all other host-chain contracts are discovered from.
const TM_PROXY_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

interface ManagedContract {
  name: string;
  contract: any;
  // True for the AccessControlDefaultAdminRules contracts, where DEFAULT_ADMIN moves via the
  // two-step transfer. ACPShareRegistry is plain AccessControl: DEFAULT_ADMIN_ROLE was granted
  // to the Safe directly during the deploy, so there is nothing to accept there.
  twoStep: boolean;
}

/**
 * Resolves every host-chain contract from the fixed TaskManager address: the ACL and
 * PlaintextsStorage from the TaskManager's getters, the ACPShareRegistry from the ACL's.
 * A zero address means that setup step never ran - fail rather than silently skip a contract
 * that was supposed to be handed over.
 */
async function discoverHostChainContracts(hre: HardhatRuntimeEnvironment): Promise<ManagedContract[]> {
  const { ethers } = hre;
  const tm: any = await ethers.getContractAt("TaskManager", TM_PROXY_ADDRESS);
  const aclAddress = await tm.acl();
  const ptStorageAddress = await tm.plaintextsStorage();
  if (aclAddress === ethers.ZeroAddress || ptStorageAddress === ethers.ZeroAddress) {
    throw new Error(
      `TaskManager at ${TM_PROXY_ADDRESS} has acl=${aclAddress}, ` +
        `plaintextsStorage=${ptStorageAddress} - the deployment did not finish its setup.`,
    );
  }
  const acl: any = await ethers.getContractAt("ACL", aclAddress);
  const shareRegistryAddress = await acl.shareRegistry();
  if (shareRegistryAddress === ethers.ZeroAddress) {
    throw new Error(`ACL at ${aclAddress} has no share registry set - the deployment did not finish its setup.`);
  }
  return [
    { name: "TaskManager", contract: tm, twoStep: true },
    { name: "ACL", contract: acl, twoStep: true },
    {
      name: "ACPShareRegistry",
      contract: await ethers.getContractAt("ACPShareRegistry", shareRegistryAddress),
      twoStep: false,
    },
    {
      name: "PlaintextsStorage",
      contract: await ethers.getContractAt("PlaintextsStorage", ptStorageAddress),
      twoStep: true,
    },
  ];
}

task(
  "task:acceptAdminAsSafe",
  "Accept the pending default-admin transfers on every host-chain contract as the Safe",
).setAction(async function (_taskArguments, hre) {
  const { ethers } = hre;
  const safeAddress = ethers.getAddress(requireEnv("SAFE_ADMIN_ADDRESS"));
  // With SAFE_OWNER_KEY the acceptances are executed through the Safe directly (threshold-1
  // Safes only). Without it - a real multisig, or an owner key that never leaves its hardware -
  // the task writes a Transaction Builder batch to import into the Safe app instead, and doubles
  // as the verifier when re-run after it executes.
  const ownerKey = process.env.SAFE_OWNER_KEY?.trim();
  const ownerSigner = ownerKey ? new ethers.Wallet(ownerKey, ethers.provider) : null;
  console.log(
    ownerSigner
      ? chalk.green(`Accepting as Safe ${safeAddress}, sending as owner ${ownerSigner.address}`)
      : chalk.green(`SAFE_OWNER_KEY not set - writing a Safe batch file for ${safeAddress}`),
  );

  const contracts = await discoverHostChainContracts(hre);
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const toPaste: { name: string; address: string; data: string; readyIn: bigint }[] = [];

  for (const { name, contract, twoStep } of contracts) {
    const address = await contract.getAddress();
    if (!twoStep) {
      // Plain AccessControl: DEFAULT_ADMIN_ROLE was granted to the Safe directly at deploy time.
      const defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE();
      if (!(await contract.hasRole(defaultAdminRole, safeAddress))) {
        throw new Error(
          `${name} (${address}): the Safe does not hold DEFAULT_ADMIN_ROLE. ` +
            `Was the handover step of the deployment run?`,
        );
      }
      console.log(chalk.green(`${name} (${address}): Safe already holds DEFAULT_ADMIN_ROLE - nothing to accept`));
      continue;
    }
    const currentAdmin: string = await contract.defaultAdmin();
    if (currentAdmin.toLowerCase() === safeAddress.toLowerCase()) {
      console.log(chalk.green(`${name} (${address}): Safe is already the default admin`));
      continue;
    }
    const [pendingAdmin, schedule] = await contract.pendingDefaultAdmin();
    if (pendingAdmin.toLowerCase() !== safeAddress.toLowerCase()) {
      throw new Error(
        `${name} (${address}): pending default admin is ${pendingAdmin}, not the Safe. ` +
          `Was the handover step of the deployment run?`,
      );
    }
    // OZ accepts only strictly after the schedule timestamp.
    const readyIn = now <= schedule ? schedule - now + 1n : 0n;
    const data = contract.interface.encodeFunctionData("acceptDefaultAdminTransfer");
    if (!ownerSigner) {
      // Collecting signatures can start before the delay passes; only execution must wait.
      toPaste.push({ name, address, data, readyIn });
      continue;
    }
    if (readyIn > 0n) {
      throw new Error(
        `${name} (${address}): the admin delay has not passed - ${readyIn}s to go. ` +
          `Re-run this task afterwards; contracts already accepted are skipped.`,
      );
    }
    await execTransactionThroughSafe(hre, safeAddress, ownerSigner, address, data);
    const newAdmin: string = await contract.defaultAdmin();
    if (newAdmin.toLowerCase() !== safeAddress.toLowerCase()) {
      throw new Error(`${name} (${address}): accept executed but default admin is ${newAdmin}`);
    }
    console.log(chalk.green(`${name} (${address}): default admin is now the Safe`));
  }

  if (toPaste.length > 0) {
    const maxReadyIn = toPaste.reduce((max, t) => (t.readyIn > max ? t.readyIn : max), 0n);
    const path = writeSafeBatch(hre, {
      safeAddress,
      slug: "accept-admin",
      name: "CoFHE - accept default-admin transfers",
      description:
        `Accept the pending DEFAULT_ADMIN transfer on ${toPaste.map((t) => t.name).join(", ")}. ` +
        `Generated by task:acceptAdminAsSafe.`,
      transactions: toPaste.map(({ address, data }) => ({ to: address, data })),
    });
    console.log(chalk.bold.blue("\nWrote a Safe Transaction Builder batch:"));
    console.log(`  ${path}`);
    console.log(
      chalk.dim("Import it under Apps -> Transaction Builder in the Safe app, review, sign, execute."),
    );
    // Printed as well as written: the file is what gets imported, but the calls still have to be
    // reviewed against something, and a batch of identical selectors is easy to mis-read.
    console.log(chalk.bold.blue("\nThe transactions it contains:"));
    for (const { name, address, data } of toPaste) {
      console.log(`  ${name}:`);
      console.log(`    to:    ${address}`);
      console.log(`    value: 0`);
      console.log(`    data:  ${data}`);
    }
    if (maxReadyIn > 0n) {
      console.log(
        chalk.yellow(`\nThe admin delay has not passed yet - execute after ~${maxReadyIn}s (signing can start now).`),
      );
    }
    console.log(chalk.yellow("Re-run this task after execution to verify - accepted contracts are reported as done."));
  }
});

task(
  "task:renounceDeployerRoles",
  "Renounce every role the deployer still holds, once the Safe is the default admin",
).setAction(async function (_taskArguments, hre) {
  const { ethers } = hre;
  const safeAddress = ethers.getAddress(requireEnv("SAFE_ADMIN_ADDRESS"));
  const [signer] = await ethers.getSigners();
  console.log(chalk.green(`Renouncing roles held by ${signer.address}`));

  const contracts = await discoverHostChainContracts(hre);
  for (const { name, contract, twoStep } of contracts) {
    const address = await contract.getAddress();
    const defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE();
    // Renouncing before the Safe holds DEFAULT_ADMIN would leave the contract with an admin
    // that has no operational roles and no one else who does - refuse.
    if (twoStep) {
      const currentAdmin: string = await contract.defaultAdmin();
      if (currentAdmin.toLowerCase() !== safeAddress.toLowerCase()) {
        throw new Error(
          `${name} (${address}): default admin is ${currentAdmin}, not the Safe. Run ` +
            `task:acceptAdminAsSafe first - renouncing now could leave the contract unmanageable.`,
        );
      }
    } else if (!(await contract.hasRole(defaultAdminRole, safeAddress))) {
      throw new Error(
        `${name} (${address}): the Safe does not hold DEFAULT_ADMIN_ROLE - renouncing now ` +
          `could leave the contract unmanageable.`,
      );
    }
    console.log(chalk.blue(`${name} (${address}):`));
    await renounceAllRoles(contract, signer);
    // On the two-step contracts the deployer's DEFAULT_ADMIN_ROLE already moved with the
    // transfer; on plain AccessControl it must be renounced explicitly, after everything else.
    if (!twoStep && (await contract.hasRole(defaultAdminRole, signer.address))) {
      const tx = await contract.connect(signer).renounceRole(defaultAdminRole, signer.address);
      await tx.wait();
      console.log(chalk.yellow(`Renounced DEFAULT_ADMIN_ROLE from ${signer.address}`));
    }
  }
  console.log(chalk.green("Done - the Safe is the default admin and sole role holder."));
});
