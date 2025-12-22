import chalk from "chalk";
import { task, types } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";
import { Contract, Wallet } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

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

async function validateUpgrade(upgrades: any, TMProxyContract: any, TMFactory: any) {
  try {
    console.log("Importing implementation contract...");
    // First, force import the implementation to register it with OpenZeppelin plugin
    await upgrades.forceImport(
        await TMProxyContract.getAddress(),
        TMFactory,
        { kind: 'uups' }
    );

    console.log("Validating storage layout...");
    // Now validate the upgrade
    await upgrades.validateUpgrade(
        await TMProxyContract.getAddress(), 
        TMFactory, 
        { kind: 'uups' }
    );
    console.log(chalk.green("✅ Storage layout is compatible with the previous implementation"));
  } catch (error: any) {
    console.log(chalk.red("❌ Storage layout validation failed:"));
    console.error(chalk.red(error.stack || error.message || error));
    console.log(chalk.yellow("Upgrade aborted"));
    return;
  }
}

async function upgradeTM(ethers: any, upgrades: any, TMProxyContract: any, TMFactory: any, adminSigner: any) {
    const connectedImplementation = TMProxyContract.connect(adminSigner);
    console.log(chalk.green("TMProxyContract owner:", await TMProxyContract.owner()));
    const oldImplementationAddress = await getImplementationAddress(ethers, connectedImplementation);
    console.log(chalk.green("Old implementation address:", oldImplementationAddress));

    const newIplDeployment = await TMFactory.deploy();
    const newIplAddress = await newIplDeployment.getAddress();
    console.log(chalk.green("Before upgrade, new implementation address:", newIplAddress));
    const tx = await connectedImplementation.upgradeToAndCall(newIplAddress, "0x");
    await tx.wait();
    console.log(chalk.green("Successfully upgraded TaskManager contract"));
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
    

    await validateUpgrade(upgrades, TMProxyContract, TMFactory);

    if (!taskArguments.onlyvalidate) {
        await upgradeTM(ethers, upgrades, TMProxyContract, TMFactory, signer);
    }
  });
