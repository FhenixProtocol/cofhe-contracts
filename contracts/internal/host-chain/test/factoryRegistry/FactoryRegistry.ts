import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { deployOnChainFixture } from "../onChain/OnChain.fixture";

const { ethers, upgrades } = hre;

const EUINT8 = 2;
const SECURITY_ZONE = 0;
const ADMIN_DELAY = 3 * 24 * 60 * 60;
const ETHEREUM_TX_GAS_CAP = 16_777_216n; // EIP-7825

async function deployFixture() {
  const fixture = await deployOnChainFixture();
  const signers = await ethers.getSigners();
  const [owner, factory, sub, worker, worker2, worker3, outsider, otherFactory] = signers;
  const tm: any = fixture.taskManager;
  await (await tm.connect(owner).enableAccessList()).wait();

  const Registry = await ethers.getContractFactory("FactoryRegistry");
  const registry: any = await upgrades.deployProxy(Registry, [owner.address, ADMIN_DELAY], {
    kind: "uups",
    initializer: "initialize",
  });
  await registry.waitForDeployment();
  await (await tm.connect(owner).grantRole(await tm.ACCESS_LIST_MANAGER_ROLE(), await registry.getAddress())).wait();

  return { tm, registry, addressBook: fixture.addressBook, owner, factory, sub, worker, worker2, worker3, outsider, otherFactory };
}

/** True when `signer` can send an FHE task, i.e. the TaskManager lets it through its access list. */
async function canSendTask(tm: any, signer: HardhatEthersSigner): Promise<boolean> {
  try {
    await tm.connect(signer).createRandomTask.staticCall(EUINT8, 1, SECURITY_ZONE);
    return true;
  } catch {
    return false;
  }
}

function randomAddresses(n: number): string[] {
  return Array.from({ length: n }, () => ethers.Wallet.createRandom().address);
}

