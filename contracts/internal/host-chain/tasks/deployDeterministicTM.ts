import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { Contract, ContractFactory } from "ethers";
import { task } from "hardhat/config";

import DeterministicTM from "../ignition/modules/DeterministicTM";
import { deployCreateX } from "../utils/deployCreateX";
import { fundAccount } from "../utils/fund";
import { deployDeterministic } from "../utils/deployDeterministic";
import {
  updateTaskManagerAddressInJsonArtifact,
} from "../utils/updateTaskManagerAddress";
import chalk from "chalk";
import ERC1967ProxyModule from "../ignition/modules/ERC1967Proxy";
import { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";
// DOTENV_CONFIG_PATH is used to specify the path to the .env file for example in the CI
const dotenvConfigPath: string = process.env.DOTENV_CONFIG_PATH || "../.env";
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) });

/**
 * Gets the implementation address of a proxy contract
 * @param proxy The proxy contract to get the implementation address of
 * @returns The implementation address of the proxy contract
 */
async function getImplementationAddress(proxy: any, hre: HardhatRuntimeEnvironment) {
  const IMPLEMENTATION_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implementationAddress = await hre.ethers.provider.getStorage(
    proxy,
    IMPLEMENTATION_SLOT,
  );

  // Convert the storage value to address format
  const currentImplementation = hre.ethers.getAddress(
    "0x" + implementationAddress.slice(-40),
  );

  return currentImplementation;
}

async function getDeterministicDummyContract(admin: string, hre: HardhatRuntimeEnvironment) {
  // deploy the dummy contract deterministically
  const expectedAddress = "0x3428Ca0c49393A34fABbDF61088b68aCff55b14e";
  const dummyAddress = await deployDeterministic(
    hre,
    expectedAddress,
    DeterministicTM,
    {},
  );
  console.log(chalk.green("Deployed dummy contract at:", dummyAddress));
  return dummyAddress;
}

/**
 * Gets the deterministic proxy contract
 * @param contractName The name of the contract to deploy
 * @param admin The admin account that has deploy permissions
 * @param factory The factory for the contract to deploy
 * @param implementationAddress The address of the implementation contract
 * @param implementation The implementation contract
 * @returns The proxy contract and its address
 */
async function getDeterministicProxyContract(
  admin: string,
  factory: ContractFactory,
  hre: HardhatRuntimeEnvironment
) {
  //Deploy the Proxy Contract
  // using the ERC1967ProxyModule, in the constructor we pass the implementation address and the data
  // where the data is the initialization data for the implementation contract
  const proxyAddress = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";
  const proxyInitData = factory.interface.encodeFunctionData("initialize", [admin]);
  const dummyAddress = await getDeterministicDummyContract(admin, hre);
  const deployedAddress = await deployDeterministic(
    hre,
    proxyAddress,
    ERC1967ProxyModule,
    {
      implementation: dummyAddress,
      data: proxyInitData
    }
  );
  console.log(chalk.green("Deployed proxy at:", deployedAddress));

  // Get the proxy with the implementation's ABI
  const proxyContract = factory.attach(deployedAddress) as Contract;
  console.log(chalk.green("Proxy contract:", await proxyContract.getAddress()));
  const implementationAddressFromProxy = await getImplementationAddress(proxyContract, hre);

  if (implementationAddressFromProxy !== dummyAddress) {
    console.log(chalk.red("Implementation address from proxy does not match expected address", implementationAddressFromProxy, " != ", dummyAddress));
    process.exit(1);
  }

  console.log(chalk.green("Implementation address from proxy:", implementationAddressFromProxy));


  return { proxyContract, deployedAddress: deployedAddress.toString() };
}

task("task:deployDeterministicTM", "Deploy deterministic TaskManager").setAction(
  async function (taskArguments: TaskArguments, hre) {
    // Note: we need to use an unused account for deployment via ignition, or it will complain
    const [signer, signerProxy, aggregatorSigner] = await hre.ethers.getSigners();

  console.log(chalk.bold.blue("-----------------------Funding-----------------------------"));
  if (hre.network.name.includes("localfhenix")) {
    // Deterministic deployment via createX contract:
    // Deploy create x contract
    console.log(chalk.green("Funding account:", signerProxy.address));
    
    await fundAccount(hre, signerProxy);
    await deployCreateX(hre, signerProxy);
  }

  await fundAccount(hre, aggregatorSigner);
  await fundAccount(hre, signer);
  console.log(chalk.dim("Successfully funded aggregator and deployer accounts"));
  console.log("\n");


  // Todo this needs to be deterministic
  // Headline in chalk blue, with length of 60
  console.log(chalk.bold.blue("-----------------------TaskManager--------------------------"));
  const TMFactory = await hre.ethers.getContractFactory("TaskManager");
  const { proxyContract: TMProxyContract, deployedAddress: TMProxyAddress } = await getDeterministicProxyContract(
    aggregatorSigner.address,
    TMFactory,
    hre
  );
  await updateTaskManagerAddressInJsonArtifact(TMProxyAddress, hre);
  }
);
