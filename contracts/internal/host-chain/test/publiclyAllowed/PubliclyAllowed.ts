import hre from "hardhat";
import { expect } from "chai";

const { ethers } = hre;

import { grantAllRoles } from "../../utils/roles";
import { installAddressBook, registerTaskManager } from "../helpers/addressBook";

describe("PubliclyAllowed Tests", function () {
  let taskManager: any;
  let testContract: any;

  before(async function () {
    // Multiple test files install the address book at the same fixed address within the same
    // Hardhat network process; reset so `initialize` sees fresh storage.
    await ethers.provider.send("hardhat_reset", []);

    const [owner] = await ethers.getSigners();

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
    taskManager = TaskManager.attach(taskManagerAddress);
    await registerTaskManager(addressBook, taskManagerAddress);

    const ACL = await ethers.getContractFactory("ACL");
    const aclImpl = await ACL.deploy();
    await aclImpl.waitForDeployment();

    const aclInitData = ACL.interface.encodeFunctionData("initialize", [owner.address, 0, taskManagerAddress]);
    const aclProxy = await ERC1967Proxy.deploy(await aclImpl.getAddress(), aclInitData);
    await aclProxy.waitForDeployment();

    const PlaintextsStorage = await ethers.getContractFactory("PlaintextsStorage");
    const psImpl = await PlaintextsStorage.deploy();
    await psImpl.waitForDeployment();
    const psInitData = PlaintextsStorage.interface.encodeFunctionData("initialize", [owner.address, 0, taskManagerAddress]);
    const psProxy = await ERC1967Proxy.deploy(await psImpl.getAddress(), psInitData);
    await psProxy.waitForDeployment();

    // `initialize` only grants DEFAULT_ADMIN_ROLE; mirror the deploy script and give the admin
    // every role, so the fixture stays correct when a contract gains a new one.
    await grantAllRoles(taskManager, owner, undefined, false);
    await grantAllRoles(ACL.attach(await aclProxy.getAddress()), owner, undefined, false);
    await grantAllRoles(PlaintextsStorage.attach(await psProxy.getAddress()), owner, undefined, false);

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
