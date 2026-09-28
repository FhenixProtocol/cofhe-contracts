import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const { ethers } = hre;

describe("TaskManager binding on ACL and PlaintextsStorage", function () {
  let admin: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let tmA: HardhatEthersSigner;
  let tmB: HardhatEthersSigner;
  let ACL: any;
  let PlaintextsStorage: any;
  let ERC1967Proxy: any;

  async function deployBehindProxy(factory: any, initArgs: unknown[]) {
    const impl = await factory.deploy();
    await impl.waitForDeployment();
    const proxy = await ERC1967Proxy.deploy(
      await impl.getAddress(),
      factory.interface.encodeFunctionData("initialize", initArgs),
    );
    await proxy.waitForDeployment();
    return factory.attach(await proxy.getAddress());
  }

  beforeEach(async function () {
    await ethers.provider.send("hardhat_reset", []);
    [admin, other, tmA, tmB] = await ethers.getSigners();
    ACL = await ethers.getContractFactory("ACL");
    PlaintextsStorage = await ethers.getContractFactory("PlaintextsStorage");
    ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  });

  describe("ACL", function () {
    let acl: any;

    beforeEach(async function () {
      acl = await deployBehindProxy(ACL, [admin.address, 0, tmA.address]);
    });

    it("records the TaskManager from initialize", async function () {
      expect(await acl.getTaskManagerAddress()).to.equal(tmA.address);
    });

    it("rejects a zero TaskManager in initialize", async function () {
      const impl = await ACL.deploy();
      await impl.waitForDeployment();
      await expect(
        ERC1967Proxy.deploy(
          await impl.getAddress(),
          ACL.interface.encodeFunctionData("initialize", [admin.address, 0, ethers.ZeroAddress]),
        ),
      ).to.be.revertedWithCustomError(ACL, "InvalidTaskManagerAddress");
    });

    it("lets only the TaskManager call allowTransient", async function () {
      await expect(acl.connect(tmA).allowTransient(1, other.address, tmA.address)).to.not.be.reverted;
      await expect(acl.connect(other).allowTransient(1, other.address, other.address))
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(other.address);
    });

    it("setTaskManager switches the authorized caller and emits", async function () {
      await expect(acl.connect(admin).setTaskManager(tmB.address))
        .to.emit(acl, "TaskManagerUpdated")
        .withArgs(tmA.address, tmB.address);
      expect(await acl.getTaskManagerAddress()).to.equal(tmB.address);
      await expect(acl.connect(tmA).allowTransient(1, other.address, tmA.address))
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(tmA.address);
      await expect(acl.connect(tmB).allowTransient(1, other.address, tmB.address)).to.not.be.reverted;
    });

    it("setTaskManager rejects the zero address", async function () {
      await expect(acl.connect(admin).setTaskManager(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        acl,
        "InvalidTaskManagerAddress",
      );
    });

    it("setTaskManager requires DEFAULT_ADMIN_ROLE", async function () {
      await expect(acl.connect(other).setTaskManager(tmB.address)).to.be.revertedWithCustomError(
        acl,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("PlaintextsStorage", function () {
    let pts: any;

    beforeEach(async function () {
      pts = await deployBehindProxy(PlaintextsStorage, [admin.address, 0, tmA.address]);
    });

    it("records the TaskManager from initialize", async function () {
      expect(await pts.getTaskManagerAddress()).to.equal(tmA.address);
    });

    it("rejects a zero TaskManager in initialize", async function () {
      const impl = await PlaintextsStorage.deploy();
      await impl.waitForDeployment();
      await expect(
        ERC1967Proxy.deploy(
          await impl.getAddress(),
          PlaintextsStorage.interface.encodeFunctionData("initialize", [admin.address, 0, ethers.ZeroAddress]),
        ),
      ).to.be.revertedWithCustomError(PlaintextsStorage, "InvalidTaskManagerAddress");
    });

    it("lets only the TaskManager store results", async function () {
      await expect(pts.connect(tmA).storeResult(1, 2)).to.not.be.reverted;
      const [value, exists] = await pts.getResult(1);
      expect(value).to.equal(2n);
      expect(exists).to.equal(true);
      await expect(pts.connect(other).storeResult(3, 4))
        .to.be.revertedWithCustomError(pts, "OnlyTaskManagerAllowed")
        .withArgs(other.address);
    });

    it("setTaskManager switches the authorized caller and emits", async function () {
      await expect(pts.connect(admin).setTaskManager(tmB.address))
        .to.emit(pts, "TaskManagerUpdated")
        .withArgs(tmA.address, tmB.address);
      await expect(pts.connect(tmA).storeResult(1, 2))
        .to.be.revertedWithCustomError(pts, "OnlyTaskManagerAllowed")
        .withArgs(tmA.address);
      await expect(pts.connect(tmB).storeResult(1, 2)).to.not.be.reverted;
    });

    it("setTaskManager rejects the zero address", async function () {
      await expect(pts.connect(admin).setTaskManager(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        pts,
        "InvalidTaskManagerAddress",
      );
    });

    it("setTaskManager requires DEFAULT_ADMIN_ROLE", async function () {
      await expect(pts.connect(other).setTaskManager(tmB.address)).to.be.revertedWithCustomError(
        pts,
        "AccessControlUnauthorizedAccount",
      );
    });
  });
});
