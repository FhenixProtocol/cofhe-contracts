import { DeployFunction } from "hardhat-deploy/types";
import { config as dotenvConfig } from "dotenv";
import { join, resolve } from "path";
import { Contract } from "ethers";
import chalk from "chalk";
import hre, { ethers, upgrades } from "hardhat";
import fs from "fs";

import { deployCreateX } from "../utils/deployCreateX";
import { fundAccount } from "../utils/fund";

// DOTENV_CONFIG_PATH is used to specify the path to the .env file for example in the CI
const dotenvConfigPath: string = process.env.DOTENV_CONFIG_PATH || "../.env";
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) });

/**
 * Deploys a proxy contract for a given contract name
 * @param adminAddress The address of the admin account
 * @param contractName The name of the contract to deploy
 * @returns The proxy contract and its address
 */
async function getProxyContract(adminAddress: string, contractName: string) {
  const TaskManager = await ethers.getContractFactory(contractName);
  const ProxyContract = await upgrades.deployProxy(
    TaskManager,
    [adminAddress],
    { kind: "uups", initializer: "initialize" },
  );
  const deployedImpl = await ProxyContract.waitForDeployment();
  const ProxyAddress = await deployedImpl.getAddress();
  console.log(
    chalk.green(
      "Successfully deployed proxy: ",
      contractName,
      " to:",
      ProxyAddress,
    ),
  );
  return { ProxyContract, ProxyAddress };
}

/**
 * Sets up the TaskManager contract
 * Sets the aggregator address and verifies the contract is initialized
 * @param TMProxyContract The TaskManager proxy contract
 * @param aggregatorSigner The signer with permissions to call TaskManager functions
 */
async function TaskManagerSetup(TMProxyContract: any, aggregatorSigners: any[]) {
  // Get the implementation address using ERC1967 storage slot
  try {
    const currentImplementation = await getImplementationAddress(
      TMProxyContract,
    );
    const isInitialized = await TMProxyContract.isInitialized();
    const owner = await TMProxyContract.owner();
    console.log(
      "Implementation address:",
      currentImplementation,
      "isInitialized:",
      isInitialized,
      "owner:",
      owner,
    );
  } catch (e) {
    console.error(chalk.red(`Failed isInitialized transaction: ${e}`));
    return e;
  }

  // Set the aggregator address
  try {
    const connectedImplementation = TMProxyContract.connect(aggregatorSigners[0]);
    for (const aggregatorSigner of aggregatorSigners) {
      const tx = await connectedImplementation.addAggregator(
        aggregatorSigner.address,
      );

      await tx.wait();

      const enableTx = await connectedImplementation.enable();
      await enableTx.wait();

      console.log(
        chalk.green("Successfully added Aggregator address ", aggregatorSigner.address, " in TaskManager"),
      );
    }
  } catch (e) {
    console.error(chalk.red(`Failed addAggregator transaction: ${e}`));
    return e;
  }

  // Set the security zones
  try {
    const minSZ = 0;
    const maxSZ = 0;
    const connectedImplementation = TMProxyContract.connect(aggregatorSigners[0]);
    const tx = await connectedImplementation.setSecurityZones(minSZ, maxSZ);
    await tx.wait();
    console.log(chalk.green("Successfully set Security Zones in TaskManager"));
  } catch (e) {
    console.error(chalk.red(`Failed setSecurityZones transaction: ${e}`));
    return e;
  }

  try {
    const connectedImplementation = TMProxyContract.connect(aggregatorSigners[0]);
    if (process.env.VERIFIER_ADDRESS === "0x0000000000000000000000000000000000000000") {
      const networkName = hre?.network?.name;
      const networkConfig = hre?.network?.config as any;
      const networkUrl = networkConfig?.url;
      if (
        networkUrl &&
        !networkUrl.includes("localhost") &&
        !networkUrl.includes("127.0.0.1") &&
        !networkName?.startsWith("localfhenix")
      ) {
        console.error(chalk.red("refusing to set VERIFIER_ADDRESS to 0 on a non-local network!"));
        return;
      }
    }

    const tx = await connectedImplementation.setVerifierSigner(
      process.env.VERIFIER_ADDRESS,
    );
    await tx.wait();
    console.log(chalk.green("Successfully set verifier signer address"));
  } catch (e) {
    console.error(chalk.red(`Failed setVerifierSigner transaction: ${e}`));
    return e;
  }
  console.log("\n");
}

