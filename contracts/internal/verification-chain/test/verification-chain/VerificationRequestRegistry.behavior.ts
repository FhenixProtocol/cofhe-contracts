import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { Contract, randomBytes, hexlify } from "ethers";

function randomBytes32(): string {
  return hexlify(randomBytes(32));
}

function randomCid(): string {
  return "Qm" + hexlify(randomBytes(22)).slice(2);
}

function randomSecurityZone(): number {
  return Math.floor(Math.random() * 256) - 128;
}

function randomChainId(): bigint {
  return BigInt(Math.floor(Math.random() * 100000) + 1);
}

export function shouldBehaveLikeVerificationRequestRegistry(): void {
  describe("submitRequest", function () {
    describe("when ipfsCid is empty", function () {
      it("should revert with VerificationRequestRegistry__EmptyIPFSCid", async function () {
        const contract = this.verificationRegistry as Contract;
        await expect(
          contract.submitRequest("", [randomBytes32()], 0, 1n)
        ).to.be.revertedWithCustomError(contract, "VerificationRequestRegistry__EmptyIPFSCid");
      });
    });

    describe("when ctHashes is empty", function () {
      it("should revert with VerificationRequestRegistry__EmptyCTHashes", async function () {
        const contract = this.verificationRegistry as Contract;
        await expect(
          contract.submitRequest("QmTest123", [], 0, 1n)
        ).to.be.revertedWithCustomError(contract, "VerificationRequestRegistry__EmptyCTHashes");
      });
    });

    describe("when a ct_hash already exists", function () {
      it("should revert with VerificationRequestRegistry__DuplicateCTHash", async function () {
        const contract = this.verificationRegistry as Contract;
        const duplicateHash = randomBytes32();

        await contract.submitRequest("QmFirst", [duplicateHash], 0, 1n);

        await expect(
          contract.submitRequest("QmSecond", [duplicateHash], 0, 1n)
        ).to.be.revertedWithCustomError(contract, "VerificationRequestRegistry__DuplicateCTHash")
          .withArgs(duplicateHash);
      });

      it("should revert when duplicate is within the same submission's array", async function () {
        const contract = this.verificationRegistry as Contract;
        const hash = randomBytes32();
        const otherHash = randomBytes32();

        await contract.submitRequest("QmFirst", [hash], 0, 1n);

        await expect(
          contract.submitRequest("QmSecond", [otherHash, hash], 0, 1n)
        ).to.be.revertedWithCustomError(contract, "VerificationRequestRegistry__DuplicateCTHash")
          .withArgs(hash);
      });
    });

    describe("when all inputs are valid", function () {
      it("should store request with correct fields", async function () {
        const contract = this.verificationRegistry as Contract;
        const ipfsCid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
        const ctHashes = [randomBytes32(), randomBytes32()];
        const securityZone = 5;
        const chainId = 42161n;

        await contract.submitRequest(ipfsCid, ctHashes, securityZone, chainId);

        const req = await contract.getRequestByCTHash(ctHashes[0]);
        expect(req.ipfsCid).to.equal(ipfsCid);
        expect(req.ctHashes).to.deep.equal(ctHashes);
        expect(req.securityZone).to.equal(securityZone);
        expect(req.chainId).to.equal(chainId);
      });

      it("should set submitter to msg.sender", async function () {
        const contract = this.verificationRegistry as Contract;
        const owner = this.owner;
        const ctHash = randomBytes32();

        await contract.connect(owner).submitRequest("QmSender", [ctHash], 0, 1n);

        const req = await contract.getRequestByCTHash(ctHash);
        expect(req.submitter).to.equal(owner.address);
      });

      it("should emit VerificationRequestSubmitted with correct fields", async function () {
        const contract = this.verificationRegistry as Contract;
        const owner = this.owner;
        const ipfsCid = "QmEventTest";
        const ctHashes = [randomBytes32()];
        const securityZone = -3;
        const chainId = 10n;

        await expect(
          contract.connect(owner).submitRequest(ipfsCid, ctHashes, securityZone, chainId)
        )
          .to.emit(contract, "VerificationRequestSubmitted")
          .withArgs(
            owner.address,
            ipfsCid,
            ctHashes,
            securityZone,
            chainId
          );
      });

      it("should increment getRequestCount", async function () {
        const contract = this.verificationRegistry as Contract;

        expect(await contract.getRequestCount()).to.equal(0);

        await contract.submitRequest("QmCount1", [randomBytes32()], 0, 1n);
        expect(await contract.getRequestCount()).to.equal(1);

        await contract.submitRequest("QmCount2", [randomBytes32()], 0, 1n);
        expect(await contract.getRequestCount()).to.equal(2);

        await contract.submitRequest("QmCount3", [randomBytes32()], 0, 1n);
        expect(await contract.getRequestCount()).to.equal(3);
      });

      it("should allow each ct_hash in the array to resolve via getRequestByCTHash", async function () {
        const contract = this.verificationRegistry as Contract;
        const ipfsCid = "QmMultiHash";
        const ctHashes = [randomBytes32(), randomBytes32(), randomBytes32()];

        await contract.submitRequest(ipfsCid, ctHashes, 0, 1n);

        for (const hash of ctHashes) {
          const req = await contract.getRequestByCTHash(hash);
          expect(req.ipfsCid).to.equal(ipfsCid);
          expect(req.ctHashes).to.deep.equal(ctHashes);
        }
      });

      it("should handle multiple ct_hashes (1, 5, many)", async function () {
        const contract = this.verificationRegistry as Contract;

        // 1 hash
        const oneHash = [randomBytes32()];
        await contract.submitRequest("QmOneHash", oneHash, 0, 1n);
        const req0 = await contract.getRequestByCTHash(oneHash[0]);
        expect(req0.ctHashes).to.deep.equal(oneHash);

        // 5 hashes
        const fiveHashes = Array.from({ length: 5 }, () => randomBytes32());
        await contract.submitRequest("QmFiveHashes", fiveHashes, 0, 1n);
        for (const h of fiveHashes) {
          const req = await contract.getRequestByCTHash(h);
          expect(req.ipfsCid).to.equal("QmFiveHashes");
        }

        // 20 hashes
        const manyHashes = Array.from({ length: 20 }, () => randomBytes32());
        await contract.submitRequest("QmManyHashes", manyHashes, 0, 1n);
        for (const h of manyHashes) {
          const req = await contract.getRequestByCTHash(h);
          expect(req.ipfsCid).to.equal("QmManyHashes");
        }
      });

      it("should record different callers as different submitters", async function () {
        const contract = this.verificationRegistry as Contract;
        const owner = this.owner;
        const otherAccount = this.otherAccount;
        const hash1 = randomBytes32();
        const hash2 = randomBytes32();

        await contract.connect(owner).submitRequest("QmOwner", [hash1], 0, 1n);
        await contract.connect(otherAccount).submitRequest("QmOther", [hash2], 0, 1n);

        const req0 = await contract.getRequestByCTHash(hash1);
        expect(req0.submitter).to.equal(owner.address);

        const req1 = await contract.getRequestByCTHash(hash2);
        expect(req1.submitter).to.equal(otherAccount.address);
      });

      it("should handle randomized inputs (approximate fuzz testing)", async function () {
        const contract = this.verificationRegistry as Contract;
        const iterations = 10;
        const allHashes: string[][] = [];

        for (let i = 0; i < iterations; i++) {
          const cid = randomCid();
          const numHashes = Math.floor(Math.random() * 5) + 1;
          const ctHashes = Array.from({ length: numHashes }, () => randomBytes32());
          const securityZone = randomSecurityZone();
          const chainId = randomChainId();

          await contract.submitRequest(cid, ctHashes, securityZone, chainId);
          allHashes.push(ctHashes);

          const req = await contract.getRequestByCTHash(ctHashes[0]);
          expect(req.ipfsCid).to.equal(cid);
          expect(req.ctHashes).to.deep.equal(ctHashes);
          expect(req.securityZone).to.equal(securityZone);
          expect(req.chainId).to.equal(chainId);
          expect(req.submitter).to.not.equal(ethers.ZeroAddress);
        }

        expect(await contract.getRequestCount()).to.equal(iterations);
      });
    });
  });

  describe("getRequestByCTHash", function () {
    describe("when ctHash exists", function () {
      it("should return the stored request", async function () {
        const contract = this.verificationRegistry as Contract;
        const ipfsCid = "QmGetRequestValid";
        const ctHashes = [randomBytes32()];

        await contract.submitRequest(ipfsCid, ctHashes, 0, 1n);

        const req = await contract.getRequestByCTHash(ctHashes[0]);
        expect(req.ipfsCid).to.equal(ipfsCid);
        expect(req.ctHashes).to.deep.equal(ctHashes);
      });
    });

    describe("when ctHash does not exist", function () {
      it("should revert with VerificationRequestRegistry__CTHashNotFound", async function () {
        const contract = this.verificationRegistry as Contract;
        await expect(
          contract.getRequestByCTHash(randomBytes32())
        ).to.be.revertedWithCustomError(contract, "VerificationRequestRegistry__CTHashNotFound");
      });
    });
  });

  describe("getRequestCount", function () {
    it("should return the number of submitted requests", async function () {
      const contract = this.verificationRegistry as Contract;
      expect(await contract.getRequestCount()).to.equal(0);

      await contract.submitRequest("QmA", [randomBytes32()], 0, 1n);
      expect(await contract.getRequestCount()).to.equal(1);

      await contract.submitRequest("QmB", [randomBytes32()], 0, 1n);
      expect(await contract.getRequestCount()).to.equal(2);
    });
  });
}
