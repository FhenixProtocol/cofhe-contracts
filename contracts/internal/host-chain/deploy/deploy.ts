import { DeployFunction } from "hardhat-deploy/types";
import { config as dotenvConfig } from "dotenv";
import { join, resolve } from "path";
import { Contract } from "ethers";
import chalk from "chalk";
import hre, { ethers, upgrades } from "hardhat";
import fs from "fs";

import { deployCreateX } from "../utils/deployCreateX";
import { fundAccount } from "../utils/fund";
import {
  getDefaultAdmin,
  grantAllRoles,
  isLocalNetwork,
  requireDefaultAdminIsSignerOrUnset,
  resolveAdminDelay,
} from "../utils/roles";

// DOTENV_CONFIG_PATH is used to specify the path to the .env file for example in the CI
const dotenvConfigPath: string = process.env.DOTENV_CONFIG_PATH || "../.env";
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) });

/**
 * Deploys a proxy contract for a given contract name
 * @param adminSigner The admin account, which becomes the default admin and holds every role
 * @param adminDelay The default-admin transfer delay to initialize with
 * @param contractName The name of the contract to deploy
 * @returns The proxy contract and its address
 */
async function getProxyContract(adminSigner: any, adminDelay: number, contractName: string) {
  const TaskManager = await ethers.getContractFactory(contractName);
  const ProxyContract = await upgrades.deployProxy(
    TaskManager,
    [adminSigner.address, adminDelay],
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
  // `initialize` grants only DEFAULT_ADMIN_ROLE, so grant every role the contract declares to the
  // deployer - including UPGRADER_ROLE, without which this proxy could never be upgraded again.
  await grantAllRoles(ProxyContract, adminSigner);
  return { ProxyContract, ProxyAddress };
}

/**
 * Sets up the TaskManager contract
 * Enables intake, sets the security zones and the verifier / decrypt-result signers.
 *
 * Every step here is role-gated, so a missing grant surfaces as a revert. These used to be caught
 * and returned to a caller that ignored the return value, which turned a half-configured
 * TaskManager into a successful-looking deploy - rethrow so the deploy exits non-zero instead.
 *
 * @param TMProxyContract The TaskManager proxy contract
 * @param adminSigner The signer holding the operational roles on the TaskManager
 */
async function TaskManagerSetup(TMProxyContract: any, adminSigner: any) {
  // Get the implementation address using ERC1967 storage slot
  try {
    const currentImplementation = await getImplementationAddress(
      TMProxyContract,
    );
    const isInitialized = await TMProxyContract.isInitialized();
    const owner = await TMProxyContract.defaultAdmin();
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
    throw e;
  }

  // Open the coprocessor intake kill-switch
  try {
    const connectedImplementation = TMProxyContract.connect(adminSigner);
    const enableTx = await connectedImplementation.enable();
    await enableTx.wait();
    console.log(chalk.green("Successfully enabled TaskManager"));
  } catch (e) {
    console.error(chalk.red(`Failed enable transaction: ${e}`));
    throw e;
  }

  // Set the security zones
  try {
    const minSZ = 0;
    const maxSZ = 0;
    const connectedImplementation = TMProxyContract.connect(adminSigner);
    const tx = await connectedImplementation.setSecurityZones(minSZ, maxSZ);
    await tx.wait();
    console.log(chalk.green("Successfully set Security Zones in TaskManager"));
  } catch (e) {
    console.error(chalk.red(`Failed setSecurityZones transaction: ${e}`));
    throw e;
  }

  try {
    const connectedImplementation = TMProxyContract.connect(adminSigner);
    if (
      process.env.VERIFIER_ADDRESS === "0x0000000000000000000000000000000000000000" &&
      !isLocalNetwork(hre)
    ) {
      throw new Error("refusing to set VERIFIER_ADDRESS to 0 on a non-local network!");
    }

    const tx = await connectedImplementation.setVerifierSigner(
      process.env.VERIFIER_ADDRESS,
    );
    await tx.wait();
    console.log(chalk.green(`Successfully set verifier signer address: ${process.env.VERIFIER_ADDRESS}`));
  } catch (e) {
    console.error(chalk.red(`Failed setVerifierSigner transaction: ${e}`));
    throw e;
  }

  // Set the decrypt result signer (dispatcher's signing key)
  try {
    const connectedImplementation = TMProxyContract.connect(adminSigner);
    if (
      process.env.DECRYPT_RESULT_SIGNER === "0x0000000000000000000000000000000000000000" &&
      !isLocalNetwork(hre)
    ) {
      throw new Error("refusing to set DECRYPT_RESULT_SIGNER to 0 on a non-local network!");
    }

    const tx = await connectedImplementation.setDecryptResultSigner(
      process.env.DECRYPT_RESULT_SIGNER,
    );
    await tx.wait();
    console.log(chalk.green(`Successfully set decrypt result signer address: ${process.env.DECRYPT_RESULT_SIGNER}`));
  } catch (e) {
    console.error(chalk.red(`Failed setDecryptResultSigner transaction: ${e}`));
    throw e;
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
    throw e;
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
 * @param adminSigner The signer that is (or becomes) the proxy's default admin
 * @param adminDelay The default-admin transfer delay to seed on migration
 */
async function upgradeTM(TMProxyContract: any, TMFactory: any, adminSigner: any, adminDelay: number) {
  console.log(chalk.bold.blue("-----------------------Upgrading TaskManager--------------------------"));
  console.log(chalk.green("Admin signer:", adminSigner.address));
  const currentDefaultAdmin = await getDefaultAdmin(TMProxyContract, ethers.ZeroAddress);
  console.log(chalk.green("Default admin before upgrade:", currentDefaultAdmin ?? "none (pre-roles implementation)"));

  // `_authorizeUpgrade` needs only UPGRADER_ROLE, but `grantAllRoles` below needs
  // DEFAULT_ADMIN_ROLE. Once the admin moves to a Safe and this key holds only UPGRADER_ROLE, the
  // upgrade would land and the grants would then revert, leaving the proxy on the new
  // implementation with no operational roles, no version bump and no TaskManagerSetup.
  requireDefaultAdminIsSignerOrUnset(currentDefaultAdmin, adminSigner);

  const connectedImplementation = TMProxyContract.connect(adminSigner);
  const oldImplementationAddress = await getImplementationAddress(connectedImplementation);
  console.log(chalk.green("Old implementation address:", oldImplementationAddress));

  const newIplDeployment = await TMFactory.deploy();
  await newIplDeployment.waitForDeployment();
  const newIplAddress = await newIplDeployment.getAddress();
  console.log(chalk.green("Before upgrade, new implementation address:", newIplAddress));

  // The deterministic bootstrap implementation behind this proxy is Ownable, so the AccessControl
  // storage is still empty. Seed it via initializeV2 in the *same* transaction as the upgrade.
  // initializeV2 is gated on the legacy Ownable owner, so a gap is no longer exploitable, but
  // keeping it atomic means the proxy is never observable in a half-migrated state.
  const migrationData =
    currentDefaultAdmin === null
      ? TMFactory.interface.encodeFunctionData("initializeV2", [adminSigner.address, adminDelay])
      : "0x";
  const tx = await connectedImplementation.upgradeToAndCall(newIplAddress, migrationData);
  await tx.wait();
  console.log(chalk.green("Successfully upgraded TaskManager contract"));
  console.log(chalk.green("Default admin after upgrade:", await TMProxyContract.defaultAdmin()));

  // initialize/initializeV2 only grant DEFAULT_ADMIN_ROLE; incVersion below and the whole
  // of TaskManagerSetup need the operational roles.
  await grantAllRoles(TMProxyContract, adminSigner);

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

/**
 * Picks the signer that becomes DEFAULT_ADMIN_ROLE on every proxy this script touches, and the
 * default-admin transfer delay to seed.
 *
 * The fallback is `wallets.json[0]` with a zero delay - a key committed to this repository. That is
 * fine for a local stack and unacceptable anywhere else, so on a non-local network both values must
 * be stated explicitly via TM_ADMIN_ADDRESS / TM_ADMIN_DELAY. TM_ADMIN_ADDRESS is matched against
 * the candidate signers rather than merely recorded: this script has to hold DEFAULT_ADMIN_ROLE to
 * run `grantAllRoles`, so an admin it cannot sign for could not be honoured anyway.
 */
function resolveAdmin(candidateSigners: any[]) {
  const local = isLocalNetwork(hre);
  const requestedAdmin = process.env.TM_ADMIN_ADDRESS?.trim();

  if (!local && !requestedAdmin) {
    throw new Error(
      "TM_ADMIN_ADDRESS must be set on a non-local network. Refusing to make the committed " +
        "wallets.json key the DEFAULT_ADMIN of these proxies.",
    );
  }

  // Throws on a blank or zero delay off a local network - see resolveAdminDelay.
  const adminDelay = resolveAdminDelay(hre);

  const adminSigner = requestedAdmin
    ? candidateSigners.find(
        (candidate) => candidate.address.toLowerCase() === requestedAdmin.toLowerCase(),
      )
    : candidateSigners[0];

  if (!adminSigner) {
    throw new Error(
      `TM_ADMIN_ADDRESS is ${requestedAdmin}, but this deployment has no signer for it. ` +
        `Available: ${candidateSigners.map((c) => c.address).join(", ")}. This script must sign ` +
        `as the default admin to grant the operational roles.`,
    );
  }

  console.log(chalk.green("Default admin:", adminSigner.address, "delay:", adminDelay));
  if (local && !requestedAdmin) {
    console.log(chalk.yellow("TM_ADMIN_ADDRESS not set - using the committed dev key (local network only)"));
  }
  return { adminSigner, adminDelay };
}

const func: DeployFunction = async function () {
  console.log(chalk.bold.blue("-----------------------Network-----------------------------"));
  console.log(chalk.green("Network name:", hre.network.name));
  console.log(chalk.green("Network:", JSON.stringify(hre.network.config, (_, v) => typeof v === 'bigint' ? v.toString() : v)));
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

  const { adminSigner, adminDelay } = resolveAdmin([...aggregatorSigners, signer]);

  const TMProxyAddress = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

  // Headline in chalk blue, with length of 60
  console.log(chalk.bold.blue("-----------------------TaskManager--------------------------"));
  const TMFactory = await ethers.getContractFactory("TaskManager");
  const TMProxyContract = TMFactory.attach(TMProxyAddress) as Contract;
  console.log(chalk.green("TMProxyContract attached to:", await TMProxyContract.getAddress()));
  await upgradeTM(TMProxyContract, TMFactory, adminSigner, adminDelay);
  await TaskManagerSetup(TMProxyContract, adminSigner);

  console.log(chalk.bold.blue("---------------------------ACL------------------------------"));
  // Deploy and upgrade ACL contract
  const {ProxyContract: aclContract} = await getProxyContract(adminSigner, adminDelay, "ACL");
  await ACLSetup(TMProxyContract, adminSigner, aclContract);

  // Deploy new PlaintextsStorage contract
  console.log(chalk.bold.blue("---------------------PlaintextsStorage----------------------"));
  const {ProxyAddress: ptStorageAddress} = await getProxyContract(adminSigner, adminDelay, "PlaintextsStorage");
  await PlaintextsStorageSetup(TMProxyContract, ptStorageAddress, adminSigner);
};

export default func;
func.id = "deploy_all";
func.tags = ["TaskManager", "Example"];
