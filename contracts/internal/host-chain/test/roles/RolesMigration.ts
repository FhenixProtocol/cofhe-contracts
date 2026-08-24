import { expect } from "chai";
import hre, { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { migrateToRoles, preflight, resolveProxies } from "../../tasks/upgradeToRoles";

/**
 * End-to-end cover for `task:upgradeToRoles` - the migration of a chain that still runs the
 * pre-roles Ownable contracts and has no ACP infrastructure at all.
 *
 * The `Deterministic*` contracts stand in for the deployed pre-roles implementations: they are the
 * same shape (DeterministicTM and DeterministicACL are Ownable2Step, DeterministicPlaintextsStorage
 * is Ownable, all three gate `_authorizeUpgrade` on the owner), so a proxy bootstrapped on them
 * reproduces the state the task has to migrate - including the `openzeppelin.storage.Ownable`
 * namespace that `initializeV2` authorises against. Roles.ts uses the same technique at the
 * contract level; this covers the task that drives it.
 */
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * Slots holding the *fixture* TaskManager's `acl` and `plaintextsStorage` pointers.
 *
 * These are DeterministicTM's positions, not production's. It packs `initialized` (bool),
 * `securityZoneMax` and `securityZoneMin` (int32 each) and `aggregator` (address) all into slot 0 -
 * 9 bytes of the first three still leaves room for the 20-byte address - and declares no
 * `randomCounter`, so its pointers sit two slots below TaskManager's, where the committed
 * storage-layout snapshot puts `acl` at 3 and `plaintextsStorage` at 5.
 */
const FIXTURE_POINTER_SLOTS = { acl: 1, plaintextsStorage: 3 } as const;

/** Asserts a promise rejects with a message matching `matcher`. */
async function expectRejection(promise: Promise<unknown>, matcher: RegExp | string) {
  try {
    await promise;
  } catch (error: any) {
    const message: string = error?.message ?? String(error);
    if (typeof matcher === "string" ? message.includes(matcher) : matcher.test(message)) {
      return;
    }
    expect.fail(`Rejected as expected, but with the wrong message: ${message}`);
  }
  expect.fail(`Expected a rejection matching ${matcher}, but the promise resolved`);
}

/** Runs the migration with its progress logging muted, so test output stays readable. */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
  }
}

