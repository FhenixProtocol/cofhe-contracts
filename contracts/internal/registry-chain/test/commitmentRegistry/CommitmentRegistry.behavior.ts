import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { upgrades } from "hardhat";

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

    it("should set the initial poster", async function () {
      expect(await this.registry.isPoster(this.poster.address)).to.equal(true);
    });

    it("should not mark non-poster as poster", async function () {
      expect(await this.registry.isPoster(this.otherAccount.address)).to.equal(false);
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
      await expect(
        upgrades.deployProxy(
          CommitmentRegistry,
          [ethers.ZeroAddress, this.poster.address],
          { kind: "uups", initializer: "initialize" },
        )
      ).to.be.reverted;
    });

    it("should revert when initializing with zero poster", async function () {
      const CommitmentRegistry = await ethers.getContractFactory("CommitmentRegistry");
      await expect(
        upgrades.deployProxy(
          CommitmentRegistry,
          [this.owner.address, ethers.ZeroAddress],
          { kind: "uups", initializer: "initialize" },
        )
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
    it("should allow owner to add a poster", async function () {
      await expect(this.registry.addPoster(this.otherAccount.address))
        .to.emit(this.registry, "PosterAdded")
        .withArgs(this.otherAccount.address);
      expect(await this.registry.isPoster(this.otherAccount.address)).to.equal(true);
    });

    it("should allow owner to remove a poster", async function () {
      await expect(this.registry.removePoster(this.poster.address))
        .to.emit(this.registry, "PosterRemoved")
        .withArgs(this.poster.address);
      expect(await this.registry.isPoster(this.poster.address)).to.equal(false);
    });

    it("should revoke access after removing poster", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      await this.registry.removePoster(this.poster.address);

      const registryAsOldPoster = this.registry.connect(this.poster);
      await expect(
        registryAsOldPoster.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()])
      ).to.be.revertedWithCustomError(this.registry, "OnlyPosterAllowed");
    });

    it("should allow multiple posters to post concurrently", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      await this.registry.addPoster(this.otherAccount.address);

      const registryAsPoster1 = this.registry.connect(this.poster);
      const registryAsPoster2 = this.registry.connect(this.otherAccount);

      await expect(
        registryAsPoster1.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()])
      ).to.not.be.reverted;

      await expect(
        registryAsPoster2.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()])
      ).to.not.be.reverted;

      expect(await this.registry.getSize(VERSION_1)).to.equal(2);
    });

    it("should revert when adding a poster that already exists", async function () {
      await expect(
        this.registry.addPoster(this.poster.address)
      ).to.be.revertedWithCustomError(this.registry, "PosterAlreadyExists")
        .withArgs(this.poster.address);
    });

    it("should revert when removing a poster that is not registered", async function () {
      await expect(
        this.registry.removePoster(this.otherAccount.address)
      ).to.be.revertedWithCustomError(this.registry, "PosterNotFound")
        .withArgs(this.otherAccount.address);
    });

    it("should revert when adding zero address as poster", async function () {
      await expect(
        this.registry.addPoster(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(this.registry, "InvalidAddress");
    });

    it("should revert when removing zero address as poster", async function () {
      await expect(
        this.registry.removePoster(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(this.registry, "InvalidAddress");
    });

    it("should revert when non-owner adds poster", async function () {
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.addPoster(this.otherAccount.address)
      ).to.be.revertedWithCustomError(this.registry, "OwnableUnauthorizedAccount");
    });

    it("should revert when non-owner removes poster", async function () {
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.removePoster(this.poster.address)
      ).to.be.revertedWithCustomError(this.registry, "OwnableUnauthorizedAccount");
    });

    it("should allow re-adding a previously removed poster", async function () {
      await this.registry.removePoster(this.poster.address);
      expect(await this.registry.isPoster(this.poster.address)).to.equal(false);

      await expect(this.registry.addPoster(this.poster.address))
        .to.emit(this.registry, "PosterAdded")
        .withArgs(this.poster.address);
      expect(await this.registry.isPoster(this.poster.address)).to.equal(true);
    });

    it("should allow removing one poster without affecting others", async function () {
      await this.registry.addPoster(this.otherAccount.address);
      await this.registry.removePoster(this.poster.address);

      expect(await this.registry.isPoster(this.poster.address)).to.equal(false);
      expect(await this.registry.isPoster(this.otherAccount.address)).to.equal(true);
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
      const commitHash = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);

      await expect(registryAsPoster.postCommitments(VERSION_1, [handle], [commitHash]))
        .to.emit(this.registry, "CommitmentsPosted")
        .withArgs(VERSION_1, 1);

      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(commitHash);
      expect(await this.registry.getSize(VERSION_1)).to.equal(1);
    });

    it("should post a batch of 10 commitments", async function () {
      const handles = Array.from({ length: 10 }, () => randomBytes32());
      const commitHashes = Array.from({ length: 10 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);

      await expect(registryAsPoster.postCommitments(VERSION_1, handles, commitHashes))
        .to.emit(this.registry, "CommitmentsPosted")
        .withArgs(VERSION_1, 10);

      for (let i = 0; i < 10; i++) {
        expect(await this.registry.getCommitment(VERSION_1, handles[i])).to.equal(commitHashes[i]);
      }
      expect(await this.registry.getSize(VERSION_1)).to.equal(10);
    });

    it("should post a batch of 50 commitments", async function () {
      const handles = Array.from({ length: 50 }, () => randomBytes32());
      const commitHashes = Array.from({ length: 50 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);

      await expect(registryAsPoster.postCommitments(VERSION_1, handles, commitHashes))
        .to.emit(this.registry, "CommitmentsPosted")
        .withArgs(VERSION_1, 50);

      expect(await this.registry.getCommitment(VERSION_1, handles[0])).to.equal(commitHashes[0]);
      expect(await this.registry.getCommitment(VERSION_1, handles[49])).to.equal(commitHashes[49]);
      expect(await this.registry.getSize(VERSION_1)).to.equal(50);
    });

    it("should accumulate count across multiple batches", async function () {
      const registryAsPoster = this.registry.connect(this.poster);

      const handles1 = Array.from({ length: 5 }, () => randomBytes32());
      const commitHashes1 = Array.from({ length: 5 }, () => randomBytes32());
      await registryAsPoster.postCommitments(VERSION_1, handles1, commitHashes1);

      const handles2 = Array.from({ length: 3 }, () => randomBytes32());
      const commitHashes2 = Array.from({ length: 3 }, () => randomBytes32());
      await registryAsPoster.postCommitments(VERSION_1, handles2, commitHashes2);

      expect(await this.registry.getSize(VERSION_1)).to.equal(8);
    });

    it("should keep versions isolated", async function () {
      await this.registry.setVersionStatus(VERSION_2, VersionStatus.Active);
      const registryAsPoster = this.registry.connect(this.poster);

      const handle = randomBytes32();
      const commitHash1 = randomBytes32();
      const commitHash2 = randomBytes32();

      await registryAsPoster.postCommitments(VERSION_1, [handle], [commitHash1]);
      await registryAsPoster.postCommitments(VERSION_2, [handle], [commitHash2]);

      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(commitHash1);
      expect(await this.registry.getCommitment(VERSION_2, handle)).to.equal(commitHash2);
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

    it("should prevent a second poster from overwriting commitments posted by the first", async function () {
      await this.registry.addPoster(this.otherAccount.address);
      const handle = randomBytes32();
      const commitHash = randomBytes32();
      const registryAsPoster1 = this.registry.connect(this.poster);
      const registryAsPoster2 = this.registry.connect(this.otherAccount);

      await registryAsPoster1.postCommitments(VERSION_1, [handle], [commitHash]);

      await expect(
        registryAsPoster2.postCommitments(VERSION_1, [handle], [randomBytes32()])
      ).to.be.revertedWithCustomError(this.registry, "CommitmentAlreadyExists")
        .withArgs(VERSION_1, handle);

      // Original commitment is preserved
      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(commitHash);
    });
  });

  // ── postCommitmentsSafe (idempotent) ────────────────────────────────

  describe("Post Commitments Safe", function () {
    beforeEach(async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
    });

    it("should write all handles and emit (newlyPosted=N, skipped=0) on first call", async function () {
      const handles = Array.from({ length: 3 }, () => randomBytes32());
      const commitHashes = Array.from({ length: 3 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);

      await expect(registryAsPoster.postCommitmentsSafe(VERSION_1, handles, commitHashes))
        .to.emit(this.registry, "CommitmentsPostedSafe")
        .withArgs(VERSION_1, 3, 0);

      for (let i = 0; i < 3; i++) {
        expect(await this.registry.getCommitment(VERSION_1, handles[i])).to.equal(commitHashes[i]);
      }
      expect(await this.registry.getSize(VERSION_1)).to.equal(3);
    });

    it("should silently skip already-committed handles", async function () {
      const handle = randomBytes32();
      const original = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);

      await registryAsPoster.postCommitmentsSafe(VERSION_1, [handle], [original]);

      // Re-post same handle with a different commit hash — should NOT revert
      // and should NOT overwrite the original.
      await expect(
        registryAsPoster.postCommitmentsSafe(VERSION_1, [handle], [randomBytes32()])
      )
        .to.emit(this.registry, "CommitmentsPostedSafe")
        .withArgs(VERSION_1, 0, 1);

      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(original);
      expect(await this.registry.getSize(VERSION_1)).to.equal(1);
    });

    it("should write only new handles in a mixed batch", async function () {
      const existingHandle = randomBytes32();
      const newHandle1 = randomBytes32();
      const newHandle2 = randomBytes32();
      const existingCommit = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);

      await registryAsPoster.postCommitmentsSafe(VERSION_1, [existingHandle], [existingCommit]);

      const newCommit1 = randomBytes32();
      const newCommit2 = randomBytes32();
      await expect(
        registryAsPoster.postCommitmentsSafe(
          VERSION_1,
          [existingHandle, newHandle1, newHandle2],
          [randomBytes32(), newCommit1, newCommit2]
        )
      )
        .to.emit(this.registry, "CommitmentsPostedSafe")
        .withArgs(VERSION_1, 2, 1);

      // existing one preserved
      expect(await this.registry.getCommitment(VERSION_1, existingHandle)).to.equal(existingCommit);
      // new ones written
      expect(await this.registry.getCommitment(VERSION_1, newHandle1)).to.equal(newCommit1);
      expect(await this.registry.getCommitment(VERSION_1, newHandle2)).to.equal(newCommit2);
      expect(await this.registry.getSize(VERSION_1)).to.equal(3);
    });

    it("should dedup duplicate handles within the same batch", async function () {
      const handle = randomBytes32();
      const commitHash = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);

      // Same handle three times in one call — should write once, skip twice.
      await expect(
        registryAsPoster.postCommitmentsSafe(
          VERSION_1,
          [handle, handle, handle],
          [commitHash, randomBytes32(), randomBytes32()]
        )
      )
        .to.emit(this.registry, "CommitmentsPostedSafe")
        .withArgs(VERSION_1, 1, 2);

      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(commitHash);
      expect(await this.registry.getSize(VERSION_1)).to.equal(1);
    });

    it("should still revert on zero commitHash", async function () {
      const handle = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);

      await expect(
        registryAsPoster.postCommitmentsSafe(VERSION_1, [handle], [ethers.ZeroHash])
      )
        .to.be.revertedWithCustomError(this.registry, "ZeroCommitHash")
        .withArgs(handle);
    });

    it("should still revert on empty batch", async function () {
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.postCommitmentsSafe(VERSION_1, [], [])
      ).to.be.revertedWithCustomError(this.registry, "EmptyBatch");
    });

    it("should still revert on length mismatch", async function () {
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.postCommitmentsSafe(
          VERSION_1,
          [randomBytes32()],
          [randomBytes32(), randomBytes32()]
        )
      ).to.be.revertedWithCustomError(this.registry, "LengthMismatch");
    });

    it("should revert when version is not active", async function () {
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.postCommitmentsSafe(VERSION_2, [randomBytes32()], [randomBytes32()])
      )
        .to.be.revertedWithCustomError(this.registry, "VersionNotActive")
        .withArgs(VERSION_2);
    });

    it("should revert when caller is not a poster", async function () {
      const registryAsOther = this.registry.connect(this.otherAccount);
      await expect(
        registryAsOther.postCommitmentsSafe(VERSION_1, [randomBytes32()], [randomBytes32()])
      )
        .to.be.revertedWithCustomError(this.registry, "OnlyPosterAllowed")
        .withArgs(this.otherAccount.address);
    });

    it("should not double-count handles in handlesByVersion when re-posted", async function () {
      const handle = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);

      await registryAsPoster.postCommitmentsSafe(VERSION_1, [handle], [randomBytes32()]);
      await registryAsPoster.postCommitmentsSafe(VERSION_1, [handle], [randomBytes32()]);
      await registryAsPoster.postCommitmentsSafe(VERSION_1, [handle], [randomBytes32()]);

      expect(await this.registry.getSize(VERSION_1)).to.equal(1);
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

    it("should revert after poster is removed", async function () {
      await this.registry.removePoster(this.poster.address);
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()])
      ).to.be.revertedWithCustomError(this.registry, "OnlyPosterAllowed")
        .withArgs(this.poster.address);
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

    it("should revert on zero commitHash", async function () {
      const handle = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);
      await expect(
        registryAsPoster.postCommitments(VERSION_1, [handle], [ethers.ZeroHash])
      ).to.be.revertedWithCustomError(this.registry, "ZeroCommitHash")
        .withArgs(handle);
    });

    it("should revert on zero commitHash mid-batch and not persist earlier items", async function () {
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
      ).to.be.revertedWithCustomError(this.registry, "ZeroCommitHash")
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
      const commitHash = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, [handle], [commitHash]);

      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Deprecated);

      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(commitHash);
      expect(await this.registry.getSize(VERSION_1)).to.equal(1);
    });

    it("should return handles with getHandles pagination", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      const handles = Array.from({ length: 10 }, () => randomBytes32());
      const commitHashes = Array.from({ length: 10 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, handles, commitHashes);

      // First page
      const page1 = await this.registry.getHandles(VERSION_1, 0, 5);
      expect(page1.length).to.equal(5);
      for (let i = 0; i < 5; i++) {
        expect(page1[i]).to.equal(handles[i]);
      }

      // Second page
      const page2 = await this.registry.getHandles(VERSION_1, 5, 5);
      expect(page2.length).to.equal(5);
      for (let i = 0; i < 5; i++) {
        expect(page2[i]).to.equal(handles[5 + i]);
      }
    });

    it("should return empty array when offset exceeds total", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()]);

      const result = await this.registry.getHandles(VERSION_1, 100, 10);
      expect(result.length).to.equal(0);
    });

    it("should clamp limit when it exceeds remaining items", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      const handles = Array.from({ length: 3 }, () => randomBytes32());
      const commitHashes = Array.from({ length: 3 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, handles, commitHashes);

      const result = await this.registry.getHandles(VERSION_1, 1, 100);
      expect(result.length).to.equal(2);
      expect(result[0]).to.equal(handles[1]);
      expect(result[1]).to.equal(handles[2]);
    });

    it("should return handle by index", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      const handles = Array.from({ length: 5 }, () => randomBytes32());
      const commitHashes = Array.from({ length: 5 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, handles, commitHashes);

      for (let i = 0; i < 5; i++) {
        expect(await this.registry.getHandleByIndex(VERSION_1, i)).to.equal(handles[i]);
      }
    });

    it("should revert when getHandleByIndex is out of bounds", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, [randomBytes32()], [randomBytes32()]);

      await expect(this.registry.getHandleByIndex(VERSION_1, 1)).to.be.reverted;
    });

    it("should still return commitments after version is Revoked", async function () {
      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Active);
      const handle = randomBytes32();
      const commitHash = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, [handle], [commitHash]);

      await this.registry.setVersionStatus(VERSION_1, VersionStatus.Revoked);

      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(commitHash);
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
      const commitHashes = Array.from({ length: 10 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);
      const tx = await registryAsPoster.postCommitments(VERSION_1, handles, commitHashes);
      const receipt = await tx.wait();
      console.log(`    Gas used (10 commitments): ${receipt.gasUsed.toString()}`);
      console.log(`    Gas per commitment: ${(Number(receipt.gasUsed) / 10).toFixed(0)}`);
    });

    it("GAS: post 25 commitments", async function () {
      const handles = Array.from({ length: 25 }, () => randomBytes32());
      const commitHashes = Array.from({ length: 25 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);
      const tx = await registryAsPoster.postCommitments(VERSION_1, handles, commitHashes);
      const receipt = await tx.wait();
      console.log(`    Gas used (25 commitments): ${receipt.gasUsed.toString()}`);
      console.log(`    Gas per commitment: ${(Number(receipt.gasUsed) / 25).toFixed(0)}`);
    });

    it("GAS: post 50 commitments", async function () {
      const handles = Array.from({ length: 50 }, () => randomBytes32());
      const commitHashes = Array.from({ length: 50 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);
      const tx = await registryAsPoster.postCommitments(VERSION_1, handles, commitHashes);
      const receipt = await tx.wait();
      console.log(`    Gas used (50 commitments): ${receipt.gasUsed.toString()}`);
      console.log(`    Gas per commitment: ${(Number(receipt.gasUsed) / 50).toFixed(0)}`);
    });

    it("GAS: post 100 commitments", async function () {
      const handles = Array.from({ length: 100 }, () => randomBytes32());
      const commitHashes = Array.from({ length: 100 }, () => randomBytes32());
      const registryAsPoster = this.registry.connect(this.poster);
      const tx = await registryAsPoster.postCommitments(VERSION_1, handles, commitHashes);
      const receipt = await tx.wait();
      console.log(`    Gas used (100 commitments): ${receipt.gasUsed.toString()}`);
      console.log(`    Gas per commitment: ${(Number(receipt.gasUsed) / 100).toFixed(0)}`);
    });

    it("GAS: getCommitment read", async function () {
      const handle = randomBytes32();
      const commitHash = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, [handle], [commitHash]);

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

    it("GAS: addPoster", async function () {
      const tx = await this.registry.addPoster(this.otherAccount.address);
      const receipt = await tx.wait();
      console.log(`    Gas used (addPoster): ${receipt.gasUsed.toString()}`);
    });

    it("GAS: removePoster", async function () {
      const tx = await this.registry.removePoster(this.poster.address);
      const receipt = await tx.wait();
      console.log(`    Gas used (removePoster): ${receipt.gasUsed.toString()}`);
    });

    it("GAS: isPoster read", async function () {
      const gasEstimate = await this.registry.isPoster.estimateGas(this.poster.address);
      console.log(`    Gas estimate (isPoster): ${gasEstimate.toString()}`);
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
      const commitHash = randomBytes32();
      const registryAsPoster = this.registry.connect(this.poster);
      await registryAsPoster.postCommitments(VERSION_1, [handle], [commitHash]);

      // Add a second poster before upgrade
      await this.registry.addPoster(this.otherAccount.address);

      const CommitmentRegistry = await ethers.getContractFactory("CommitmentRegistry");
      const newImpl = await CommitmentRegistry.deploy();
      await newImpl.waitForDeployment();
      await this.registry.upgradeToAndCall(await newImpl.getAddress(), "0x");

      expect(await this.registry.getCommitment(VERSION_1, handle)).to.equal(commitHash);
      expect(await this.registry.getSize(VERSION_1)).to.equal(1);
      expect(await this.registry.getVersionStatus(VERSION_1)).to.equal(VersionStatus.Active);
      expect(await this.registry.isPoster(this.poster.address)).to.equal(true);
      expect(await this.registry.isPoster(this.otherAccount.address)).to.equal(true);
    });
  });
}
