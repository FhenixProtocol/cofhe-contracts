import chalk from "chalk";
import { task, types } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";
import { Contract, Wallet } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { getDefaultAdmin, resolveAdminDelay } from "../utils/roles";
import { resolveTaskManager } from "../utils/addressBook";
import { execTransactionThroughSafe, writeSafeBatch } from "../utils/safe";

/**
 * A TaskManager satellite proxy: resolved through the registered TaskManager rather than passed in,
 * so the task can only ever upgrade the proxy the live TaskManager actually drives.
 */
type Satellite = {
  /** Contract name as `ethers.getContractFactory` knows it. */
  name: "ACL" | "PlaintextsStorage";
  /** The TaskManager getter returning this proxy's address. */
  getter: "acl" | "plaintextsStorage";
};

async function getImplementationAddress(ethers: any, proxy: any) {
  const IMPLEMENTATION_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implementationAddress = await ethers.provider.getStorage(
    proxy,
    IMPLEMENTATION_SLOT,
  );

  // Convert the storage value to address format
  return ethers.getAddress(
    "0x" + implementationAddress.slice(-40),
  );
}

/**
 * Validates the storage layout of the pending upgrade, and throws if it is incompatible.
 */
async function validateUpgrade(ethers: any, upgrades: any, ProxyContract: any, Factory: any) {
  const proxyAddress = await ProxyContract.getAddress();
  try {
    console.log("Importing implementation contract...");
    await upgrades.forceImport(proxyAddress, Factory, { kind: "uups" });

    console.log("Validating storage layout...");
    await upgrades.validateUpgrade(proxyAddress, Factory, { kind: "uups" });
    console.log(chalk.green("✅ Storage layout is compatible with the previous implementation"));
  } catch (error: any) {
    console.log(chalk.red("❌ Storage layout validation failed:"));
    // Rethrow: `return` here only exits this function, and the caller would go on to upgrade
    // anyway right after printing "Upgrade aborted".
    throw error;
  }
}

async function upgradeSatellite(
  hre: any,
  satellite: Satellite,
  ProxyContract: any,
  Factory: any,
  taskManagerAddress: string,
  adminSigner: any,
) {
    const { ethers } = hre;
    const connectedImplementation = ProxyContract.connect(adminSigner);
    const currentDefaultAdmin = await getDefaultAdmin(ProxyContract, ethers.ZeroAddress);
    console.log(chalk.green(`${satellite.name} default admin:`, currentDefaultAdmin ?? "none (pre-roles implementation)"));
    const oldImplementationAddress = await getImplementationAddress(ethers, connectedImplementation);
    console.log(chalk.green("Old implementation address:", oldImplementationAddress));

    // `_authorizeUpgrade` needs only UPGRADER_ROLE, but `setTaskManager` needs DEFAULT_ADMIN_ROLE.
    // Running it inside `upgradeToAndCall` keeps the whole thing atomic, so a signer without
    // DEFAULT_ADMIN_ROLE would only burn gas on a revert. After the handover that admin is the
    // Safe, which then sends the upgrade itself.
    if (
      currentDefaultAdmin !== null &&
      currentDefaultAdmin.toLowerCase() !== adminSigner.address.toLowerCase()
    ) {
      const safeAddress = await requireSafeCanUpgrade(ethers, satellite, ProxyContract, currentDefaultAdmin, adminSigner);
      await upgradeAsSafe(hre, satellite, ProxyContract, Factory, taskManagerAddress, safeAddress, oldImplementationAddress);
      return;
    }

    const newIplAddress = await deployImplementation(Factory);

    // A proxy upgraded to this implementation has no TaskManager recorded and rejects every
    // TaskManager call until setTaskManager runs. Run it in the upgrade transaction, so the proxy
    // is never observable without one.
    if (currentDefaultAdmin === null) {
        // A proxy still on the pre-roles (Ownable) implementation has no AccessControl storage, so
        // setTaskManager (DEFAULT_ADMIN_ROLE) cannot run yet. upgradeToAndCall carries one call:
        // seed the roles via initializeV2 there, then set the TaskManager right after.
        const migrationData = Factory.interface.encodeFunctionData("initializeV2", [
          adminSigner.address,
          resolveAdminDelay(hre),
        ]);
        const tx = await connectedImplementation.upgradeToAndCall(newIplAddress, migrationData);
        await tx.wait();
        console.log(chalk.green(`Successfully upgraded ${satellite.name} contract (initializeV2)`));
        const setTx = await connectedImplementation.setTaskManager(taskManagerAddress);
        await setTx.wait();
    } else {
        const setTaskManagerData = Factory.interface.encodeFunctionData("setTaskManager", [taskManagerAddress]);
        const tx = await connectedImplementation.upgradeToAndCall(newIplAddress, setTaskManagerData);
        await tx.wait();
        console.log(chalk.green(`Successfully upgraded ${satellite.name} contract (setTaskManager in the same transaction)`));
    }

    await reportUpgrade(ethers, satellite, ProxyContract, taskManagerAddress, oldImplementationAddress);
}

