import hre from "hardhat";
const { ethers } = hre;
import { Wallet, BaseContract } from "ethers";

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
 * Deploy a proxy at a specific address using hardhat_setCode
 */
async function deployProxyAtAddress(
  targetAddress: string,
  implementationAddress: string,
  initData: string
): Promise<void> {
  // Get the proxy bytecode by deploying one temporarily
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const tempProxy = await ERC1967Proxy.deploy(implementationAddress, initData);
  await tempProxy.waitForDeployment();

  // Get the runtime bytecode from the deployed proxy
  const proxyBytecode = await ethers.provider.getCode(await tempProxy.getAddress());

  // Set the bytecode at our target address
  await ethers.provider.send("hardhat_setCode", [targetAddress, proxyBytecode]);

  // Storage slots to copy (ERC1967 + OZ v5 namespaced storage)
  const storageSlots = [
    // ERC1967 implementation slot
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    // OZ Initializable slot: keccak256("openzeppelin.storage.Initializable") - 1
    "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00",
    // OZ Ownable slot: keccak256("openzeppelin.storage.Ownable") - 1
    "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300",
    // OZ Ownable2Step pending owner slot (next slot after owner)
    "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199301",
    // TaskManager storage slots (slot 0-10 for custom state variables)
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000000000000000000000000000000003",
    "0x0000000000000000000000000000000000000000000000000000000000000004",
    "0x0000000000000000000000000000000000000000000000000000000000000005",
    "0x0000000000000000000000000000000000000000000000000000000000000006",
    "0x0000000000000000000000000000000000000000000000000000000000000007",
    "0x0000000000000000000000000000000000000000000000000000000000000008",
    "0x0000000000000000000000000000000000000000000000000000000000000009",
    "0x000000000000000000000000000000000000000000000000000000000000000a",
  ];

  const tempAddress = await tempProxy.getAddress();
  for (const slot of storageSlots) {
    const value = await ethers.provider.getStorage(tempAddress, slot);
    if (value !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
      await ethers.provider.send("hardhat_setStorageAt", [targetAddress, slot, value]);
    }
  }
}

export async function deployDecryptResultFixture(): Promise<DecryptResultFixture> {
  const [owner, otherAccount] = await ethers.getSigners();

  // Deploy TaskManager implementation
  const TaskManager = await ethers.getContractFactory("TaskManager");
  const taskManagerImpl = await TaskManager.deploy();
  await taskManagerImpl.waitForDeployment();

  // Prepare init data
  const initData = TaskManager.interface.encodeFunctionData("initialize", [owner.address]);

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
  const aclInitData = ACL.interface.encodeFunctionData("initialize", [owner.address]);
  const aclProxy = await ERC1967Proxy.deploy(await aclImpl.getAddress(), aclInitData);
  await aclProxy.waitForDeployment();
  const acl = ACL.attach(await aclProxy.getAddress());

  // Deploy PlaintextsStorage (real contract)
  const PlaintextsStorage = await ethers.getContractFactory("PlaintextsStorage");
  const psImpl = await PlaintextsStorage.deploy();
  await psImpl.waitForDeployment();

  const psInitData = PlaintextsStorage.interface.encodeFunctionData("initialize", [owner.address]);
  const psProxy = await ERC1967Proxy.deploy(await psImpl.getAddress(), psInitData);
  await psProxy.waitForDeployment();
  const plaintextsStorage = PlaintextsStorage.attach(await psProxy.getAddress());

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
