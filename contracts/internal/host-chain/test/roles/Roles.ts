import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { deployOnChainFixture } from "../onChain/OnChain.fixture";

const { ethers } = hre;

const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

/** Every `*_ROLE` constant the contract declares, other than DEFAULT_ADMIN_ROLE. */
function declaredRoleNames(contract: any): string[] {
  return contract.interface.fragments
    .filter(
      (fragment: any) =>
        fragment.type === "function" &&
        fragment.inputs.length === 0 &&
        /^[A-Z0-9_]+_ROLE$/.test(fragment.name) &&
        fragment.name !== "DEFAULT_ADMIN_ROLE",
    )
    .map((fragment: any) => (fragment as any).name);
}

describe("Role-based access control", function () {
  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let taskManager: any;
  let acl: any;
  let plaintextsStorage: any;

  before(async function () {
    await deployOnChainFixture();
    [owner, other] = await ethers.getSigners();
    taskManager = await ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS);
    acl = await ethers.getContractAt("ACL", await taskManager.acl());
    plaintextsStorage = await ethers.getContractAt(
      "PlaintextsStorage",
      await taskManager.plaintextsStorage(),
    );
  });

  // The deploy scripts grant every declared role to the admin wallet. Asserting it here means a
  // role added to a contract without a matching grant fails the suite rather than the deployment.
  describe("admin wallet holds every declared role", function () {
    it("on TaskManager", async function () {
      const roleNames = declaredRoleNames(taskManager);
      expect(roleNames.length).to.be.greaterThan(0);
      for (const roleName of roleNames) {
        expect(await taskManager.hasRole(await taskManager[roleName](), owner.address), roleName)
          .to.equal(true);
      }
    });

    it("on ACL", async function () {
      for (const roleName of declaredRoleNames(acl)) {
        expect(await acl.hasRole(await acl[roleName](), owner.address), roleName).to.equal(true);
      }
    });

    it("on PlaintextsStorage", async function () {
      for (const roleName of declaredRoleNames(plaintextsStorage)) {
        expect(
          await plaintextsStorage.hasRole(await plaintextsStorage[roleName](), owner.address),
          roleName,
        ).to.equal(true);
      }
    });
  });

  describe("default admin", function () {
    it("is the admin wallet on every contract", async function () {
      expect(await taskManager.defaultAdmin()).to.equal(owner.address);
      expect(await acl.defaultAdmin()).to.equal(owner.address);
      expect(await plaintextsStorage.defaultAdmin()).to.equal(owner.address);
    });

    it("does not grant operational roles to anyone else", async function () {
      for (const roleName of declaredRoleNames(taskManager)) {
        expect(await taskManager.hasRole(await taskManager[roleName](), other.address), roleName)
          .to.equal(false);
      }
    });
  });

  // UPGRADER_ROLE is the one role with no other caller in the system, so it is the easiest to
  // forget to grant - and forgetting it leaves the proxy permanently un-upgradeable.
  describe("UPGRADER_ROLE gates upgrades", function () {
    it("lets a holder upgrade TaskManager", async function () {
      const TaskManager = await ethers.getContractFactory("TaskManager");
      const newImpl = await TaskManager.deploy();
      await newImpl.waitForDeployment();

      await expect(taskManager.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x"))
        .to.not.be.reverted;
    });

    it("rejects a non-holder", async function () {
      const TaskManager = await ethers.getContractFactory("TaskManager");
      const newImpl = await TaskManager.deploy();
      await newImpl.waitForDeployment();

      await expect(taskManager.connect(other).upgradeToAndCall(await newImpl.getAddress(), "0x"))
        .to.be.revertedWithCustomError(taskManager, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, await taskManager.UPGRADER_ROLE());
    });

    it("gates ACL and PlaintextsStorage upgrades too", async function () {
      const ACL = await ethers.getContractFactory("ACL");
      const newAclImpl = await ACL.deploy();
      await newAclImpl.waitForDeployment();
      await expect(acl.connect(other).upgradeToAndCall(await newAclImpl.getAddress(), "0x"))
        .to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, await acl.UPGRADER_ROLE());
      await expect(acl.connect(owner).upgradeToAndCall(await newAclImpl.getAddress(), "0x"))
        .to.not.be.reverted;

      const PlaintextsStorage = await ethers.getContractFactory("PlaintextsStorage");
      const newPsImpl = await PlaintextsStorage.deploy();
      await newPsImpl.waitForDeployment();
      await expect(
        plaintextsStorage.connect(other).upgradeToAndCall(await newPsImpl.getAddress(), "0x"),
      )
        .to.be.revertedWithCustomError(plaintextsStorage, "AccessControlUnauthorizedAccount")
        .withArgs(other.address, await plaintextsStorage.UPGRADER_ROLE());
      await expect(
        plaintextsStorage.connect(owner).upgradeToAndCall(await newPsImpl.getAddress(), "0x"),
      ).to.not.be.reverted;
    });
  });

  // Each setter is bound to its own role, so revoking one must not disturb the others.
  describe("roles are independent", function () {
    it("revoking PAUSER_ROLE does not affect CONFIG_MANAGER_ROLE", async function () {
      const pauserRole = await taskManager.PAUSER_ROLE();
      await taskManager.connect(owner).revokeRole(pauserRole, owner.address);

      await expect(taskManager.connect(owner).disable())
        .to.be.revertedWithCustomError(taskManager, "AccessControlUnauthorizedAccount")
        .withArgs(owner.address, pauserRole);
      await expect(taskManager.connect(owner).incVersion()).to.not.be.reverted;

      await taskManager.connect(owner).grantRole(pauserRole, owner.address);
    });

    it("does not let DEFAULT_ADMIN_ROLE stand in for an operational role", async function () {
      const securityZoneRole = await taskManager.SECURITY_ZONE_MANAGER_ROLE();
      await taskManager.connect(owner).revokeRole(securityZoneRole, owner.address);

      expect(await taskManager.defaultAdmin()).to.equal(owner.address);
      await expect(taskManager.connect(owner).setSecurityZones(-1, 1))
        .to.be.revertedWithCustomError(taskManager, "AccessControlUnauthorizedAccount")
        .withArgs(owner.address, securityZoneRole);

      await taskManager.connect(owner).grantRole(securityZoneRole, owner.address);
    });
  });

  // initializeV2 exists to migrate proxies coming from the pre-roles Ownable implementation. It
  // is unauthenticated, so it must be impossible to re-run against a proxy that already has an
  // admin - the deploy scripts rely on this plus an atomic upgradeToAndCall.
  describe("initializeV2 cannot hijack an initialized proxy", function () {
    it("reverts on TaskManager", async function () {
      await expect(taskManager.connect(other).initializeV2(0, other.address))
        .to.be.revertedWithCustomError(taskManager, "AccessControlEnforcedDefaultAdminRules");
    });

    it("reverts on ACL", async function () {
      await expect(acl.connect(other).initializeV2(0, other.address))
        .to.be.revertedWithCustomError(acl, "AccessControlEnforcedDefaultAdminRules");
    });

    it("reverts on PlaintextsStorage", async function () {
      await expect(plaintextsStorage.connect(other).initializeV2(0, other.address))
        .to.be.revertedWithCustomError(plaintextsStorage, "AccessControlEnforcedDefaultAdminRules");
    });
  });
});