/**
 * Sets up the ACL contract in the TaskManager
 * @param TMProxyContract The TaskManager proxy contract
 * @param aggregatorSigner The signer with permissions to call TaskManager functions
 * @param aclContract The ACL contract to set in the TaskManager
 */
async function ACLSetup(
  TMProxyContract: any,
  aggregatorSigner: any,
  aclContract: any,
) {
  try {
    const connectedImplementation = TMProxyContract.connect(aggregatorSigner);
    const address = await aclContract.getAddress();
    const tx = await connectedImplementation.setACLContract(address);
    await tx.wait();
    console.log(
      chalk.green(
        "Successfully set ACL contract address in TaskManager, it is: ",
        address,
      ),
    );
  } catch (e) {
    console.error(chalk.red(`Failed setACL transaction: ${e}`));
    return e;
  }
  console.log("\n");
}

/**
 * Deploys an Example contract
 * @param deploy The deploy function from hardhat-deploy
 * @param deployer The address that will deploy the contract
 * @returns The deployed Example contract
 */
async function ExampleSetup(deploy: any, deployer: string) {
  const exampleContract = await deploy("Example", {
    from: deployer,
    args: [],
    log: true,
  });
  console.log(
    chalk.green(
      "Successfully deployed Example contract: ",
      exampleContract.address,
    ),
  );
  console.log("\n");
}

/**
 * Upgrades a proxy contract to a new implementation
 * Currently not used, but can be used to upgrade the contracts - mainly for testing
 * @param proxy The proxy contract that will be upgraded (must be connected to admin)
 * @param admin The admin account that has upgrade permissions
 * @param newFactory The contract factory for the new implementation (must be connected to admin)
 */
async function upgradeContract(proxy: any, admin: any, newFactory: any) {
  const connectedProxy = proxy.connect(admin);
  const connectedNewFactory = newFactory.connect(admin);
  // Get the implementation address of the old ACL contract
  const oldImplementationAddress = await getImplementationAddress(
    connectedProxy,
  );

  const rec = await upgrades.upgradeProxy(connectedProxy, connectedNewFactory);
  // Get the implementation address of the new ACL contract
  const newImplementationAddress = await getImplementationAddress(rec);

  if (oldImplementationAddress === newImplementationAddress) {
    console.log(chalk.red("WARNING: Implementation address did not change!"));
  } else {
    console.log(chalk.green("Implementation address changed successfully!"));
  }
}

/**
 * Sets up the PlaintextsStorage contract in the TaskManager
 * @param TMProxyContract The TaskManager proxy contract
 * @param ptStorageAdress The address of the PlaintextsStorage contract
 * @param aggregatorSigner The signer with permissions to call TaskManager functions
 */
async function PlaintextsStorageSetup(
  TMProxyContract: any,
  ptStorageAdress: any,
  aggregatorSigner: any,
) {
  const connectedImplementation = TMProxyContract.connect(aggregatorSigner);
  const tx = await connectedImplementation.setPlaintextsStorage(
    ptStorageAdress,
  );
  await tx.wait();
  console.log(
    chalk.green("Successfully set PlaintextsStorage contract in TaskManager"),
  );
  console.log("\n");
}

/**
 * Gets the implementation address of a proxy contract
 * @param proxy The proxy contract to get the implementation address of
 * @returns The implementation address of the proxy contract
 */