/** Deploys the new implementation. Any funded key may do this; only the upgrade itself needs a role. */
async function deployImplementation(Factory: any): Promise<string> {
    const newIplDeployment = await Factory.deploy();
    await newIplDeployment.waitForDeployment();
    const newIplAddress = await newIplDeployment.getAddress();
    console.log(chalk.green("Before upgrade, new implementation address:", newIplAddress));
    return newIplAddress;
}

async function reportUpgrade(
    ethers: any,
    satellite: Satellite,
    ProxyContract: any,
    taskManagerAddress: string,
    oldImplementationAddress: string,
) {
    const recordedTaskManager: string = await ProxyContract.getTaskManagerAddress();
    console.log(chalk.green("TaskManager recorded on the proxy:", recordedTaskManager));
    if (recordedTaskManager.toLowerCase() !== taskManagerAddress.toLowerCase()) {
        throw new Error(
          `${satellite.name} records TaskManager ${recordedTaskManager}, expected ${taskManagerAddress}.`,
        );
    }

    const newImplementationAddress = await getImplementationAddress(ethers, ProxyContract);
    console.log(chalk.green("New implementation address:", newImplementationAddress));
    if (oldImplementationAddress === newImplementationAddress) {
        console.log(chalk.red("WARNING: Implementation address did not change!"));
    } else {
        console.log(chalk.green("Implementation address changed successfully!"));
    }
    console.log("\n");
}

/**
 * Returns SAFE_ADMIN_ADDRESS when it can run the upgrade: it must be the default admin (for
 * `setTaskManager`) and hold UPGRADER_ROLE (for `_authorizeUpgrade`). Throws otherwise.
 */
async function requireSafeCanUpgrade(
    ethers: any,
    satellite: Satellite,
    ProxyContract: any,
    currentDefaultAdmin: string,
    signer: any,
): Promise<string> {
    const rawSafeAddress = process.env.SAFE_ADMIN_ADDRESS?.trim();
    if (!rawSafeAddress || ethers.getAddress(rawSafeAddress) !== ethers.getAddress(currentDefaultAdmin)) {
        throw new Error(
          `Refusing to upgrade ${satellite.name}: default admin is ${currentDefaultAdmin}, but the ` +
            `signer is ${signer.address} and SAFE_ADMIN_ADDRESS is ${rawSafeAddress || "unset"}. ` +
            `setTaskManager runs in the upgrade transaction and needs DEFAULT_ADMIN_ROLE. Run this ` +
            `from the default admin, or set SAFE_ADMIN_ADDRESS to it.`,
        );
    }
    const safeAddress = ethers.getAddress(rawSafeAddress);
    if (!(await ProxyContract.hasRole(await ProxyContract.UPGRADER_ROLE(), safeAddress))) {
        throw new Error(`Refusing to upgrade ${satellite.name}: ${safeAddress} does not hold UPGRADER_ROLE.`);
    }
    return safeAddress;
}

/**
 * Upgrades as the Safe - the post-handover flow, mirroring task:upgradeTM: with SAFE_OWNER_KEY
 * the upgrade is executed through the Safe (threshold-1 Safes only), otherwise a Transaction
 * Builder batch is written to import in the Safe app. Either way it is the same single
 * `upgradeToAndCall(impl, setTaskManager(tm))`, so the proxy is never left without a TaskManager.
 */
