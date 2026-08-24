import chalk from "chalk";
import { task, types } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";
import { Contract, Wallet } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  getDefaultAdmin,
  grantAllRoles,
  requireDefaultAdminIsSignerOrUnset,
  resolveAdminDelay,
} from "../utils/roles";

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
 * Identifies the implementation currently behind the proxy.
 *
 * `defaultAdmin() == null` is NOT a proxy for "this is the deterministic stub" - the pre-roles
 * Ownable TaskManager, which is what is actually deployed on staging/testnet, has no
 * `defaultAdmin()` selector either and so also reads as null. The two have different layouts
 * (`DeterministicTM` packs `aggregator` into slot 0 and has no `randomCounter`), so guessing wrong
 * makes `validateUpgrade` reject the one migration that is genuinely safe.
 *
 * Probe instead: `aggregator()` is a public getter only `DeterministicTM` declares.
 */
async function detectCurrentImplementation(ethers: any, proxyAddress: string) {
  const stub = (await ethers.getContractFactory("DeterministicTM")).attach(proxyAddress);
  try {
    await stub.aggregator();
    return "DeterministicTM" as const;
  } catch {
    return "TaskManager" as const;
  }
}

/**
 * Validates the storage layout of the pending upgrade, and throws if it is incompatible.
 *
 * Skipped for the deterministic bootstrap: DeterministicTM -> TaskManager is knowingly
 * layout-incompatible (TaskManager inserts `randomCounter` at slot 1 and moves the aggregator
 * address to slot 2), so the reinterpreted slots are deliberate, not an accident. `initializeV2`
 * reseeds the ones that matter to fail-closed values. Validation stays strict on every other path,
 * which is where an accidental layout break would actually show up.
 */
async function validateUpgrade(ethers: any, upgrades: any, TMProxyContract: any, TMFactory: any) {
  const proxyAddress = await TMProxyContract.getAddress();
  const current = await detectCurrentImplementation(ethers, proxyAddress);
  console.log(chalk.dim(`Current implementation detected as ${current}`));

  if (current === "DeterministicTM") {
    console.log(
      chalk.yellow(
        "⚠ Skipping storage-layout validation: the deterministic bootstrap stub is intentionally " +
          "layout-incompatible with TaskManager. initializeV2 reseeds the reinterpreted slots.",
      ),
    );
    return;
  }

  try {
    console.log("Importing implementation contract...");
    await upgrades.forceImport(proxyAddress, await ethers.getContractFactory(current), {
      kind: "uups",
    });

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

async function upgradeTM(ethers: any, TMProxyContract: any, TMFactory: any, adminSigner: any, adminDelay: number) {
    const connectedImplementation = TMProxyContract.connect(adminSigner);
    const currentDefaultAdmin = await getDefaultAdmin(TMProxyContract, ethers.ZeroAddress);
    console.log(chalk.green("TMProxyContract default admin:", currentDefaultAdmin ?? "none (pre-roles implementation)"));
    const oldImplementationAddress = await getImplementationAddress(ethers, connectedImplementation);
    console.log(chalk.green("Old implementation address:", oldImplementationAddress));

    // `_authorizeUpgrade` needs only UPGRADER_ROLE, but `grantAllRoles` below needs
    // DEFAULT_ADMIN_ROLE. Once the admin moves to a Safe and this key holds only UPGRADER_ROLE,
    // the upgrade would land and the grants would then revert, leaving the proxy on the new
    // implementation with no operational roles and no version bump. Refuse up front instead.
    requireDefaultAdminIsSignerOrUnset(currentDefaultAdmin, adminSigner);

    const newIplDeployment = await TMFactory.deploy();
    await newIplDeployment.waitForDeployment();
    const newIplAddress = await newIplDeployment.getAddress();
    console.log(chalk.green("Before upgrade, new implementation address:", newIplAddress));

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
    const newImplementationAddress = await getImplementationAddress(ethers, connectedImplementation);
    console.log(chalk.green("New implementation address:", newImplementationAddress));
    if (oldImplementationAddress === newImplementationAddress) {
        console.log(chalk.red("WARNING: Implementation address did not change!"));
    } else {
        console.log(chalk.green("Implementation address changed successfully!"));
    }
    console.log("\n");
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
    const TMProxyContract = TMFactory.attach("0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9") as Contract;
    console.log(chalk.green("TMProxyContract:", await TMProxyContract.getAddress()));
    

    await validateUpgrade(ethers, upgrades, TMProxyContract, TMFactory);

    if (!taskArguments.onlyvalidate) {
        await upgradeTM(ethers, TMProxyContract, TMFactory, signer, resolveAdminDelay(hre));
    }
  });