async function getImplementationAddress(proxy: any) {
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
 * Upgrades the TaskManager contract
 * @param TMProxyContract The TaskManager proxy contract
 * @param TMFactory The factory for the TaskManager contract
 * @param implementationAddress The address of the implementation contract
 * @param aggregatorSigner The signer with permissions to call TaskManager functions
 */
async function upgradeTM(TMProxyContract: any, TMFactory: any, aggregatorSigner: any) {
  console.log(chalk.bold.blue("-----------------------Upgrading TaskManager--------------------------"));
  console.log(chalk.green("Aggregator signer:", aggregatorSigner.address));
  console.log(chalk.green("owner:", await TMProxyContract.owner()));
  const connectedImplementation = TMProxyContract.connect(aggregatorSigner);
  const oldImplementationAddress = await getImplementationAddress(connectedImplementation);
  console.log(chalk.green("Old implementation address:", oldImplementationAddress));

  const newIplDeployment = await TMFactory.deploy();
  const newIplAddress = await newIplDeployment.getAddress();
  console.log(chalk.green("Before upgrade, new implementation address:", newIplAddress));
  const tx = await connectedImplementation.upgradeToAndCall(newIplAddress, "0x");
  await tx.wait();
  console.log(chalk.green("Successfully upgraded TaskManager contract"));
  const incTx = await connectedImplementation.incVersion();
  await incTx.wait();
  const newImplementationAddress = await getImplementationAddress(connectedImplementation);
  console.log(chalk.green("New implementation address:", newImplementationAddress));
  if (oldImplementationAddress === newImplementationAddress) {
    console.log(chalk.red("WARNING: Implementation address did not change!"));
  } else {
    console.log(chalk.green("Implementation address changed successfully!"));
  }
  console.log("\n");
}

interface Wallet {
  privateKey: string;
  address: string;
}

interface WalletList {
  resultProcessorWallets: Wallet[];
  verifierListenerWallet: Wallet; 
}

function getAggregatorWallets(ethers: any) {
  const aggregatorWallets = JSON.parse(fs.readFileSync(join(__dirname, '../wallets.json'), 'utf8')) as WalletList;
  return aggregatorWallets.resultProcessorWallets.map((wallet) =>
    new ethers.Wallet(wallet.privateKey, ethers.provider)
  );
}

const func: DeployFunction = async function () {
  console.log(chalk.bold.blue("-----------------------Network-----------------------------"));
  console.log(chalk.green("Network name:", hre.network.name));
  console.log(chalk.green("Network:", hre.network.config));
  console.log("\n");

  // Note: we need to use an unused account for deployment via ignition, or it will complain
  const [signer, signerProxy] = await ethers.getSigners();
  

  console.log(chalk.bold.blue("-----------------------Funding-----------------------------"));
  if (hre.network.name.includes("localfhenix")) {
    // Deterministic deployment via createX contract:
    // Deploy create x contract
    await fundAccount(hre, signerProxy);
    await deployCreateX(hre, signerProxy);
  }

  const aggregatorSigners = getAggregatorWallets(ethers);
  for (const aggregatorSigner of aggregatorSigners) {
    await fundAccount(hre, aggregatorSigner);
  }

  await fundAccount(hre, signer);
  console.log(chalk.dim("Successfully funded aggregator and deployer accounts"));
  console.log("\n");

  const TMProxyAddress = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

  // Headline in chalk blue, with length of 60
  console.log(chalk.bold.blue("-----------------------TaskManager--------------------------"));
  const TMFactory = await ethers.getContractFactory("TaskManager");
  const TMProxyContract = TMFactory.attach(TMProxyAddress) as Contract;
  console.log(chalk.green("TMProxyContract attached to:", await TMProxyContract.getAddress()));
  await upgradeTM(TMProxyContract, TMFactory, aggregatorSigners[0]);
  await TaskManagerSetup(TMProxyContract, aggregatorSigners);

  console.log(chalk.bold.blue("---------------------------ACL------------------------------"));
  // Deploy and upgrade ACL contract
  const {ProxyContract: aclContract} = await getProxyContract(aggregatorSigners[0].address, "ACL");
  await ACLSetup(TMProxyContract, aggregatorSigners[0], aclContract);

  // Deploy new PlaintextsStorage contract
  console.log(chalk.bold.blue("---------------------PlaintextsStorage----------------------"));
  const {ProxyAddress: ptStorageAddress} = await getProxyContract(aggregatorSigners[0].address, "PlaintextsStorage");
  await PlaintextsStorageSetup(TMProxyContract, ptStorageAddress, aggregatorSigners[0]);
};

export default func;
func.id = "deploy_all";
func.tags = ["TaskManager", "Example"];
