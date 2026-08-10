import hre from "hardhat";
const { ethers } = hre;
import { Wallet, BaseContract } from "ethers";

import { grantAllRoles } from "../../utils/roles";

// The hardcoded TaskManager address that ACL and PlaintextsStorage expect
const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

export interface DecryptResultFixture {
  taskManager: BaseContract;
  plaintextsStorage: BaseContract;
  acl: BaseContract;
  owner: any;
  testSigner: Wallet;
  otherAccount: any;
}

/**
 * Generate a deterministic test signing key for testing
 * This key is ONLY for testing - never use in production
 */
function getTestSignerWallet(): Wallet {
  const testPrivateKey = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  return new ethers.Wallet(testPrivateKey, ethers.provider);
}

/**
 * Install a UUPS proxy's runtime bytecode at a fixed address and initialize it
 * in place. We can't `deployProxy` at an arbitrary address, and AccessControl
 * stores role membership in computed mapping slots (not one fixed slot), so we
 * initialize through the real proxy rather than copying storage slots.
 */
async function deployProxyAtAddress(
  targetAddress: string,
  implementationAddress: string,
  initData: string
): Promise<void> {
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  // Deploy a throwaway proxy only to capture the proxy runtime bytecode.
  const tempProxy = await ERC1967Proxy.deploy(implementationAddress, "0x");
  await tempProxy.waitForDeployment();
  const proxyBytecode = await ethers.provider.getCode(await tempProxy.getAddress());

  // Install proxy code at the fixed address.
  await ethers.provider.send("hardhat_setCode", [targetAddress, proxyBytecode]);

  // Point the ERC1967 implementation slot at our implementation.
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  await ethers.provider.send("hardhat_setStorageAt", [
    targetAddress,
    IMPL_SLOT,
    ethers.zeroPadValue(implementationAddress, 32),
  ]);

  // Initialize the proxy in place (fresh storage at the target address).
  const [signer] = await ethers.getSigners();
  const tx = await signer.sendTransaction({ to: targetAddress, data: initData });
  await tx.wait();
}

export async function deployDecryptResultFixture(): Promise<DecryptResultFixture> {
  // Multiple test files deploy TaskManager at the same hardcoded address within
  // the same Hardhat network process; reset so `initialize` sees fresh storage
  // (hardhat_setCode/hardhat_setStorageAt below only work on the Hardhat network).
  await ethers.provider.send("hardhat_reset", []);

  const [owner, otherAccount] = await ethers.getSigners();

  // Deploy TaskManager implementation
  const TaskManager = await ethers.getContractFactory("TaskManager");
  const taskManagerImpl = await TaskManager.deploy();
  await taskManagerImpl.waitForDeployment();

  // Prepare init data
  const initData = TaskManager.interface.encodeFunctionData("initialize", [owner.address, 0]);

  // Deploy proxy at the hardcoded address
  await deployProxyAtAddress(
    TASK_MANAGER_ADDRESS,
    await taskManagerImpl.getAddress(),
    initData
  );

  // Get TaskManager at the hardcoded address
  const taskManager = TaskManager.attach(TASK_MANAGER_ADDRESS);

  // Deploy ACL (real contract - it expects TaskManager at hardcoded address)
  const ACL = await ethers.getContractFactory("ACL");
  const aclImpl = await ACL.deploy();
  await aclImpl.waitForDeployment();

  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const aclInitData = ACL.interface.encodeFunctionData("initialize", [owner.address, 0]);
  const aclProxy = await ERC1967Proxy.deploy(await aclImpl.getAddress(), aclInitData);
  await aclProxy.waitForDeployment();
  const acl = ACL.attach(await aclProxy.getAddress());

  // Deploy PlaintextsStorage (real contract)
  const PlaintextsStorage = await ethers.getContractFactory("PlaintextsStorage");
  const psImpl = await PlaintextsStorage.deploy();
  await psImpl.waitForDeployment();

  const psInitData = PlaintextsStorage.interface.encodeFunctionData("initialize", [owner.address, 0]);
  const psProxy = await ERC1967Proxy.deploy(await psImpl.getAddress(), psInitData);
  await psProxy.waitForDeployment();
  const plaintextsStorage = PlaintextsStorage.attach(await psProxy.getAddress());

  // `initialize` only grants DEFAULT_ADMIN_ROLE; mirror the deploy script and give the admin
  // every role, so the fixture stays correct when a contract gains a new one.
  await grantAllRoles(taskManager, owner, false);
  await grantAllRoles(acl, owner, false);
  await grantAllRoles(plaintextsStorage, owner, false);

  // Configure TaskManager
  await taskManager.setACLContract(await acl.getAddress());
  await taskManager.setPlaintextsStorage(await plaintextsStorage.getAddress());
  await taskManager.setSecurityZones(-128, 127);

  // Create test signer
  const testSigner = getTestSignerWallet();
  await taskManager.setDecryptResultSigner(testSigner.address);

  return {
    taskManager,
    plaintextsStorage,
    acl,
    owner,
    testSigner,
    otherAccount,
  };
}
