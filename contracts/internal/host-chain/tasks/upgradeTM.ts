import chalk from "chalk";
import { task, types } from "hardhat/config";
import type { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";
import { Contract, Wallet } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  getDefaultAdmin,
  grantAllRoles,
  requireDefaultAdminIsSignerOrUnset,
  resolveAdminDelay,
} from "../utils/roles";
import { execTransactionThroughSafe, writeSafeBatch } from "../utils/safe";
import { resolveTaskManager } from "../utils/addressBook";

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
async function validateUpgrade(ethers: any, upgrades: any, TMProxyContract: any, TMFactory: any) {
  const proxyAddress = await TMProxyContract.getAddress();
  try {
    console.log("Importing implementation contract...");
    await upgrades.forceImport(proxyAddress, TMFactory, { kind: "uups" });

    console.log("Validating storage layout...");
    await upgrades.validateUpgrade(proxyAddress, TMFactory, { kind: "uups" });
    console.log(chalk.green("✅ Storage layout is compatible with the previous implementation"));
  } catch (error: any) {
    console.log(chalk.red("❌ Storage layout validation failed:"));
    // Rethrow: `return` here only exits this function, and the caller would go on to upgrade
    // anyway right after printing "Upgrade aborted".
    throw error;
  }
}

/** Deploys the new implementation. Any funded key may do this; only the upgrade itself needs a role. */
async function deployImplementation(TMFactory: any): Promise<string> {
    const newIplDeployment = await TMFactory.deploy();
    await newIplDeployment.waitForDeployment();
    const newIplAddress = await newIplDeployment.getAddress();
    console.log(chalk.green("Before upgrade, new implementation address:", newIplAddress));
    return newIplAddress;
}

async function reportUpgrade(ethers: any, TMProxyContract: any, oldImplementationAddress: string) {
    const newImplementationAddress = await getImplementationAddress(ethers, TMProxyContract);
    console.log(chalk.green("New implementation address:", newImplementationAddress));
    console.log(chalk.green("TaskManager version:", (await TMProxyContract.getVersion()).toString()));
    if (oldImplementationAddress === newImplementationAddress) {
        console.log(chalk.red("WARNING: Implementation address did not change!"));
    } else {
        console.log(chalk.green("Implementation address changed successfully!"));
    }
    console.log("\n");
}

/**
 * Upgrades with the signer's own UPGRADER_ROLE - the pre-handover flow, including the migration
 * of a pre-roles (Ownable) proxy.
 */
async function upgradeAsSigner(
    ethers: any,
    TMProxyContract: any,
    TMFactory: any,
    adminSigner: any,
    adminDelay: number,
    currentDefaultAdmin: string | null,
    oldImplementationAddress: string,
) {
    const connectedImplementation = TMProxyContract.connect(adminSigner);

    // `_authorizeUpgrade` needs only UPGRADER_ROLE, but `grantAllRoles` below needs
    // DEFAULT_ADMIN_ROLE. Once the admin moves to a Safe and this key holds only UPGRADER_ROLE,
    // the upgrade would land and the grants would then revert, leaving the proxy on the new
    // implementation with no operational roles and no version bump. Refuse up front instead.
    requireDefaultAdminIsSignerOrUnset(currentDefaultAdmin, adminSigner);

    const newIplAddress = await deployImplementation(TMFactory);

    // A proxy still on the pre-roles (Ownable) implementation has no AccessControl storage.
    // Seed it via initializeV2 in the same transaction as the upgrade. initializeV2 is gated on
    // the legacy Ownable owner, so a gap is no longer exploitable, but keeping it atomic means
    // the proxy is never observable in a half-migrated state.
    const migrationData =
      currentDefaultAdmin === null
        ? TMFactory.interface.encodeFunctionData("initializeV2", [adminSigner.address, adminDelay])
        : "0x";
    const tx = await connectedImplementation.upgradeToAndCall(newIplAddress, migrationData);
    await tx.wait();
    console.log(chalk.green("Successfully upgraded TaskManager contract"));

    // initialize/initializeV2 only grant DEFAULT_ADMIN_ROLE; incVersion needs UPGRADER_ROLE.
    await grantAllRoles(TMProxyContract, adminSigner);

    const incTx = await connectedImplementation.incVersion();
    await incTx.wait();
    await reportUpgrade(ethers, TMProxyContract, oldImplementationAddress);
}

/**
 * Upgrades as the Safe that holds UPGRADER_ROLE - the post-handover flow. Mirrors
 * task:acceptAdminAsSafe: with SAFE_OWNER_KEY the two calls are executed through the Safe
 * (threshold-1 Safes only), otherwise a single Transaction Builder batch is written to import in
 * the Safe app. No role grants and no migration data: the Safe already holds every role.
 */
