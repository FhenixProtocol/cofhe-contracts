import hre from "hardhat";
import { expect } from "chai";

const { ethers } = hre;

const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

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

describe("PubliclyAllowed Tests", function () {
  let taskManager: any;
  let testContract: any;

  before(async function () {
    // Multiple test files deploy TaskManager at the same hardcoded address within
    // the same Hardhat network process; reset so `initialize` sees fresh storage
    // (hardhat_setCode/hardhat_setStorageAt below only work on the Hardhat network).
    await ethers.provider.send("hardhat_reset", []);

    const [owner] = await ethers.getSigners();

    const TaskManager = await ethers.getContractFactory("TaskManager");
    const taskManagerImpl = await TaskManager.deploy();
    await taskManagerImpl.waitForDeployment();

    const initData = TaskManager.interface.encodeFunctionData("initialize", [owner.address, 0]);
    await deployProxyAtAddress(TASK_MANAGER_ADDRESS, await taskManagerImpl.getAddress(), initData);
    taskManager = TaskManager.attach(TASK_MANAGER_ADDRESS);

    const ACL = await ethers.getContractFactory("ACL");
    const aclImpl = await ACL.deploy();
    await aclImpl.waitForDeployment();

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const aclInitData = ACL.interface.encodeFunctionData("initialize", [owner.address, 0]);
    const aclProxy = await ERC1967Proxy.deploy(await aclImpl.getAddress(), aclInitData);
    await aclProxy.waitForDeployment();

    const PlaintextsStorage = await ethers.getContractFactory("PlaintextsStorage");
    const psImpl = await PlaintextsStorage.deploy();
    await psImpl.waitForDeployment();
    const psInitData = PlaintextsStorage.interface.encodeFunctionData("initialize", [owner.address, 0]);
    const psProxy = await ERC1967Proxy.deploy(await psImpl.getAddress(), psInitData);
    await psProxy.waitForDeployment();

    // Owner holds DEFAULT_ADMIN_ROLE from init; grant the operational roles it exercises.
    for (const role of [
      await taskManager.CONFIG_MANAGER_ROLE(),
      await taskManager.SECURITY_ZONE_MANAGER_ROLE(),
    ]) {
      await taskManager.grantRole(role, owner.address);
    }

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
