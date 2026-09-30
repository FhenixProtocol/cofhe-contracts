import hre from "hardhat";
const { ethers } = hre;
import { Wallet, BaseContract } from "ethers";

import { grantAllRoles } from "../../utils/roles";
import { installAddressBook, registerTaskManager } from "../helpers/addressBook";

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

export async function deployDecryptResultFixture(): Promise<DecryptResultFixture> {
  // Multiple test files install the address book at the same fixed address within the same
  // Hardhat network process; reset so `initialize` sees fresh storage.
  await ethers.provider.send("hardhat_reset", []);

  const [owner, otherAccount] = await ethers.getSigners();

  const addressBook = await installAddressBook(owner);

  const TaskManager = await ethers.getContractFactory("TaskManager");
  const taskManagerImpl = await TaskManager.deploy();
  await taskManagerImpl.waitForDeployment();

  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const tmProxy = await ERC1967Proxy.deploy(
    await taskManagerImpl.getAddress(),
    TaskManager.interface.encodeFunctionData("initialize", [owner.address, 0]),
  );
  await tmProxy.waitForDeployment();
  const taskManagerAddress = await tmProxy.getAddress();
  const taskManager = TaskManager.attach(taskManagerAddress);
  await registerTaskManager(addressBook, taskManagerAddress);

  // Deploy ACL
  const ACL = await ethers.getContractFactory("ACL");
  const aclImpl = await ACL.deploy();
  await aclImpl.waitForDeployment();

  const aclInitData = ACL.interface.encodeFunctionData("initialize", [owner.address, 0, taskManagerAddress]);
  const aclProxy = await ERC1967Proxy.deploy(await aclImpl.getAddress(), aclInitData);
  await aclProxy.waitForDeployment();
  const acl = ACL.attach(await aclProxy.getAddress());

  // Deploy PlaintextsStorage (real contract)
  const PlaintextsStorage = await ethers.getContractFactory("PlaintextsStorage");
  const psImpl = await PlaintextsStorage.deploy();
  await psImpl.waitForDeployment();

  const psInitData = PlaintextsStorage.interface.encodeFunctionData("initialize", [owner.address, 0, taskManagerAddress]);
  const psProxy = await ERC1967Proxy.deploy(await psImpl.getAddress(), psInitData);
  await psProxy.waitForDeployment();
  const plaintextsStorage = PlaintextsStorage.attach(await psProxy.getAddress());

  // `initialize` only grants DEFAULT_ADMIN_ROLE; mirror the deploy script and give the admin
  // every role, so the fixture stays correct when a contract gains a new one.
  await grantAllRoles(taskManager, owner, undefined, false);
  await grantAllRoles(acl, owner, undefined, false);
  await grantAllRoles(plaintextsStorage, owner, undefined, false);

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