describe("Migration to role-based access control", function () {
  let legacyOwner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let addresses: { taskManager: string; acl: string; plaintextsStorage: string };

  /** Bootstraps a proxy on a pre-roles implementation owned by `legacyOwner`. */
  async function deployLegacyProxy(factoryName: string, initArgs: unknown[]) {
    const factory = await ethers.getContractFactory(factoryName);
    const implementation = await factory.deploy();
    await implementation.waitForDeployment();

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ERC1967Proxy.deploy(
      await implementation.getAddress(),
      factory.interface.encodeFunctionData("initialize", initArgs),
    );
    await proxy.waitForDeployment();
    return factory.attach(await proxy.getAddress()) as any;
  }

  beforeEach(async function () {
    [, , legacyOwner, stranger] = await ethers.getSigners();

    const acl = await deployLegacyProxy("DeterministicACL", [legacyOwner.address]);
    const plaintextsStorage = await deployLegacyProxy("DeterministicPlaintextsStorage", [
      legacyOwner.address,
    ]);
    const taskManager = await deployLegacyProxy("DeterministicTM", [legacyOwner.address]);

    await taskManager.connect(legacyOwner).setACLContract(await acl.getAddress());
    await taskManager
      .connect(legacyOwner)
      .setPlaintextsStorage(await plaintextsStorage.getAddress());

    addresses = {
      taskManager: await taskManager.getAddress(),
      acl: await acl.getAddress(),
      plaintextsStorage: await plaintextsStorage.getAddress(),
    };
  });

  describe("address discovery", function () {
    it("reads ACL and PlaintextsStorage off the pre-roles TaskManager", async function () {
      // The point of discovering rather than being told: this runs against a TaskManager that has
      // not been upgraded yet, so both getters must exist on the old implementation.
      const resolved = await resolveProxies(hre, addresses.taskManager);
      expect(resolved.acl).to.equal(addresses.acl);
      expect(resolved.plaintextsStorage).to.equal(addresses.plaintextsStorage);
    });

    it("rejects an address with no TaskManager on it", async function () {
      await expectRejection(resolveProxies(hre, stranger.address), "No TaskManager at");
    });
  });

  describe("preflight", function () {
    it("refuses a signer that is not the legacy owner, before any transaction", async function () {
      const before = await Promise.all(
        Object.values(addresses).map((a) => ethers.provider.getStorage(a, IMPLEMENTATION_SLOT)),
      );

      await expectRejection(quiet(() => migrateToRoles(hre, addresses, stranger, 0)), /is not it for/);

      // The refusal has to land before anything moves - that is the whole point of checking the
      // legacy owner up front rather than letting initializeV2 revert mid-migration.
      const after = await Promise.all(
        Object.values(addresses).map((a) => ethers.provider.getStorage(a, IMPLEMENTATION_SLOT)),
      );
      expect(after).to.deep.equal(before);
    });

    it("names every proxy the signer cannot migrate", async function () {
      const states = [
        { label: "ACL", factoryName: "ACL", address: addresses.acl, implementation: "0x", legacyOwner: legacyOwner.address, defaultAdmin: null },
        { label: "TaskManager", factoryName: "TaskManager", address: addresses.taskManager, implementation: "0x", legacyOwner: legacyOwner.address, defaultAdmin: null },
      ];
      await expectRejection(quiet(() => preflight(states, stranger, 0)), /ACL[\s\S]*TaskManager/);
    });
  });

  describe("--onlyvalidate", function () {
    it("sends no transactions", async function () {
      const before = await ethers.provider.getStorage(addresses.acl, IMPLEMENTATION_SLOT);
      await quiet(() => migrateToRoles(hre, addresses, legacyOwner, 0, true));
      expect(await ethers.provider.getStorage(addresses.acl, IMPLEMENTATION_SLOT)).to.equal(before);
    });
  });

  describe("after a full migration", function () {
    let taskManager: any;
    let acl: any;
    let plaintexts: any;
    let slotsBeforeMigration: Record<number, string>;

    beforeEach(async function () {
      slotsBeforeMigration = {};
      for (const slot of Object.values(FIXTURE_POINTER_SLOTS)) {
        slotsBeforeMigration[slot] = await ethers.provider.getStorage(addresses.taskManager, slot);
      }

      const result = await quiet(() => migrateToRoles(hre, addresses, legacyOwner, 0));
      ({ taskManager, acl, plaintexts } = result!);
    });

    it("makes the legacy owner the default admin on all three proxies", async function () {
      expect(await taskManager.defaultAdmin()).to.equal(legacyOwner.address);
      expect(await acl.defaultAdmin()).to.equal(legacyOwner.address);
      expect(await plaintexts.defaultAdmin()).to.equal(legacyOwner.address);
    });

    it("grants UPGRADER_ROLE, so no proxy is bricked", async function () {
      for (const proxy of [taskManager, acl, plaintexts]) {
        expect(await proxy.hasRole(await proxy.UPGRADER_ROLE(), legacyOwner.address)).to.be.true;
      }
    });

    it("grants the TaskManager's operational roles", async function () {
      for (const roleName of [
        "PAUSER_ROLE",
        "SECURITY_ZONE_MANAGER_ROLE",
        "ACCESS_LIST_MANAGER_ROLE",
        "VERIFIER_SIGNER_MANAGER_ROLE",
        "DECRYPT_SIGNER_MANAGER_ROLE",
        "CONFIG_MANAGER_ROLE",
      ]) {
        expect(await taskManager.hasRole(await taskManager[roleName](), legacyOwner.address)).to.be
          .true;
      }
    });

    it("deploys the ACP contracts and wires them into the ACL", async function () {
      const revoker = await acl.defaultRevokerContract();
      const shareRegistry = await acl.shareRegistry();
      expect(revoker).to.not.equal(ethers.ZeroAddress);
      expect(shareRegistry).to.not.equal(ethers.ZeroAddress);
      expect(await ethers.provider.getCode(revoker)).to.not.equal("0x");
      expect(await ethers.provider.getCode(shareRegistry)).to.not.equal("0x");
    });

    it("leaves the share registry usable by its admin", async function () {
      // The registry initializer takes the admin only - it is AccessControlUpgradeable, not
      // AccessControlDefaultAdminRules. Passing a delay reverts, which is what made the
      // deploy.ts path skip the registry entirely.
      const registry = (await ethers.getContractFactory("ACPShareRegistry")).attach(
        await acl.shareRegistry(),
      ) as any;
      expect(await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), legacyOwner.address)).to.be
        .true;
      expect(await registry.hasRole(await registry.UPGRADER_ROLE(), legacyOwner.address)).to.be.true;
    });

    it("does not disturb the TaskManager's ACL / PlaintextsStorage slots", async function () {
      // What the migration must never do is move these pointers, and initializeV2 promises not to
      // touch them. Reading them back through the new ABI cannot show that here - `acl()` and
      // `plaintextsStorage()` read the production slots 3 and 5, and the fixture stores its
      // pointers two slots lower, the documented bootstrap layout incompatibility that
      // `task:upgradeTM` skips layout validation for. So assert on the slots the fixture really
      // uses, and pin what they hold first.
      //
      // That precondition is the whole point. Aimed at the production slots this assertion
      // compared 0x0 to 0x0 - slot 5 is untouched in the fixture and slot 3 is its
      // `plaintextsStorage` rather than the `acl` it was believed to be - so it would have passed
      // over an initializeV2 that zero-wrote either pointer.
      for (const [name, slot] of Object.entries(FIXTURE_POINTER_SLOTS)) {
        const expected = ethers
          .zeroPadValue(addresses[name as keyof typeof FIXTURE_POINTER_SLOTS], 32)
          .toLowerCase();
        expect(slotsBeforeMigration[slot]).to.equal(expected);
        expect(await ethers.provider.getStorage(addresses.taskManager, slot)).to.equal(expected);
      }
    });

    it("migrates the ACL and PlaintextsStorage proxies in place", async function () {
      // Same proxy addresses as before: consumers holding these addresses keep working, and the
      // TaskManager needs no re-wiring.
      expect(await acl.getAddress()).to.equal(addresses.acl);
      expect(await plaintexts.getAddress()).to.equal(addresses.plaintextsStorage);
    });

    it("bumps the TaskManager version", async function () {
      expect(await taskManager.getVersion()).to.be.greaterThan(0);
    });

    it("leaves the signers fail-closed rather than in debug mode", async function () {
      // The bootstrap proxy never wrote these slots, so they read zero - the verification-disabled
      // sentinel. initializeV2 must reseed them; the task warns that they need re-setting.
      expect(await taskManager.verifierSigner()).to.equal(
        "0x0000000000000000000000000000000000000001",
      );
      expect(await taskManager.decryptResultSigner()).to.equal(
        "0x0000000000000000000000000000000000000001",
      );
    });

    it("lets the new admin upgrade the ACL through UPGRADER_ROLE", async function () {
      const factory = await ethers.getContractFactory("ACL");
      const next = await factory.deploy();
      await next.waitForDeployment();
      await expect(acl.connect(legacyOwner).upgradeToAndCall(await next.getAddress(), "0x")).to.not
        .be.reverted;
    });


    describe("re-running the task", function () {
      it("is idempotent and reuses the ACP contracts", async function () {
        const revoker = await acl.defaultRevokerContract();
        const shareRegistry = await acl.shareRegistry();
        const implementation = await ethers.provider.getStorage(
          addresses.acl,
          IMPLEMENTATION_SLOT,
        );

        await quiet(() => migrateToRoles(hre, addresses, legacyOwner, 0));

        // No orphaned ACP deployments, and no pointless implementation churn.
        expect(await acl.defaultRevokerContract()).to.equal(revoker);
        expect(await acl.shareRegistry()).to.equal(shareRegistry);
        expect(await ethers.provider.getStorage(addresses.acl, IMPLEMENTATION_SLOT)).to.equal(
          implementation,
        );
      });

      it("does not bump the version again", async function () {
        // `version` is a uint8 tracking the implementation generation. A resume or repair run
        // upgrades nothing, so bumping it would decouple it from the deployed implementation for
        // every off-chain reader - and walk a checked counter toward its revert ceiling.
        const version = await taskManager.getVersion();

        await quiet(() => migrateToRoles(hre, addresses, legacyOwner, 0));

        expect(await taskManager.getVersion()).to.equal(version);
      });

      it("repairs share-registry grants it finds missing", async function () {
        // The ACL pointer being set is not proof the registry is usable: a run that died between
        // deployProxy and grantAllRoles leaves it with no UPGRADER_ROLE holder, i.e. permanently
        // un-upgradeable. Taking the pointer as "already wired" and moving on would log success
        // over exactly that state.
        const registry = (await ethers.getContractFactory("ACPShareRegistry")).attach(
          await acl.shareRegistry(),
        ) as any;
        const upgraderRole = await registry.UPGRADER_ROLE();

        await registry.connect(legacyOwner).revokeRole(upgraderRole, legacyOwner.address);
        expect(await registry.hasRole(upgraderRole, legacyOwner.address)).to.be.false;

        await quiet(() => migrateToRoles(hre, addresses, legacyOwner, 0));

        expect(await registry.hasRole(upgraderRole, legacyOwner.address)).to.be.true;
      });

      it("refuses once the default admin is no longer the signer", async function () {
        // A migrated proxy is governed by roles, not by the legacy owner, so a re-run signed by
        // someone else must stop before the ACP setters revert.
        await expectRejection(
          quiet(() => migrateToRoles(hre, addresses, stranger, 0)),
          /Refusing to upgrade: default admin is/,
        );
      });
    });
  });
});