describe("FactoryRegistry", function () {
  describe("approve", function () {
    it("lets only FACTORY_APPROVER_ROLE approve a factory, and gives it access", async function () {
      const { tm, registry, owner, factory, outsider } = await loadFixture(deployFixture);
      await expect(registry.connect(outsider).approveFactory(factory.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, await registry.FACTORY_APPROVER_ROLE());

      await expect(registry.connect(owner).approveFactory(factory.address))
        .to.emit(registry, "FactoryApproved")
        .withArgs(factory.address);
      expect(await tm.accessList(factory.address)).to.equal(true);
      expect(await registry.nodeOf(factory.address)).to.deep.equal([await registry.getAddress(), 0n]);
    });

    it("rejects an address that is registered, already on the list, or the registry", async function () {
      const { tm, registry, owner, factory, worker, outsider } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await registry.connect(factory).register([worker.address]);

      await expect(registry.connect(owner).approveFactory(worker.address)).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
      await tm.connect(owner).addToAccessList([outsider.address]);
      await expect(registry.connect(owner).approveFactory(outsider.address)).to.be.revertedWithCustomError(registry, "AlreadyOnAccessList");
      await expect(registry.connect(owner).approveFactory(await registry.getAddress())).to.be.revertedWithCustomError(registry, "InvalidChild");
    });
  });

  describe("register", function () {
    it("gives a registered child access; an unregistered caller stays blocked", async function () {
      const { tm, registry, owner, factory, worker, outsider } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);

      await expect(registry.connect(factory).register([worker.address]))
        .to.emit(registry, "Registered")
        .withArgs(worker.address, factory.address, factory.address);
      expect(await canSendTask(tm, worker)).to.equal(true);
      await expect(tm.connect(outsider).createRandomTask(EUINT8, 1, SECURITY_ZONE))
        .to.be.revertedWithCustomError(tm, "NotOnAccessList")
        .withArgs(outsider.address);
    });

    it("lets a registered child register its own children (inherit)", async function () {
      const { tm, registry, owner, factory, sub, worker } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await registry.connect(factory).register([sub.address]);

      await expect(registry.connect(sub).register([worker.address]))
        .to.emit(registry, "Registered")
        .withArgs(worker.address, sub.address, factory.address);
      expect(await registry.nodeOf(worker.address)).to.deep.equal([sub.address, 2n]);
      expect(await tm.accessList(worker.address)).to.equal(true);
      expect(await registry.treeSizeOf(factory.address)).to.equal(2n);
    });

    it("rejects a caller outside any tree", async function () {
      const { registry, outsider, worker } = await loadFixture(deployFixture);
      await expect(registry.connect(outsider).register([worker.address])).to.be.revertedWithCustomError(registry, "NotRegistered");
    });

    it("rejects a child that is already on the list by hand", async function () {
      const { tm, registry, owner, factory, worker } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await tm.connect(owner).addToAccessList([worker.address]);
      await expect(registry.connect(factory).register([worker.address])).to.be.revertedWithCustomError(registry, "AlreadyOnAccessList");
    });

    it("rejects a second parent, and a duplicate inside one batch", async function () {
      const { registry, owner, factory, otherFactory, worker } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await registry.connect(owner).approveFactory(otherFactory.address);
      await registry.connect(factory).register([worker.address]);

      await expect(registry.connect(otherFactory).register([worker.address])).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
      const [a] = randomAddresses(1);
      await expect(registry.connect(factory).register([a, a])).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });

    it("rejects the registry's own address, so no caller can rank above every root", async function () {
      const { registry, owner, factory } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await expect(registry.connect(factory).register([await registry.getAddress()])).to.be.revertedWithCustomError(registry, "InvalidChild");
      await expect(registry.connect(factory).register([ethers.ZeroAddress])).to.be.revertedWithCustomError(registry, "InvalidChild");
    });

    it("stops at MAX_DEPTH levels", async function () {
      const { registry, owner, factory } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      const chain = await Promise.all(Array.from({ length: 9 }, () => ethers.getImpersonatedSigner(ethers.Wallet.createRandom().address)));
      let parent: HardhatEthersSigner = factory;
      for (let level = 1; level <= 8; level++) {
        const child = chain[level - 1];
        await registry.connect(parent).register([child.address]);
        await owner.sendTransaction({ to: child.address, value: ethers.parseEther("1") });
        parent = child;
      }
      expect((await registry.nodeOf(parent.address))[1]).to.equal(8n);
      await expect(registry.connect(parent).register([chain[8].address])).to.be.revertedWithCustomError(registry, "MaxDepthExceeded");
    });

    it("stops at 500 live contracts per root, and the room comes back after unregister", async function () {
      const { registry, owner, factory } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      const addrs = randomAddresses(500);
      for (let i = 0; i < 500; i += 100) await registry.connect(factory).register(addrs.slice(i, i + 100));
      expect(await registry.treeSizeOf(factory.address)).to.equal(500n);

      await expect(registry.connect(factory).register(randomAddresses(1))).to.be.revertedWithCustomError(registry, "TreeFull");
      await registry.connect(factory).unregister(addrs[0]);
      expect(await registry.treeSizeOf(factory.address)).to.equal(499n);
      await expect(registry.connect(factory).register(randomAddresses(1))).to.not.be.reverted;
    });
  });

  describe("unregister", function () {
    it("removes the target and its whole subtree from the TaskManager list", async function () {
      const { tm, registry, owner, factory, sub, worker, worker2, worker3 } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await registry.connect(factory).register([sub.address, worker3.address]);
      await registry.connect(sub).register([worker.address, worker2.address]);

      await expect(registry.connect(factory).unregister(sub.address))
        .to.emit(registry, "Unregistered")
        .withArgs(sub.address, factory.address, 3n);
      for (const s of [sub, worker, worker2]) {
        expect(await tm.accessList(s.address)).to.equal(false);
        expect((await registry.nodeOf(s.address))[0]).to.equal(ethers.ZeroAddress);
      }
      expect(await tm.accessList(worker3.address)).to.equal(true);
      expect(await registry.treeSizeOf(factory.address)).to.equal(1n);
    });

    it("swap-and-pop keeps the moved sibling correct", async function () {
      const { tm, registry, owner, factory } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      const [a, b, c] = randomAddresses(3);
      await registry.connect(factory).register([a, b, c]);

      await registry.connect(factory).unregister(a); // c moves into a's slot
      await registry.connect(factory).unregister(c); // must find c at its new index
      expect(await tm.accessList(c)).to.equal(false);
      expect(await tm.accessList(b)).to.equal(true);
      expect(await registry.treeSizeOf(factory.address)).to.equal(1n);

      await expect(registry.connect(owner).unregister(factory.address))
        .to.emit(registry, "Unregistered")
        .withArgs(factory.address, owner.address, 2n); // the factory and b, nothing stale
    });

    it("deletes removed lists, so an address registered again starts empty", async function () {
      const { tm, registry, owner, factory, otherFactory, sub, worker } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await registry.connect(owner).approveFactory(otherFactory.address);
      await registry.connect(factory).register([sub.address]);
      await registry.connect(sub).register([worker.address]);
      await registry.connect(factory).unregister(sub.address);

      await registry.connect(otherFactory).register([sub.address]); // sub moves to another tree
      await expect(registry.connect(otherFactory).unregister(sub.address))
        .to.emit(registry, "Unregistered")
        .withArgs(sub.address, otherFactory.address, 1n);
      expect(await tm.accessList(worker.address)).to.equal(false);
    });

    it("lets an ancestor two levels up unregister a grandchild", async function () {
      const { tm, registry, owner, factory, sub, worker } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await registry.connect(factory).register([sub.address]);
      await registry.connect(sub).register([worker.address]);

      await expect(registry.connect(factory).unregister(worker.address))
        .to.emit(registry, "Unregistered")
        .withArgs(worker.address, factory.address, 1n);
      expect(await tm.accessList(worker.address)).to.equal(false);
      expect(await tm.accessList(sub.address)).to.equal(true);
      expect(await registry.treeSizeOf(factory.address)).to.equal(1n);
    });

    it("unregisters a full depth-8 chain from its top", async function () {
      const { tm, registry, owner, factory } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      const chain = await Promise.all(Array.from({ length: 8 }, () => ethers.getImpersonatedSigner(ethers.Wallet.createRandom().address)));
      let parent: HardhatEthersSigner = factory;
      for (const child of chain) {
        await registry.connect(parent).register([child.address]);
        await owner.sendTransaction({ to: child.address, value: ethers.parseEther("1") });
        parent = child;
      }

      await expect(registry.connect(factory).unregister(chain[0].address))
        .to.emit(registry, "Unregistered")
        .withArgs(chain[0].address, factory.address, 8n);
      for (const c of chain) expect(await tm.accessList(c.address)).to.equal(false);
      expect(await registry.treeSizeOf(factory.address)).to.equal(0n);
    });

    it("lets a contract unregister itself with its subtree", async function () {
      const { tm, registry, owner, factory, sub, worker } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await registry.connect(factory).register([sub.address]);
      await registry.connect(sub).register([worker.address]);

      await expect(registry.connect(sub).unregister(sub.address))
        .to.emit(registry, "Unregistered")
        .withArgs(sub.address, sub.address, 2n);
      expect(await tm.accessList(worker.address)).to.equal(false);
    });

    it("blocks a root that unregistered itself until it is approved again", async function () {
      const { registry, owner, factory, worker } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await registry.connect(factory).unregister(factory.address);

      await expect(registry.connect(factory).register([worker.address])).to.be.revertedWithCustomError(registry, "NotRegistered");
      await registry.connect(owner).approveFactory(factory.address);
      await expect(registry.connect(factory).register([worker.address])).to.not.be.reverted;
    });

    it("rejects a caller outside the target's tree", async function () {
      const { registry, owner, factory, otherFactory, worker, outsider } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await registry.connect(owner).approveFactory(otherFactory.address);
      await registry.connect(factory).register([worker.address]);

      await expect(registry.connect(otherFactory).unregister(worker.address)).to.be.revertedWithCustomError(registry, "NotAllowed");
      await expect(registry.connect(outsider).unregister(worker.address)).to.be.revertedWithCustomError(registry, "NotAllowed");
      await expect(registry.connect(worker).unregister(factory.address)).to.be.revertedWithCustomError(registry, "NotAllowed");
    });

    it("lets only REVOKER_ROLE unregister any contract, including a root", async function () {
      const { tm, registry, owner, factory, worker, outsider } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await registry.connect(factory).register([worker.address]);
      await expect(registry.connect(outsider).unregister(factory.address)).to.be.revertedWithCustomError(registry, "NotAllowed");
      await registry.connect(owner).grantRole(await registry.REVOKER_ROLE(), outsider.address);

      await expect(registry.connect(outsider).unregister(factory.address))
        .to.emit(registry, "Unregistered")
        .withArgs(factory.address, outsider.address, 2n);
      expect(await tm.accessList(factory.address)).to.equal(false);
      expect(await tm.accessList(worker.address)).to.equal(false);
    });

    it("rejects an address the registry does not know", async function () {
      const { tm, registry, owner, worker } = await loadFixture(deployFixture);
      await tm.connect(owner).addToAccessList([worker.address]);
      await expect(registry.connect(owner).unregister(worker.address)).to.be.revertedWithCustomError(registry, "NotRegistered");
      expect(await tm.accessList(worker.address)).to.equal(true); // a manual entry stays
    });

    it("unregisters a full tree of 500 within Ethereum's per-transaction gas cap", async function () {
      const { tm, registry, owner, factory } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      const addrs = randomAddresses(500);
      for (let i = 0; i < 500; i += 100) await registry.connect(factory).register(addrs.slice(i, i + 100));

      // A gas limit at the cap: the transaction must succeed within it.
      const receipt = await (await registry.connect(owner).unregister(factory.address, { gasLimit: ETHEREUM_TX_GAS_CAP })).wait();
      expect(receipt.status).to.equal(1);
      console.log(`      unregister of 500: ${receipt.gasUsed} gas used (after refunds)`);
      expect(await tm.accessList(addrs[0])).to.equal(false);
      expect(await tm.accessList(addrs[499])).to.equal(false);
    });
  });

  describe("constructor FHE", function () {
    it("lets a child use FHE in its constructor when its CREATE2 address was registered first", async function () {
      const { tm, registry, owner } = await loadFixture(deployFixture);
      const Factory = await ethers.getContractFactory("FactoryRegistryTestFactory");
      const factory: any = await Factory.deploy(await registry.getAddress());
      await registry.connect(owner).approveFactory(await factory.getAddress());
      const tmAddress = await tm.getAddress();

      await expect(factory.deployUnregistered(ethers.id("unregistered"), tmAddress)).to.be.reverted;
      const salt = ethers.id("child");
      const predicted = await factory.predict(salt, tmAddress);
      await expect(factory.deploy(salt, tmAddress)).to.not.be.reverted;
      expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
      expect(await tm.accessList(predicted)).to.equal(true);
    });
  });

  describe("admin", function () {
    it("cannot be initialized again, on the proxy or on the implementation", async function () {
      const { registry, outsider } = await loadFixture(deployFixture);
      await expect(registry.connect(outsider).initialize(outsider.address, 0)).to.be.revertedWithCustomError(registry, "InvalidInitialization");

      const implAddress = await upgrades.erc1967.getImplementationAddress(await registry.getAddress());
      const impl: any = await ethers.getContractAt("FactoryRegistry", implAddress);
      await expect(impl.connect(outsider).initialize(outsider.address, 0)).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("lets only DEFAULT_ADMIN_ROLE re-point the TaskManager; new registrations follow it", async function () {
      const { tm, registry, addressBook, owner, factory, worker, worker2, outsider } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await registry.connect(factory).register([worker.address]);

      const Mock = await ethers.getContractFactory("AccessListTaskManagerMock");
      const mock: any = await Mock.deploy();
      await (await addressBook.setTm(2, await mock.getAddress())).wait();

      await expect(registry.connect(outsider).setTaskManager(2)).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await expect(registry.connect(owner).setTaskManager(2))
        .to.emit(registry, "TaskManagerSet")
        .withArgs(await tm.getAddress(), await mock.getAddress());

      await registry.connect(factory).register([worker2.address]);
      expect(await mock.accessList(worker2.address)).to.equal(true);
      expect(await tm.accessList(worker2.address)).to.equal(false);
      expect(await tm.accessList(worker.address)).to.equal(true); // old entries are not moved
    });

    it("changes the default admin only through the two-step transfer after the delay", async function () {
      const { registry, owner, outsider } = await loadFixture(deployFixture);
      await registry.connect(owner).beginDefaultAdminTransfer(outsider.address);
      await expect(registry.connect(outsider).acceptDefaultAdminTransfer()).to.be.revertedWithCustomError(
        registry,
        "AccessControlEnforcedDefaultAdminDelay",
      );
      await time.increase(ADMIN_DELAY + 1);
      await registry.connect(outsider).acceptDefaultAdminTransfer();
      expect(await registry.defaultAdmin()).to.equal(outsider.address);
    });

    it("lets only UPGRADER_ROLE upgrade, and the upgrade keeps the tree", async function () {
      const { registry, owner, factory, worker, outsider } = await loadFixture(deployFixture);
      await registry.connect(owner).approveFactory(factory.address);
      await registry.connect(factory).register([worker.address]);

      const V2 = await ethers.getContractFactory("FactoryRegistryV2Mock");
      const impl = await V2.deploy();
      await expect(registry.connect(outsider).upgradeToAndCall(await impl.getAddress(), "0x"))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, await registry.UPGRADER_ROLE());

      const upgraded: any = await upgrades.upgradeProxy(await registry.getAddress(), V2, { kind: "uups" });
      expect(await upgraded.version()).to.equal(2n);
      expect(await upgraded.nodeOf(worker.address)).to.deep.equal([factory.address, 1n]);
      expect(await upgraded.treeSizeOf(factory.address)).to.equal(1n);
    });
  });
});
