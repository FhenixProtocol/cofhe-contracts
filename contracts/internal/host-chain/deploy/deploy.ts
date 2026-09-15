import { DeployFunction } from "hardhat-deploy/types";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { Contract } from "ethers";
import chalk from "chalk";
import hre, { ethers, upgrades } from "hardhat";

import { deployCreateX } from "../utils/deployCreateX";
import { fundAccount } from "../utils/fund";
import {
  getDefaultAdmin,
  grantAllRoles,
  grantRolesByName,
  isLocalNetwork,
  MAINTENANCE_ROLES,
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

  // Open the coprocessor intake kill-switch - except on mainnet, which ships closed.
  //
  // A proxy coming off the deterministic bootstrap stub is already disabled: `isEnabled` lives in
  // slot 7, the stub's storage stops at slot 4, and `initializeV2` deliberately leaves that slot
  // alone. So skipping the call here is all it takes for a mainnet deployment to end with intake
  // closed - no explicit `disable()` needed. Going live is a separate, deliberate step by a
  // PAUSER_ROLE holder (the Safe, or the maintenance wallet) once the configuration is verified.
  if (isMainnetDeployment()) {
    console.log(
      chalk.yellow(
        "Mainnet deployment - leaving TaskManager DISABLED. Intake stays closed until a " +
          "PAUSER_ROLE holder calls enable(); see docs/mainnet-deployment.md.",
      ),
    );
  } else {
    try {
      const connectedImplementation = TMProxyContract.connect(adminSigner);
      const enableTx = await connectedImplementation.enable();
      await enableTx.wait();
      console.log(chalk.green("Successfully enabled TaskManager"));
    } catch (e) {
      console.error(chalk.red(`Failed enable transaction: ${e}`));
      throw e;
    }
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
 * Deploys the ACP infrastructure contracts and registers their addresses in the ACL
 * @param aclContract The ACL proxy contract
 * @param ownerSigner The ACL owner (allowed to call the address setters)
 */
async function ACPInfrastructureSetup(aclContract: any, ownerSigner: any) {
  try {
    const revokerFactory = await ethers.getContractFactory("ACPTimestampRevoker");
    const revoker = await revokerFactory.deploy();
    await revoker.waitForDeployment();
    const revokerAddress = await revoker.getAddress();
    console.log(
      chalk.green("Successfully deployed ACPTimestampRevoker to:", revokerAddress),
    );

    const tx = await aclContract
      .connect(ownerSigner)
      .setDefaultRevokerContract(revokerAddress);
    await tx.wait();
    console.log(
      chalk.green("Successfully set default revoker contract in ACL"),
    );

    // Not via getProxyContract: ACPShareRegistry is plain AccessControl (no default-admin
    // rules), so its initialize takes only the admin - passing an adminDelay too made the
    // encode throw, which the old catch-and-return silently swallowed, and every deploy since
    // shipped without a share registry. `initialize` already grants DEFAULT_ADMIN_ROLE and
    // UPGRADER_ROLE to the owner.
    const shareRegistryFactory = await ethers.getContractFactory("ACPShareRegistry");
    const shareRegistryContract = await upgrades.deployProxy(
      shareRegistryFactory,
      [ownerSigner.address],
      { kind: "uups", initializer: "initialize" },
    );
    await shareRegistryContract.waitForDeployment();
    const shareRegistryAddress = await shareRegistryContract.getAddress();
    console.log(
      chalk.green("Successfully deployed proxy: ACPShareRegistry to:", shareRegistryAddress),
    );

    const registryTx = await aclContract
      .connect(ownerSigner)
      .setShareRegistry(shareRegistryAddress);
    await registryTx.wait();
    console.log(chalk.green("Successfully set share registry in ACL"));
    console.log("\n");
    return shareRegistryContract;
  } catch (e) {
    // Rethrow like the other setup steps: swallowing this used to turn a half-configured ACP
    // stack into a successful-looking deploy.
    console.error(chalk.red(`Failed ACP infrastructure setup: ${e}`));
    throw e;
  }
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

// The aggregator key comes from the environment, never from a committed file: this repo is
// public, and a key checked in here once ended up doubling as a live testnet identity.
// Mainnet deployments have no aggregator identity at all - there, the deployer signer fills
// that role and this returns an empty list. The local stack still requires the key: it funds
// the wallet and the stack expects its address as the result-processor.
function getAggregatorWallets(ethers: any) {
  const key = process.env.AGGREGATOR_KEY;
  if (!key) {
    if (isLocalNetwork(hre)) {
      throw new Error(
        "AGGREGATOR_KEY must be set on a local network - the deploy funds it and uses it for the ACP infrastructure setup.",
      );
    }
    console.log(chalk.yellow("AGGREGATOR_KEY not set - the deployer signer will run the ACP infrastructure setup."));
    return [];
  }
  return [new ethers.Wallet(key, ethers.provider)];
}

// Chains where a deployment must not end with an EOA holding DEFAULT_ADMIN, and must not end
// with task intake open.
const MAINNET_CHAIN_IDS = new Set([1, 42161]);

/** True when deploying to a production chain. */
function isMainnetDeployment(): boolean {
  return MAINNET_CHAIN_IDS.has((hre.network.config as any)?.chainId);
}

/**
 * Resolves the address that ends up holding DEFAULT_ADMIN and every operational role once the
 * deployment settles - on mainnet, the Gnosis Safe. Returns null when unset, which is refused on
 * mainnet chain IDs: without it the deployer EOA would remain the admin of every proxy.
 */
function resolveFinalAdmin(ethers: any): string | null {
  const raw = process.env.SAFE_ADMIN_ADDRESS?.trim();
  if (raw) {
    return ethers.getAddress(raw);
  }
  if (isMainnetDeployment()) {
    const chainId = (hre.network.config as any)?.chainId;
    throw new Error(
      `SAFE_ADMIN_ADDRESS must be set on chain ${chainId}. Refusing to leave the deployer EOA ` +
        `as DEFAULT_ADMIN of the mainnet proxies - set it to the Safe that takes over.`,
    );
  }
  return null;
}

/**
 * Resolves the maintenance wallet - a hardware wallet that holds only the narrow operational
 * roles in {@link MAINTENANCE_ROLES}, so day-to-day pausing and security-zone changes do not need
 * the Safe.
 *
 * Required on mainnet, for the same reason SAFE_ADMIN_ADDRESS is: a production chain that ends up
 * with no maintenance wallet forces every pause through the Safe, and discovering that during an
 * incident is too late. Optional elsewhere, so the local stack and the test fixtures still run
 * without one.
 */
function resolveMaintenanceAddress(ethers: any): string | null {
  const raw = process.env.MAINTENANCE_ADDRESS?.trim();
  if (raw) {
    return ethers.getAddress(raw);
  }
  if (isMainnetDeployment()) {
    const chainId = (hre.network.config as any)?.chainId;
    throw new Error(
      `MAINTENANCE_ADDRESS must be set on chain ${chainId}. Without it the only holder of ` +
        `PAUSER_ROLE and SECURITY_ZONE_MANAGER_ROLE is the Safe, so pausing intake needs a ` +
        `multisig round trip.`,
    );
  }
  return null;
}

/**
 * Hands every contract over to `finalAdmin`: grants it all operational roles, and moves
 * DEFAULT_ADMIN over. On the default-admin-rules contracts (`twoStep`) that is the two-step
 * transfer, completed only when the new admin calls `acceptDefaultAdminTransfer()` after the
 * admin delay - for a Safe, via `task:acceptAdminAsSafe`. Plain AccessControl contracts
 * (ACPShareRegistry) have no transfer mechanism and DEFAULT_ADMIN_ROLE is granted directly.
 * The deployer keeps its own roles until `task:renounceDeployerRoles` runs after the handover,
 * so a failed acceptance never leaves a contract unmanageable.
 */
async function handOverToFinalAdmin(
  contracts: { name: string; contract: any; admin: any; twoStep: boolean }[],
  finalAdmin: string,
) {
  for (const { name, contract, admin, twoStep } of contracts) {
    await grantAllRoles(contract, admin, finalAdmin);
    if (twoStep) {
      const tx = await contract.connect(admin).beginDefaultAdminTransfer(finalAdmin);
      await tx.wait();
      console.log(chalk.green(`${name}: granted all roles to ${finalAdmin} and began the default-admin transfer`));
    } else {
      const defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE();
      const tx = await contract.connect(admin).grantRole(defaultAdminRole, finalAdmin);
      await tx.wait();
      console.log(chalk.green(`${name}: granted all roles and DEFAULT_ADMIN_ROLE to ${finalAdmin}`));
    }
  }
}

/**
 * Picks the signer that becomes DEFAULT_ADMIN_ROLE on every proxy this script touches, and the
 * default-admin transfer delay to seed.
 *
 * The fallback is the AGGREGATOR_KEY wallet with a zero delay - a dev key from the local .env. That
 * is fine for a local stack and unacceptable anywhere else, so on a non-local network both values
 * must be stated explicitly via TM_ADMIN_ADDRESS / TM_ADMIN_DELAY. TM_ADMIN_ADDRESS is matched against
 * the candidate signers rather than merely recorded: this script has to hold DEFAULT_ADMIN_ROLE to
 * run `grantAllRoles`, so an admin it cannot sign for could not be honoured anyway.
 */
function resolveAdmin(candidateSigners: any[]) {
  const local = isLocalNetwork(hre);
  const requestedAdmin = process.env.TM_ADMIN_ADDRESS?.trim();

  if (!local && !requestedAdmin) {
    throw new Error(
      "TM_ADMIN_ADDRESS must be set on a non-local network. Refusing to make the dev " +
        "AGGREGATOR_KEY wallet the DEFAULT_ADMIN of these proxies.",
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
  // Resolved before anything deploys, so a missing Safe address fails the run while it is
  // still a no-op instead of after the proxies exist.
  const finalAdmin = resolveFinalAdmin(ethers);
  const maintenanceAddress = resolveMaintenanceAddress(ethers);

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

  console.log(chalk.bold.blue("----------------------ACP infrastructure--------------------"));
  // Both ACL setters below are onlyRole(DEFAULT_ADMIN_ROLE) and the share registry's initial
  // admin should be the same account, so this has to be the ACL's admin - never the aggregator.
  // Preferring the aggregator only ever worked because the local stack leaves TM_ADMIN_ADDRESS
  // unset, which makes the aggregator the admin by accident.
  const shareRegistryContract = await ACPInfrastructureSetup(aclContract, adminSigner);

  // Deploy new PlaintextsStorage contract
  console.log(chalk.bold.blue("---------------------PlaintextsStorage----------------------"));
  const {ProxyContract: ptStorageContract, ProxyAddress: ptStorageAddress} = await getProxyContract(adminSigner, adminDelay, "PlaintextsStorage");
  await PlaintextsStorageSetup(TMProxyContract, ptStorageAddress, adminSigner);

  // Before the handover, while the deployer unambiguously still holds DEFAULT_ADMIN_ROLE:
  // beginDefaultAdminTransfer only schedules, but granting from the Safe afterwards would need a
  // Safe transaction for what is a one-line grant here.
  if (maintenanceAddress) {
    console.log(chalk.bold.blue("---------------------Maintenance wallet---------------------"));
    await grantRolesByName(TMProxyContract, adminSigner, maintenanceAddress, MAINTENANCE_ROLES);
    console.log("");
  }

  if (finalAdmin) {
    console.log(chalk.bold.blue("----------------------Admin handover-------------------------"));
    await handOverToFinalAdmin(
      [
        { name: "TaskManager", contract: TMProxyContract, admin: adminSigner, twoStep: true },
        { name: "ACL", contract: aclContract, admin: adminSigner, twoStep: true },
        { name: "ACPShareRegistry", contract: shareRegistryContract, admin: adminSigner, twoStep: false },
        { name: "PlaintextsStorage", contract: ptStorageContract, admin: adminSigner, twoStep: true },
      ],
      finalAdmin,
    );
    console.log(
      chalk.yellow(
        `Handover started. After the admin delay (${adminDelay}s), run task:acceptAdminAsSafe ` +
          `to accept as ${finalAdmin}, then task:renounceDeployerRoles to strip the deployer.`,
      ),
    );
  }
};

export default func;
func.id = "deploy_all";
func.tags = ["TaskManager", "Example"];
