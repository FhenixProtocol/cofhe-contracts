import chalk from "chalk";
import { task, types } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";
import { Contract, Wallet } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { getDefaultAdmin, resolveAdminDelay } from "../utils/roles";
import { resolveTaskManager } from "../utils/addressBook";

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
    // DEFAULT_ADMIN_ROLE would only burn gas on a revert. Refuse up front with a clear message.
    if (
      currentDefaultAdmin !== null &&
      currentDefaultAdmin.toLowerCase() !== adminSigner.address.toLowerCase()
    ) {
      throw new Error(
        `Refusing to upgrade ${satellite.name}: default admin is ${currentDefaultAdmin}, but the ` +
          `signer is ${adminSigner.address}. setTaskManager runs in the upgrade transaction and ` +
          `needs DEFAULT_ADMIN_ROLE, so the transaction would revert. Run this from the default admin.`,
      );
    }

    const newIplDeployment = await Factory.deploy();
    await newIplDeployment.waitForDeployment();
    const newIplAddress = await newIplDeployment.getAddress();
    console.log(chalk.green("Before upgrade, new implementation address:", newIplAddress));

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

    const recordedTaskManager: string = await connectedImplementation.getTaskManagerAddress();
    console.log(chalk.green("TaskManager recorded on the proxy:", recordedTaskManager));
    if (recordedTaskManager.toLowerCase() !== taskManagerAddress.toLowerCase()) {
        throw new Error(
          `${satellite.name} records TaskManager ${recordedTaskManager}, expected ${taskManagerAddress}.`,
        );
    }

    const newImplementationAddress = await getImplementationAddress(ethers, connectedImplementation);
    console.log(chalk.green("New implementation address:", newImplementationAddress));
    if (oldImplementationAddress === newImplementationAddress) {
        console.log(chalk.red("WARNING: Implementation address did not change!"));
    } else {
        console.log(chalk.green("Implementation address changed successfully!"));
    }
    console.log("\n");
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
