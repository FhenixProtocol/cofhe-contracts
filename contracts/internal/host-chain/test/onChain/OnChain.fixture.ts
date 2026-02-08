import type { OnChain, OnChain2 } from "../../types";
import hre from "hardhat";
const { ethers } = hre;

// The hardcoded TaskManager address that ACL and PlaintextsStorage expect
const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

/**
 * Deploy a proxy at a specific address using hardhat_setCode
 */
async function deployProxyAtAddress(
  targetAddress: string,
  implementationAddress: string,
  initData: string
): Promise<void> {
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const tempProxy = await ERC1967Proxy.deploy(implementationAddress, initData);
  await tempProxy.waitForDeployment();

  const proxyBytecode = await ethers.provider.getCode(await tempProxy.getAddress());
  await ethers.provider.send("hardhat_setCode", [targetAddress, proxyBytecode]);

  // Storage slots to copy (ERC1967 + OZ v5 namespaced storage)
  const storageSlots = [
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", // ERC1967 implementation
    "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00", // OZ Initializable
    "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300", // OZ Ownable
    "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199301", // OZ Ownable2Step pending
    // TaskManager storage slots
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

export async function deployOnChainFixture(): Promise<{
  testContract: OnChain;
  testContract2: OnChain2;
  address: string;
  address2: string;
}> {
  const [owner] = await ethers.getSigners();

  // Deploy TaskManager implementation
  const TaskManager = await ethers.getContractFactory("TaskManager");
  const taskManagerImpl = await TaskManager.deploy();
  await taskManagerImpl.waitForDeployment();

  // Prepare init data and deploy at hardcoded address
  const initData = TaskManager.interface.encodeFunctionData("initialize", [owner.address]);
  await deployProxyAtAddress(TASK_MANAGER_ADDRESS, await taskManagerImpl.getAddress(), initData);

  // Get TaskManager at the hardcoded address
  const taskManager = TaskManager.attach(TASK_MANAGER_ADDRESS);

  // Deploy ACL
  const ACL = await ethers.getContractFactory("ACL");
  const aclImpl = await ACL.deploy();
  await aclImpl.waitForDeployment();

  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const aclInitData = ACL.interface.encodeFunctionData("initialize", [owner.address]);
  const aclProxy = await ERC1967Proxy.deploy(await aclImpl.getAddress(), aclInitData);
  await aclProxy.waitForDeployment();

  // Deploy PlaintextsStorage
  const PlaintextsStorage = await ethers.getContractFactory("PlaintextsStorage");
  const psImpl = await PlaintextsStorage.deploy();
  await psImpl.waitForDeployment();

  const psInitData = PlaintextsStorage.interface.encodeFunctionData("initialize", [owner.address]);
  const psProxy = await ERC1967Proxy.deploy(await psImpl.getAddress(), psInitData);
  await psProxy.waitForDeployment();

  // Configure TaskManager
  await taskManager.setACLContract(await aclProxy.getAddress());
  await taskManager.setPlaintextsStorage(await psProxy.getAddress());
  await taskManager.setSecurityZones(-128, 127);

  // Deploy OnChain test contracts
  const OnChain = await ethers.getContractFactory("OnChain");
  const OnChain2 = await ethers.getContractFactory("OnChain2");

  const testContract = await OnChain.connect(owner).deploy();
  await testContract.waitForDeployment();

  const testContract2 = await OnChain2.connect(owner).deploy();
  await testContract2.waitForDeployment();

  const address = await testContract.getAddress();
  const address2 = await testContract2.getAddress();

  return { testContract, testContract2, address, address2 };
}

export async function getTokensFromFaucet() {
  // No-op for Hardhat network - only needed for localfhenix
  if (hre.network.name === "localfhenix") {
    const signers = await ethers.getSigners();
    if ((await ethers.provider.getBalance(signers[0].address)).toString() === "0") {
      await (hre as any).fhenixjs.getFunds(signers[0].address);
    }
  }
}
