import hre from "hardhat";
import { expect } from "chai";

const { ethers } = hre;

const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

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

  const storageSlots = [
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00",
    "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300",
    "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199301",
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

describe("PubliclyAllowed Tests", function () {
  let taskManager: any;
  let testContract: any;

  before(async function () {
    const [owner] = await ethers.getSigners();

    const TaskManager = await ethers.getContractFactory("TaskManager");
    const taskManagerImpl = await TaskManager.deploy();
    await taskManagerImpl.waitForDeployment();

    const initData = TaskManager.interface.encodeFunctionData("initialize", [owner.address]);
    await deployProxyAtAddress(TASK_MANAGER_ADDRESS, await taskManagerImpl.getAddress(), initData);
    taskManager = TaskManager.attach(TASK_MANAGER_ADDRESS);

    const ACL = await ethers.getContractFactory("ACL");
    const aclImpl = await ACL.deploy();
    await aclImpl.waitForDeployment();

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const aclInitData = ACL.interface.encodeFunctionData("initialize", [owner.address]);
    const aclProxy = await ERC1967Proxy.deploy(await aclImpl.getAddress(), aclInitData);
    await aclProxy.waitForDeployment();

    const PlaintextsStorage = await ethers.getContractFactory("PlaintextsStorage");
    const psImpl = await PlaintextsStorage.deploy();
    await psImpl.waitForDeployment();
    const psInitData = PlaintextsStorage.interface.encodeFunctionData("initialize", [owner.address]);
    const psProxy = await ERC1967Proxy.deploy(await psImpl.getAddress(), psInitData);
    await psProxy.waitForDeployment();

    await taskManager.setACLContract(await aclProxy.getAddress());
    await taskManager.setPlaintextsStorage(await psProxy.getAddress());
    await taskManager.setSecurityZones(-128, 127);

    const PubliclyAllowedTest = await ethers.getContractFactory("PubliclyAllowedTest");
    testContract = await PubliclyAllowedTest.connect(owner).deploy();
    await testContract.waitForDeployment();
  });

  describe("isPubliclyAllowed", function () {
    it("should return false for a handle that is not globally allowed", async function () {
      const tx = await testContract.createWithoutGlobal(42);
      await tx.wait();
      const handle = await testContract.lastHandle();
      expect(await taskManager.isPubliclyAllowed(handle)).to.equal(false);
    });

    it("should return true after allowGlobal is called", async function () {
      const tx = await testContract.createAndAllowGlobal(99);
      await tx.wait();
      const handle = await testContract.lastHandle();
      expect(await taskManager.isPubliclyAllowed(handle)).to.equal(true);
    });

    it("should return false for a non-existent handle", async function () {
      const fakeHandle = 12345;
      expect(await taskManager.isPubliclyAllowed(fakeHandle)).to.equal(false);
    });
  });

});