async function upgradeAsSafe(
    hre: any,
    satellite: Satellite,
    ProxyContract: any,
    Factory: any,
    taskManagerAddress: string,
    safeAddress: string,
    oldImplementationAddress: string,
) {
    const { ethers } = hre;
    const proxyAddress: string = await ProxyContract.getAddress();
    const newIplAddress = await deployImplementation(Factory);
    const setTaskManagerData = Factory.interface.encodeFunctionData("setTaskManager", [taskManagerAddress]);
    const data = ProxyContract.interface.encodeFunctionData("upgradeToAndCall", [newIplAddress, setTaskManagerData]);

    const ownerKey = process.env.SAFE_OWNER_KEY?.trim();
    if (ownerKey) {
        const ownerSigner = new Wallet(ownerKey, ethers.provider);
        // An EOA final admin (testnets) upgrades directly: SAFE_OWNER_KEY is then its own key.
        const sendsDirectly = ownerSigner.address.toLowerCase() === safeAddress.toLowerCase();
        console.log(chalk.green(`Upgrading ${satellite.name} as ${safeAddress}, sending as ${ownerSigner.address}`));
        if (sendsDirectly) {
            await (await ownerSigner.sendTransaction({ to: proxyAddress, data })).wait();
        } else {
            await execTransactionThroughSafe(hre, safeAddress, ownerSigner, proxyAddress, data);
        }
        console.log(chalk.green(`Successfully upgraded ${satellite.name} contract (setTaskManager in the same transaction)`));
        await reportUpgrade(ethers, satellite, ProxyContract, taskManagerAddress, oldImplementationAddress);
        return;
    }

    const slug = satellite.name === "ACL" ? "upgrade-acl" : "upgrade-plaintexts-storage";
    const path = writeSafeBatch(hre, {
        safeAddress,
        slug,
        name: `CoFHE - upgrade ${satellite.name}`,
        description:
            `Upgrade the ${satellite.name} proxy ${proxyAddress} to implementation ${newIplAddress} and ` +
            `set its TaskManager to ${taskManagerAddress} in the same call. Generated by task:upgrade${satellite.name}.`,
        transactions: [{ to: proxyAddress, data }],
    });
    console.log(chalk.bold.blue("\nWrote a Safe Transaction Builder batch:"));
    console.log(`  ${path}`);
    console.log(
        chalk.dim("Import it under Apps -> Transaction Builder in the Safe app, review, sign, execute."),
    );
    console.log(chalk.bold.blue("\nThe transaction it contains:"));
    console.log(`  upgradeToAndCall(${newIplAddress}, setTaskManager(${taskManagerAddress})):`);
    console.log(`    to:    ${proxyAddress}`);
    console.log(`    value: 0`);
    console.log(`    data:  ${data}`);
    console.log(
        chalk.yellow(
          `\nAfter execution, check getTaskManagerAddress() == ${taskManagerAddress} and the ` +
            `implementation slot on ${proxyAddress}.`,
        ),
    );
}

function registerUpgradeTask(taskName: string, satellite: Satellite) {
  task(taskName, `Upgrade the registered TaskManager's ${satellite.name}, setting the TaskManager in the same transaction`)
    .addParam("key", "Signer key", "")
    .addParam("onlyvalidate", "Only validate the upgrade", false, types.boolean)
    .setAction(async function (taskArguments: TaskArguments, hre) {
      const { fhenixjs, ethers, upgrades } = hre;
      const key = taskArguments.key;
      let signer : HardhatEthersSigner;
      if (key === "") {
          signer = (await ethers.getSigners())[2];
      } else {
          // Create a wallet from private key and connect it to the provider
          const wallet = new Wallet(key);
          // Connect the wallet to the provider
          signer = wallet.connect(ethers.provider) as unknown as HardhatEthersSigner;
      }

      if (hre.network.name.includes("localfhenix")) {
          if ((await ethers.provider.getBalance(signer.address)).toString() === "0") {
              console.log(chalk.green("Funding account:", signer.address));
              await fhenixjs.getFunds(signer.address);
          }
      }

      console.log(chalk.green("Network:", hre.network.name, signer.address));
      console.log(chalk.green(`Balance of account: ${signer.address}`, await ethers.provider.getBalance(signer.address)));

      const taskManagerAddress: string = await resolveTaskManager(hre);
      const taskManager: any = await ethers.getContractAt("TaskManager", taskManagerAddress);
      const proxyAddress: string = await taskManager[satellite.getter]();
      if (proxyAddress === ethers.ZeroAddress) {
          throw new Error(`TaskManager ${taskManagerAddress} has no ${satellite.name} set (${satellite.getter}() is zero).`);
      }

      const Factory = await ethers.getContractFactory(satellite.name);
      const ProxyContract = Factory.attach(proxyAddress) as Contract;
      console.log(chalk.green("TaskManager:", taskManagerAddress));
      console.log(chalk.green(`${satellite.name} proxy:`, await ProxyContract.getAddress()));

      await validateUpgrade(ethers, upgrades, ProxyContract, Factory);

      if (!taskArguments.onlyvalidate) {
          await upgradeSatellite(hre, satellite, ProxyContract, Factory, taskManagerAddress, signer);
      }
    });
}

registerUpgradeTask("task:upgradeACL", { name: "ACL", getter: "acl" });
registerUpgradeTask("task:upgradePlaintextsStorage", { name: "PlaintextsStorage", getter: "plaintextsStorage" });
