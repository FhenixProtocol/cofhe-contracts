import type { OnChain, OnChain2 } from "../../types";
import hre from "hardhat";
const { ethers } = hre;

import { grantAllRoles } from "../../utils/roles";
import { installAddressBook, registerTaskManager } from "../helpers/addressBook";

export async function deployOnChainFixture(): Promise<{
  testContract: OnChain;
  testContract2: OnChain2;
  address: string;
  address2: string;
  taskManager: any;
  taskManagerAddress: string;
  acl: any;
  plaintextsStorage: any;
  addressBook: any;
}> {
  // Multiple test files install the address book at the same fixed address within the same
  // Hardhat network process; reset so `initialize` sees fresh storage.
  await ethers.provider.send("hardhat_reset", []);

  const [owner] = await ethers.getSigners();

  const addressBook = await installAddressBook(owner);

  // TaskManager: an ordinary proxy at whatever address it lands on, registered in the book.
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
  const taskManager = TaskManager.attach(taskManagerAddress) as any;
  await registerTaskManager(addressBook, taskManagerAddress);

  // Deploy ACL
  const ACL = await ethers.getContractFactory("ACL");
  const aclImpl = await ACL.deploy();
  await aclImpl.waitForDeployment();

  const aclInitData = ACL.interface.encodeFunctionData("initialize", [owner.address, 0, taskManagerAddress]);
  const aclProxy = await ERC1967Proxy.deploy(await aclImpl.getAddress(), aclInitData);
  await aclProxy.waitForDeployment();
  const acl = ACL.attach(await aclProxy.getAddress()) as any;

  // Deploy PlaintextsStorage
  const PlaintextsStorage = await ethers.getContractFactory("PlaintextsStorage");
  const psImpl = await PlaintextsStorage.deploy();
  await psImpl.waitForDeployment();

  const psInitData = PlaintextsStorage.interface.encodeFunctionData("initialize", [owner.address, 0, taskManagerAddress]);
  const psProxy = await ERC1967Proxy.deploy(await psImpl.getAddress(), psInitData);
  await psProxy.waitForDeployment();
  const plaintextsStorage = PlaintextsStorage.attach(await psProxy.getAddress()) as any;

  // `initialize` only grants DEFAULT_ADMIN_ROLE; mirror the deploy script and give the admin
  // every role, so the fixture stays correct when a contract gains a new one.
  await grantAllRoles(taskManager, owner, undefined, false);
  await grantAllRoles(acl, owner, undefined, false);
  await grantAllRoles(plaintextsStorage, owner, undefined, false);

  // Configure TaskManager
  await taskManager.setACLContract(await acl.getAddress());
  await taskManager.setPlaintextsStorage(await plaintextsStorage.getAddress());
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

  return { testContract, testContract2, address, address2, taskManager, taskManagerAddress, acl, plaintextsStorage, addressBook };
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