async function upgradeAsSafe(
    hre: HardhatRuntimeEnvironment,
    TMProxyContract: any,
    TMFactory: any,
    safeAddress: string,
    oldImplementationAddress: string,
) {
    const { ethers } = hre;
    const proxyAddress: string = await TMProxyContract.getAddress();
    const newIplAddress = await deployImplementation(TMFactory);
    const calls = [
        {
            name: `upgradeToAndCall(${newIplAddress}, 0x)`,
            data: TMProxyContract.interface.encodeFunctionData("upgradeToAndCall", [newIplAddress, "0x"]),
        },
        { name: "incVersion()", data: TMProxyContract.interface.encodeFunctionData("incVersion") },
    ];

    const ownerKey = process.env.SAFE_OWNER_KEY?.trim();
    if (ownerKey) {
        const ownerSigner = new Wallet(ownerKey, ethers.provider);
        // An EOA final admin (testnets) upgrades directly: SAFE_OWNER_KEY is then its own key.
        const sendsDirectly = ownerSigner.address.toLowerCase() === safeAddress.toLowerCase();
        console.log(chalk.green(`Upgrading as ${safeAddress}, sending as ${ownerSigner.address}`));
        for (const { name, data } of calls) {
            if (sendsDirectly) {
                await (await ownerSigner.sendTransaction({ to: proxyAddress, data })).wait();
            } else {
                await execTransactionThroughSafe(hre, safeAddress, ownerSigner, proxyAddress, data);
            }
            console.log(chalk.green(`Executed ${name}`));
        }
        await reportUpgrade(ethers, TMProxyContract, oldImplementationAddress);
        return;
    }

    const path = writeSafeBatch(hre, {
        safeAddress,
        slug: "upgrade-tm",
        name: "CoFHE - upgrade TaskManager",
        description:
            `Upgrade the TaskManager proxy ${proxyAddress} to implementation ${newIplAddress} and bump ` +
            `its version. Generated by task:upgradeTM.`,
        transactions: calls.map(({ data }) => ({ to: proxyAddress, data })),
    });
    console.log(chalk.bold.blue("\nWrote a Safe Transaction Builder batch:"));
    console.log(`  ${path}`);
    console.log(
        chalk.dim("Import it under Apps -> Transaction Builder in the Safe app, review, sign, execute."),
    );
    console.log(chalk.bold.blue("\nThe transactions it contains:"));
    for (const { name, data } of calls) {
        console.log(`  ${name}:`);
        console.log(`    to:    ${proxyAddress}`);
        console.log(`    value: 0`);
        console.log(`    data:  ${data}`);
    }
    console.log(
        chalk.yellow(`\nAfter execution, check getVersion() and the implementation slot on ${proxyAddress}.`),
    );
}

async function upgradeTM(
    hre: HardhatRuntimeEnvironment,
    TMProxyContract: any,
    TMFactory: any,
    signer: any,
    adminDelay: number,
) {
    const { ethers } = hre;
    const currentDefaultAdmin = await getDefaultAdmin(TMProxyContract, ethers.ZeroAddress);
    console.log(chalk.green("TMProxyContract default admin:", currentDefaultAdmin ?? "none (pre-roles implementation)"));
    const oldImplementationAddress = await getImplementationAddress(ethers, TMProxyContract);
    console.log(chalk.green("Old implementation address:", oldImplementationAddress));

    // A pre-roles proxy has no AccessControl to query: its legacy owner upgrades directly and
    // initializeV2 seeds the roles, so it always takes the signer path.
    const upgraderRole = currentDefaultAdmin === null ? null : await TMProxyContract.UPGRADER_ROLE();
    if (upgraderRole === null || (await TMProxyContract.hasRole(upgraderRole, signer.address))) {
        await upgradeAsSigner(
            ethers,
            TMProxyContract,
            TMFactory,
            signer,
            adminDelay,
            currentDefaultAdmin,
            oldImplementationAddress,
        );
        return;
    }

    // Post-handover: the signer only pays for the implementation deploy; the Safe upgrades.
    const rawSafeAddress = process.env.SAFE_ADMIN_ADDRESS?.trim();
    if (!rawSafeAddress) {
        throw new Error(
            `Refusing to upgrade: ${signer.address} does not hold UPGRADER_ROLE on the TaskManager and ` +
                `SAFE_ADMIN_ADDRESS is not set. After the handover, set SAFE_ADMIN_ADDRESS to the Safe ` +
                `that holds UPGRADER_ROLE (and SAFE_OWNER_KEY to execute through it), or run with a key ` +
                `that holds UPGRADER_ROLE.`,
        );
    }
    const safeAddress = ethers.getAddress(rawSafeAddress);
    if (!(await TMProxyContract.hasRole(upgraderRole, safeAddress))) {
        throw new Error(
            `Refusing to upgrade: neither the signer ${signer.address} nor SAFE_ADMIN_ADDRESS ` +
                `${safeAddress} holds UPGRADER_ROLE on the TaskManager.`,
        );
    }
    await upgradeAsSafe(hre, TMProxyContract, TMFactory, safeAddress, oldImplementationAddress);
}


task("task:upgradeTM")
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

    const TMFactory = await ethers.getContractFactory("TaskManager");
    const TMProxyContract = TMFactory.attach(await resolveTaskManager(hre)) as Contract;
    console.log(chalk.green("TMProxyContract:", await TMProxyContract.getAddress()));
    

    await validateUpgrade(ethers, upgrades, TMProxyContract, TMFactory);

    if (!taskArguments.onlyvalidate) {
        await upgradeTM(hre, TMProxyContract, TMFactory, signer, resolveAdminDelay(hre));
    }
  });
