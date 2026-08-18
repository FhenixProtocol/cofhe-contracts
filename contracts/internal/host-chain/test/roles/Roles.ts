import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { deployOnChainFixture } from "../onChain/OnChain.fixture";
import { getDefaultAdmin, requireDefaultAdminIsSignerOrUnset } from "../../utils/roles";

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
  // cannot be onlyRole-gated (there is no role holder yet), so it is gated on the owner the old
  // implementation left behind. A proxy that never ran an Ownable implementation has a zero legacy
  // owner and rejects the call outright.
  describe("initializeV2 cannot hijack an initialized proxy", function () {
    it("reverts on TaskManager", async function () {
      await expect(taskManager.connect(other).initializeV2(0, other.address))
        .to.be.revertedWithCustomError(taskManager, "NotLegacyOwner")
        .withArgs(other.address, ethers.ZeroAddress);
    });

    it("reverts on ACL", async function () {
      await expect(acl.connect(other).initializeV2(0, other.address))
        .to.be.revertedWithCustomError(acl, "NotLegacyOwner")
        .withArgs(other.address, ethers.ZeroAddress);
    });

    it("reverts on PlaintextsStorage", async function () {
      await expect(plaintextsStorage.connect(other).initializeV2(0, other.address))
        .to.be.revertedWithCustomError(plaintextsStorage, "NotLegacyOwner")
        .withArgs(other.address, ethers.ZeroAddress);
    });
  });

  // The dangerous state is not the already-migrated proxy above - it is the window a real migration
  // opens. A proxy coming off the Ownable implementation has `_initialized == 1`, so
  // `reinitializer(2)` passes, and a zero AccessControl namespace, so the inherited `_grantRole`
  // guard does not fire either. Reproduce that state exactly: bootstrap on DeterministicTM, then
  // `upgradeToAndCall(TaskManager, "0x")` - the non-atomic upgrade the deploy scripts avoid but
  // that a Safe or a manual `cast send` would produce.
  describe("initializeV2 during a non-atomic migration", function () {
    let migrating: any;
    let legacyOwner: HardhatEthersSigner;

    beforeEach(async function () {
      [, , legacyOwner] = await ethers.getSigners();

      const DeterministicTM = await ethers.getContractFactory("DeterministicTM");
      const legacyImpl = await DeterministicTM.deploy();
      await legacyImpl.waitForDeployment();

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const proxy = await ERC1967Proxy.deploy(
        await legacyImpl.getAddress(),
        DeterministicTM.interface.encodeFunctionData("initialize", [legacyOwner.address]),
      );
      await proxy.waitForDeployment();

      const TaskManager = await ethers.getContractFactory("TaskManager");
      const newImpl = await TaskManager.deploy();
      await newImpl.waitForDeployment();

      // Deliberately no migration calldata - this is the gap being tested.
      const legacyProxy = DeterministicTM.attach(await proxy.getAddress()) as any;
      await legacyProxy.connect(legacyOwner).upgradeToAndCall(await newImpl.getAddress(), "0x");

      migrating = TaskManager.attach(await proxy.getAddress());
    });

    it("leaves the proxy with no default admin", async function () {
      expect(await migrating.defaultAdmin()).to.equal(ethers.ZeroAddress);
    });

    it("rejects a stranger claiming DEFAULT_ADMIN_ROLE", async function () {
      await expect(migrating.connect(other).initializeV2(0, other.address))
        .to.be.revertedWithCustomError(migrating, "NotLegacyOwner")
        .withArgs(other.address, legacyOwner.address);
      expect(await migrating.defaultAdmin()).to.equal(ethers.ZeroAddress);
      expect(await migrating.hasRole(await migrating.DEFAULT_ADMIN_ROLE(), other.address))
        .to.equal(false);
    });

    it("lets the legacy owner complete the migration", async function () {
      await expect(migrating.connect(legacyOwner).initializeV2(0, legacyOwner.address))
        .to.not.be.reverted;
      expect(await migrating.defaultAdmin()).to.equal(legacyOwner.address);
    });

    it("cannot be replayed once migrated", async function () {
      await migrating.connect(legacyOwner).initializeV2(0, legacyOwner.address);
      await expect(migrating.connect(legacyOwner).initializeV2(0, other.address))
        .to.be.revertedWithCustomError(migrating, "InvalidInitialization");
    });
  });

  // The deploy scripts upgrade and then grant roles, which need UPGRADER_ROLE and
  // DEFAULT_ADMIN_ROLE respectively. A signer holding only the former would land the
  // implementation swap and then revert on the grants, leaving the proxy on new code with no
  // operational roles. `requireDefaultAdminIsSignerOrUnset` is the pre-flight check for that.
  describe("deploy-time default-admin guard", function () {
    it("passes when the signer is the default admin", async function () {
      const currentDefaultAdmin = await getDefaultAdmin(taskManager, ethers.ZeroAddress);
      expect(currentDefaultAdmin).to.equal(owner.address);
      expect(() => requireDefaultAdminIsSignerOrUnset(currentDefaultAdmin, owner)).to.not.throw();
    });

    it("passes when the proxy has no default admin yet", function () {
      expect(() => requireDefaultAdminIsSignerOrUnset(null, other)).to.not.throw();
    });

    it("throws when the default admin is someone else", async function () {
      const currentDefaultAdmin = await getDefaultAdmin(taskManager, ethers.ZeroAddress);
      expect(() => requireDefaultAdminIsSignerOrUnset(currentDefaultAdmin, other))
        .to.throw(/Refusing to upgrade: default admin is/);
    });

    it("compares addresses case-insensitively", function () {
      expect(() =>
        requireDefaultAdminIsSignerOrUnset(owner.address.toLowerCase(), {
          address: owner.address.toUpperCase().replace("0X", "0x"),
        }),
      ).to.not.throw();
    });
  });
});
