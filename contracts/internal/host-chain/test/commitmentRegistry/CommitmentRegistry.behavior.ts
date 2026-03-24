import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

function randomBytes32(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

const VersionStatus = {
  Unset: 0,
  Active: 1,
  Deprecated: 2,
  Revoked: 3,
};

export function shouldBehaveLikeCommitmentRegistry(): void {
  const VERSION_1 = ethers.keccak256(ethers.toUtf8Bytes("version-1"));
  const VERSION_2 = ethers.keccak256(ethers.toUtf8Bytes("version-2"));

  // ── Initialization ──────────────────────────────────────────────────

  describe("Initialization", function () {
    it("should set the correct owner", async function () {
      expect(await this.registry.owner()).to.equal(this.owner.address);
    });

    it("should set the correct poster", async function () {
      expect(await this.registry.getPoster()).to.equal(this.poster.address);
    });

    it("should not be re-initializable", async function () {
      await expect(
        this.registry.initialize(this.owner.address, this.poster.address)
      ).to.be.reverted;
    });

    it("should revert when initializing the bare implementation directly", async function () {
      const CommitmentRegistry = await ethers.getContractFactory("CommitmentRegistry");
      const impl = await CommitmentRegistry.deploy();
      await impl.waitForDeployment();

      await expect(
        impl.initialize(this.owner.address, this.poster.address)
      ).to.be.reverted;
    });

    it("should revert when initializing with zero owner", async function () {
      const CommitmentRegistry = await ethers.getContractFactory("CommitmentRegistry");
      const impl = await CommitmentRegistry.deploy();
      await impl.waitForDeployment();
      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const initData = CommitmentRegistry.interface.encodeFunctionData("initialize", [
        ethers.ZeroAddress,
        this.poster.address,
      ]);
      await expect(
        ERC1967Proxy.deploy(await impl.getAddress(), initData)
      ).to.be.reverted;
    });

    it("should revert when initializing with zero poster", async function () {
      const CommitmentRegistry = await ethers.getContractFactory("CommitmentRegistry");
      const impl = await CommitmentRegistry.deploy();
      await impl.waitForDeployment();
      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const initData = CommitmentRegistry.interface.encodeFunctionData("initialize", [
        this.owner.address,
        ethers.ZeroAddress,
      ]);
      await expect(
        ERC1967Proxy.deploy(await impl.getAddress(), initData)
      ).to.be.reverted;
    });
  });

  // ── Version Lifecycle ───────────────────────────────────────────────

  describe("Version Lifecycle", function () {
    it("should start with Unset status for unknown versions", async function () {
      expect(await this.registry.getVersionStatus(VERSION_1)).to.equal(VersionStatus.Unset);
    });

    it("should allow Unset -> Active", async function () {
      await expect(this.registry.setVersionStatus(VERSION_1, VersionStatus.Active))
        .to.emit(this.registry, "VersionStatusChanged")
        .withArgs(VERSION_1, VersionStatus.Unset, VersionStatus.Active);
      expect(await this.registry.getVersionStatus(VERSION_1)).to.equal(VersionStatus.Active);
    });

    it("should allow Active -> Deprecated", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      await expect(this.registry.setVersionStatus(VERSION_1, VersionStatus.Deprecated))
        .to.emit(this.registry, "VersionStatusChanged")
        .withArgs(VERSION_1, VersionStatus.Active, VersionStatus.Deprecated);
      expect(await this.registry.getVersionStatus(VERSION_1)).to.equal(VersionStatus.Deprecated);
    });

    it("should allow Active -> Revoked", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      await expect(this.registry.setVersionStatus(VERSION_1, VersionStatus.Revoked))
        .to.emit(this.registry, "VersionStatusChanged")
        .withArgs(VERSION_1, VersionStatus.Active, VersionStatus.Revoked);
      expect(await this.registry.getVersionStatus(VERSION_1)).to.equal(VersionStatus.Revoked);
    });

    it("should allow Deprecated -> Revoked", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Deprecated);
      await expect(this.registry.setVersionStatus(VERSION_1, VersionStatus.Revoked))
        .to.emit(this.registry, "VersionStatusChanged")
        .withArgs(VERSION_1, VersionStatus.Deprecated, VersionStatus.Revoked);
      expect(await this.registry.getVersionStatus(VERSION_1)).to.equal(VersionStatus.Revoked);
    });

    it("should revert on Unset -> Unset", async function () {
      await expect(
        this.registry.setVersionStatus(VERSION_1, VersionStatus.Unset)
      ).to.be.revertedWithCustomError(this.registry, "InvalidVersionTransition")
        .withArgs(VERSION_1, VersionStatus.Unset, VersionStatus.Unset);
    });

    it("should revert on Unset -> Deprecated", async function () {
      await expect(
        this.registry.setVersionStatus(VERSION_1, VersionStatus.Deprecated)
      ).to.be.revertedWithCustomError(this.registry, "InvalidVersionTransition")
        .withArgs(VERSION_1, VersionStatus.Unset, VersionStatus.Deprecated);
    });

    it("should revert on Unset -> Revoked", async function () {
      await expect(
        this.registry.setVersionStatus(VERSION_1, VersionStatus.Revoked)
      ).to.be.revertedWithCustomError(this.registry, "InvalidVersionTransition")
        .withArgs(VERSION_1, VersionStatus.Unset, VersionStatus.Revoked);
    });

    it("should revert on Deprecated -> Active (no resurrection)", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Deprecated);
      await expect(
        this.registry.setVersionStatus(VERSION_1, VersionStatus.Active)
      ).to.be.revertedWithCustomError(this.registry, "InvalidVersionTransition")
        .withArgs(VERSION_1, VersionStatus.Deprecated, VersionStatus.Active);
    });

    it("should revert on Revoked -> Active (no resurrection)", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Revoked);
      await expect(
        this.registry.setVersionStatus(VERSION_1, VersionStatus.Active)
      ).to.be.revertedWithCustomError(this.registry, "InvalidVersionTransition")
        .withArgs(VERSION_1, VersionStatus.Revoked, VersionStatus.Active);
    });

    it("should revert on Revoked -> Deprecated", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Revoked);
      await expect(
        this.registry.setVersionStatus(VERSION_1, VersionStatus.Deprecated)
      ).to.be.revertedWithCustomError(this.registry, "InvalidVersionTransition")
        .withArgs(VERSION_1, VersionStatus.Revoked, VersionStatus.Deprecated);
    });

    it("should revert on Active -> Active (no-op)", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      await expect(
        this.registry.setVersionStatus(VERSION_1, VersionStatus.Active)
      ).to.be.revertedWithCustomError(this.registry, "InvalidVersionTransition")
        .withArgs(VERSION_1, VersionStatus.Active, VersionStatus.Active);
    });

    it("should revert when non-owner sets version status", async function () {
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.setVersionStatus(VERSION_1, VersionStatus.Active)
      ).to.be.revertedWithCustomError(this.registry, "OwnableUnauthorizedAccount");
    });
  });

  // ── Poster Management ──────────────────────────────────────────────

  describe("Poster Management", function () {
    it("should allow owner to change poster", async function () {
      await expect(this.registry.setPoster(this.otherAccount.address))
        .to.emit(this.registry, "PosterChanged")
        .withArgs(this.poster.address, this.otherAccount.address);
      expect(await this.registry.getPoster()).to.equal(this.otherAccount.address);
    });

    it("should revoke old poster access after rotation", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      await this.registry.setPoster(this.otherAccount.address);

      // Old poster should fail
      const registryAsOldPoster = this.registry.connect(this.poster);
      await expect(
        registryAsOldPoster.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()])
      ).to.be.revertedWithCustomError(this.registry, "OnlyPosterAllowed");

      // New poster should succeed
      const registryAsNewPoster = this.registry.connect(this.otherAccount);
      await expect(
        registryAsNewPoster.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()])
      ).to.not.be.reverted;
    });

    it("should allow setting poster to the same address (no-op)", async function () {
      await expect(this.registry.setPoster(this.poster.address))
        .to.emit(this.registry, "PosterChanged")
        .withArgs(this.poster.address, this.poster.address);
      expect(await this.registry.getPoster()).to.equal(this.poster.address);
    });

    it("should revert when setting poster to zero address", async function () {
      await expect(
        this.registry.setPoster(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(this.registry, "InvalidAddress");
    });

    it("should revert when non-owner sets poster", async function () {
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.setPoster(this.otherAccount.address)
      ).to.be.revertedWithCustomError(this.registry, "OwnableUnauthorizedAccount");
    });
  });

  // ── Ownership Transfer (Two-Step) ──────────────────────────────────

  describe("Ownership Transfer", function () {
    it("should not change owner immediately on transferOwnership", async function () {
      await this.registry.transferOwnership(this.otherAccount.address);
      expect(await this.registry.owner()).to.equal(this.owner.address);
    });

    it("should change owner after acceptOwnership", async function () {
      await this.registry.transferOwnership(this.otherAccount.address);
      const registryAsOther = this.registry.connect(this.otherAccount);
      await registryAsOther.acceptOwnership();
      expect(await this.registry.owner()).to.equal(this.otherAccount.address);
    });

    it("should allow new owner to call protected functions", async function () {
      await this.registry.transferOwnership(this.otherAccount.address);
      const registryAsOther = this.registry.connect(this.otherAccount);
      await registryAsOther.acceptOwnership();

      await expect(
        registryAsOther.setVersionStatus(VERSION_1, VersionStatus.Active)
      ).to.not.be.reverted;
    });
  });

  // ── Post Commitments ───────────────────────────────────────────────

  describe("Post Commitments", function () {
    beforeEach(async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
    });

    it("should post a single commitment", async function () {
      const handle = randomBytes32();
      const ctHash = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);

      await expect(registryAsPoster.postCommitments(VERSION_1, [handle], [ctHash]))
        .to.emit(this.registry, "CommitmentsPosted")
        .withArgs(VERSION_1, 1);

      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(ctHash);
      expect(await this.registry.getSize(VERSION_1)).to.equal(1);
    });

    it("should post a batch of 10 commitments", async function () {
      const handles = Array.from({ length: 10 }, () => randomBytes32());
      const ctHashes = Array.from({ length: 10 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);

      await expect(registryAsPoster.postCommitments(VERSION_1, handles, ctHashes))
        .to.emit(this.registry, "CommitmentsPosted")
        .withArgs(VERSION_1, 10);

      for (let i = 0; i < 10; i++) {
        expect(await this.registry.getCommitment(VERSION_1, handles[i])).to.equal(ctHashes[i]);
      }
      expect(await this.registry.getSize(VERSION_1)).to.equal(10);
    });

    it("should post a batch of 50 commitments", async function () {
      const handles = Array.from({ length: 50 }, () => randomBytes32());
      const ctHashes = Array.from({ length: 50 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);

      await expect(registryAsPoster.postCommitments(VERSION_1, handles, ctHashes))
        .to.emit(this.registry, "CommitmentsPosted")
        .withArgs(VERSION_1, 50);

      expect(await this.registry.getCommitment(VERSION_1, handles[0])).to.equal(ctHashes[0]);
      expect(await this.registry.getCommitment(VERSION_1, handles[49])).to.equal(ctHashes[49]);
      expect(await this.registry.getSize(VERSION_1)).to.equal(50);
    });

    it("should accumulate count across multiple batches", async function () {
      const registryAsPoster = this.registry.connect(this.poster);

      const handles1 = Array.from({ length: 5 }, () => randomBytes32());
      const ctHashes1 = Array.from({ length: 5 }, () => randomBytes32());
      await registryAsPoster.postCommitments(VERSION_1, handles1, ctHashes1);

      const handles2 = Array.from({ length: 3 }, () => randomBytes32());
      const ctHashes2 = Array.from({ length: 3 }, () => randomBytes32());
      await registryAsPoster.postCommitments(VERSION_1, handles2, ctHashes2);

      expect(await this.registry.getSize(VERSION_1)).to.equal(8);
    });

    it("should keep versions isolated", async function () {
      await this.registry.setVersionStatus(VERSION_2, VersionStatus.Active);
      const registryAsPoster = this.registry.connect(this.poster);

      const handle = randomBytes32();
      const ctHash1 = randomBytes32();
      const ctHash2 = randomBytes32();

      await registryAsPoster.postCommitments(VERSION_1, [handle], [ctHash1]);
      await registryAsPoster.postCommitments(VERSION_2, [handle], [ctHash2]);

      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(ctHash1);
      expect(await this.registry.getCommitment(VERSION_2, handle)).to.equal(ctHash2);
    });
  });

  // ── Write-Once Enforcement ─────────────────────────────────────────

  describe("Write-Once Enforcement", function () {
    beforeEach(async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
    });

    it("should revert when overwriting an existing commitment", async function () {
      const handle = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);

      await registryAsPoster.postCommitments(VERSION_1, [handle], [randomBytes32()]);

      await expect(
        registryAsPoster.postCommitments(VERSION_1, [handle], [randomBytes32()])
      ).to.be.revertedWithCustomError(this.registry, "CommitmentAlreadyExists")
        .withArgs(VERSION_1, handle);
    });

    it("should revert entire batch if any handle is duplicate (existing)", async function () {
      const handle1 = randomBytes32();
      const handle2 = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);

      await registryAsPoster.postCommitments(VERSION_1, [handle1], [randomBytes32()]);

      // Batch with handle1 (existing) and handle2 (new) should revert entirely
      await expect(
        registryAsPoster.postCommitments(
          VERSION_1,
          [handle1, handle2],
          [randomBytes32(), randomBytes32()]
        )
      ).to.be.revertedWithCustomError(this.registry, "CommitmentAlreadyExists")
        .withArgs(VERSION_1, handle1);

      // handle2 should NOT have been written since batch reverted
      expect(await this.registry.getCommitment(VERSION_1, handle2)).to.equal(ethers.ZeroHash);
    });

    it("should revert if duplicate handles within same batch", async function () {
      const handle = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);

      await expect(
        registryAsPoster.postCommitments(
          VERSION_1,
          [handle, handle],
          [randomBytes32(), randomBytes32()]
        )
      ).to.be.revertedWithCustomError(this.registry, "CommitmentAlreadyExists")
        .withArgs(VERSION_1, handle);
    });
  });

  // ── Access Control ─────────────────────────────────────────────────

  describe("Access Control", function () {
    beforeEach(async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
    });

    it("should revert when non-poster posts commitments", async function () {
      const registryAsOther = this.registry.connect(this.otherAccount);
      await expect(
        registryAsOther.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()])
      ).to.be.revertedWithCustomError(this.registry, "OnlyPosterAllowed")
        .withArgs(this.otherAccount.address);
    });

    it("should revert when owner (non-poster) posts commitments", async function () {
      await expect(
        this.registry.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()])
      ).to.be.revertedWithCustomError(this.registry, "OnlyPosterAllowed");
    });
  });

  // ── Input Validation ───────────────────────────────────────────────

  describe("Input Validation", function () {
    beforeEach(async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
    });

    it("should revert on empty batch", async function () {
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.postCommitments(VERSION_1, [], [])
      ).to.be.revertedWithCustomError(this.registry, "EmptyBatch");
    });

    it("should revert on length mismatch", async function () {
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32(), randomBytes32()])
      ).to.be.revertedWithCustomError(this.registry, "LengthMismatch");
    });

    it("should revert on zero ctHash", async function () {
      const handle = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.postCommitments(VERSION_1, [handle], [ethers.ZeroHash])
      ).to.be.revertedWithCustomError(this.registry, "ZeroCtHash")
        .withArgs(handle);
    });

    it("should revert on zero ctHash mid-batch and not persist earlier items", async function () {
      const handle1 = randomBytes32();
      const handle2 = randomBytes32();
      const handle3 = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);

      await expect(
        registryAsPoster.postCommitments(
          VERSION_1,
          [handle1, handle2, handle3],
          [randomBytes32(), ethers.ZeroHash, randomBytes32()]
        )
      ).to.be.revertedWithCustomError(this.registry, "ZeroCtHash")
        .withArgs(handle2);

      // First item should not be persisted due to revert
      expect(await this.registry.getCommitment(VERSION_1, handle1)).to.equal(ethers.ZeroHash);
    });

    it("should revert when version is not Active (Unset)", async function () {
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.postCommitments(VERSION_2, [randomBytes32()], [randomBytes32()])
      ).to.be.revertedWithCustomError(this.registry, "VersionNotActive")
        .withArgs(VERSION_2);
    });

    it("should revert when version is Deprecated", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Deprecated);
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()])
      ).to.be.revertedWithCustomError(this.registry, "VersionNotActive")
        .withArgs(VERSION_1);
    });

    it("should revert when version is Revoked", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Revoked);
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()])
      ).to.be.revertedWithCustomError(this.registry, "VersionNotActive")
        .withArgs(VERSION_1);
    });
  });

  // ── View Functions ─────────────────────────────────────────────────

  describe("View Functions", function () {
    it("should return zero hash for non-existent commitment", async function () {
      expect(await this.registry.getCommitment(VERSION_1, randomBytes32())).to.equal(ethers.ZeroHash);
    });

    it("should return zero size for unused version", async function () {
      expect(await this.registry.getSize(VERSION_1)).to.equal(0);
    });

    it("should still return commitments after version is Deprecated", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      const handle = randomBytes32();
      const ctHash = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, [handle], [ctHash]);

      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Deprecated);

      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(ctHash);
      expect(await this.registry.getSize(VERSION_1)).to.equal(1);
    });

    it("should still return commitments after version is Revoked", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      const handle = randomBytes32();
      const ctHash = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, [handle], [ctHash]);

      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Revoked);

      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(ctHash);
      expect(await this.registry.getSize(VERSION_1)).to.equal(1);
    });
  });

  // ── Gas Measurement ────────────────────────────────────────────────

  describe("Gas Measurement", function () {
    beforeEach(async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
    });

    it("GAS: post 1 commitment", async function () {
      const registryAsPoster = this.registry.connect(this.poster);
      const tx = await registryAsPoster.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()]);
      const receipt = await tx.wait();
      console.log(`    Gas used (1 commitment): ${receipt.gasUsed.toString()}`);
    });

    it("GAS: post 10 commitments", async function () {
      const handles = Array.from({ length: 10 }, () => randomBytes32());
      const ctHashes = Array.from({ length: 10 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);
      const tx = await registryAsPoster.postCommitments(VERSION_1, handles, ctHashes);
      const receipt = await tx.wait();
      console.log(`    Gas used (10 commitments): ${receipt.gasUsed.toString()}`);
      console.log(`    Gas per commitment: ${(Number(receipt.gasUsed) / 10).toFixed(0)}`);
    });

    it("GAS: post 25 commitments", async function () {
      const handles = Array.from({ length: 25 }, () => randomBytes32());
      const ctHashes = Array.from({ length: 25 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);
      const tx = await registryAsPoster.postCommitments(VERSION_1, handles, ctHashes);
      const receipt = await tx.wait();
      console.log(`    Gas used (25 commitments): ${receipt.gasUsed.toString()}`);
      console.log(`    Gas per commitment: ${(Number(receipt.gasUsed) / 25).toFixed(0)}`);
    });

    it("GAS: post 50 commitments", async function () {
      const handles = Array.from({ length: 50 }, () => randomBytes32());
      const ctHashes = Array.from({ length: 50 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);
      const tx = await registryAsPoster.postCommitments(VERSION_1, handles, ctHashes);
      const receipt = await tx.wait();
      console.log(`    Gas used (50 commitments): ${receipt.gasUsed.toString()}`);
      console.log(`    Gas per commitment: ${(Number(receipt.gasUsed) / 50).toFixed(0)}`);
    });

    it("GAS: post 100 commitments", async function () {
      const handles = Array.from({ length: 100 }, () => randomBytes32());
      const ctHashes = Array.from({ length: 100 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);
      const tx = await registryAsPoster.postCommitments(VERSION_1, handles, ctHashes);
      const receipt = await tx.wait();
      console.log(`    Gas used (100 commitments): ${receipt.gasUsed.toString()}`);
      console.log(`    Gas per commitment: ${(Number(receipt.gasUsed) / 100).toFixed(0)}`);
    });

    it("GAS: getCommitment read", async function () {
      const handle = randomBytes32();
      const ctHash = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, [handle], [ctHash]);

      const gasEstimate = await this.registry.getCommitment.estimateGas(VERSION_1, handle);
      console.log(`    Gas estimate (getCommitment): ${gasEstimate.toString()}`);
    });

    it("GAS: getSize read", async function () {
      const gasEstimate = await this.registry.getSize.estimateGas(VERSION_1);
      console.log(`    Gas estimate (getSize): ${gasEstimate.toString()}`);
    });

    it("GAS: setVersionStatus", async function () {
      const version = randomBytes32();
      const tx = await this.registry.setVersionStatus(version, VersionStatus.Active);
      const receipt = await tx.wait();
      console.log(`    Gas used (setVersionStatus): ${receipt.gasUsed.toString()}`);
    });
  });

  // ── Upgrade ────────────────────────────────────────────────────────

  describe("Upgrade", function () {
    it("should allow owner to upgrade", async function () {
      const CommitmentRegistry = await ethers.getContractFactory("CommitmentRegistry");
      const newImpl = await CommitmentRegistry.deploy();
      await newImpl.waitForDeployment();

      await expect(
        this.registry.upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.not.be.reverted;
    });

    it("should revert when non-owner upgrades", async function () {
      const CommitmentRegistry = await ethers.getContractFactory("CommitmentRegistry");
      const newImpl = await CommitmentRegistry.deploy();
      await newImpl.waitForDeployment();

      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(this.registry, "OwnableUnauthorizedAccount");
    });

    it("should preserve state after upgrade", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      const handle = randomBytes32();
      const ctHash = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, [handle], [ctHash]);

      const CommitmentRegistry = await ethers.getContractFactory("CommitmentRegistry");
      const newImpl = await CommitmentRegistry.deploy();
      await newImpl.waitForDeployment();
      await this.registry.upgradeToAndCall(await newImpl.getAddress(), "0x");

      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(ctHash);
      expect(await this.registry.getSize(VERSION_1)).to.equal(1);
      expect(await this.registry.getVersionStatus(VERSION_1)).to.equal(VersionStatus.Active);
      expect(await this.registry.getPoster()).to.equal(this.poster.address);
    });
  });
}
