import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const { ethers, upgrades } = hre;

const ACP_TUPLE =
  "tuple(address issuer,uint64 expiration,address recipient,uint256 revokerData,address revokerContract,uint8 scope," +
  "address[] contracts,bytes32[] handles,bytes32 sealingKey,bytes issuerSignature,bytes recipientSignature)";
const SCOPE_HANDLES = 2;
const METADATA = "0x03" + "ab".repeat(121);

type Acp = {
  issuer: string;
  expiration: bigint;
  recipient: string;
  revokerData: bigint;
  revokerContract: string;
  scope: number;
  contracts: string[];
  handles: string[];
  sealingKey: string;
  issuerSignature: string;
  recipientSignature: string;
};

function shareIdOf(acp: Acp): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([ACP_TUPLE], [acp]));
}

/** The ACP as an ethers Result, for comparing with what the contract returns or emits. */
function asTuple(acp: Acp) {
  return [
    acp.issuer,
    acp.expiration,
    acp.recipient,
    acp.revokerData,
    acp.revokerContract,
    BigInt(acp.scope),
    acp.contracts,
    acp.handles,
    acp.sealingKey,
    acp.issuerSignature,
    acp.recipientSignature,
  ];
}

describe("ACPShareRegistry", function () {
  let admin: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let registry: any;

  function sampleAcp(overrides: Partial<Acp> = {}): Acp {
    return {
      issuer: issuer.address,
      expiration: 4102444800n,
      recipient: recipient.address,
      revokerData: 0n,
      revokerContract: ethers.ZeroAddress,
      scope: SCOPE_HANDLES,
      contracts: [],
      handles: [ethers.id("balance"), ethers.id("transfer")],
      sealingKey: ethers.ZeroHash,
      issuerSignature: "0x" + "11".repeat(65),
      recipientSignature: "0x",
      ...overrides,
    };
  }

  /** The `Shared` event of a share, read back the way a wallet does: one block, filtered by share id. */
  async function sharedEvent(shareId: string, blockNumber: bigint) {
    const logs = await registry.queryFilter(
      registry.filters.Shared(undefined, undefined, shareId),
      blockNumber,
      blockNumber,
    );
    expect(logs).to.have.length(1);
    return logs[0];
  }

  beforeEach(async function () {
    [admin, issuer, recipient, stranger] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("ACPShareRegistry");
    registry = await upgrades.deployProxy(factory, [admin.address], { kind: "uups", initializer: "initialize" });
    await registry.waitForDeployment();
  });

  describe("share", function () {
    it("stores the header and emits the full ACP and the metadata", async function () {
      const acp = sampleAcp();
      const shareId = shareIdOf(acp);
      expect(await registry.connect(issuer).share.staticCall(acp, METADATA)).to.equal(shareId);

      const receipt = await (await registry.connect(issuer).share(acp, METADATA)).wait();
      const header = await registry.getShare(shareId);
      expect(header.issuer).to.equal(issuer.address);
      expect(header.expiration).to.equal(acp.expiration);
      expect(header.recipient).to.equal(recipient.address);
      expect(header.blockNumber).to.equal(receipt.blockNumber);
      expect(header.revokerContract).to.equal(ethers.ZeroAddress);
      expect(header.revokerData).to.equal(0n);

      const event = await sharedEvent(shareId, header.blockNumber);
      expect(event.args.recipient).to.equal(recipient.address);
      expect(event.args.issuer).to.equal(issuer.address);
      expect(event.args.shareId).to.equal(shareId);
      expect(event.args.acp.toArray(true)).to.deep.equal(asTuple(acp));
      expect(event.args.metadata).to.equal(METADATA);
    });

    it("accepts a share without metadata", async function () {
      const acp = sampleAcp();
      await registry.connect(issuer).share(acp, "0x");
      const header = await registry.getShare(shareIdOf(acp));
      expect((await sharedEvent(shareIdOf(acp), header.blockNumber)).args.metadata).to.equal("0x");
    });

    it("keeps the revoker in the header", async function () {
      const acp = sampleAcp({ revokerContract: stranger.address, revokerData: 7n });
      await registry.connect(issuer).share(acp, "0x");
      const header = await registry.getShare(shareIdOf(acp));
      expect(header.revokerContract).to.equal(stranger.address);
      expect(header.revokerData).to.equal(7n);
    });

    it("rejects a share posted by anyone but its issuer", async function () {
      await expect(registry.connect(stranger).share(sampleAcp(), "0x")).to.be.revertedWithCustomError(
        registry,
        "NotIssuer",
      );
    });

    it("rejects a share without recipient, with a sealing key, unsigned or expired", async function () {
      const cases: [Partial<Acp>, string][] = [
        [{ recipient: ethers.ZeroAddress }, "RecipientMissing"],
        [{ sealingKey: ethers.id("key") }, "SealingKeyMustBeEmpty"],
        [{ issuerSignature: "0x" }, "IssuerSignatureMissing"],
        [{ expiration: 1n }, "ShareExpired"],
      ];
      for (const [overrides, error] of cases) {
        await expect(registry.connect(issuer).share(sampleAcp(overrides), "0x")).to.be.revertedWithCustomError(
          registry,
          error,
        );
      }
    });

    it("rejects the same ACP twice, whatever its metadata: labels are written once", async function () {
      const acp = sampleAcp();
      await registry.connect(issuer).share(acp, METADATA);
      await expect(registry.connect(issuer).share(acp, "0x0302")).to.be.revertedWithCustomError(
        registry,
        "AlreadyShared",
      );
    });
  });

  describe("sharesFor", function () {
    it("returns ids and headers of the live shares, index for index", async function () {
      const first = sampleAcp();
      const second = sampleAcp({ handles: [ethers.id("other")] });
      await registry.connect(issuer).share(first, METADATA);
      await registry.connect(issuer).share(second, "0x");

      const [ids, headers] = await registry.sharesFor(recipient.address);
      expect(ids).to.deep.equal([shareIdOf(first), shareIdOf(second)]);
      expect(headers.map((h: any) => h.issuer)).to.deep.equal([issuer.address, issuer.address]);
      for (const [i, id] of ids.entries()) {
        expect(headers[i]).to.deep.equal(await registry.getShare(id));
      }
    });

    it("returns two empty arrays for a recipient without shares", async function () {
      const [ids, headers] = await registry.sharesFor(stranger.address);
      expect(ids).to.have.length(0);
      expect(headers).to.have.length(0);
    });

    it("filters expired and revoked shares", async function () {
      const revoker = await (await ethers.getContractFactory("ACPTimestampRevoker")).deploy();
      const now = BigInt(await time.latest());
      const live = sampleAcp();
      const expiring = sampleAcp({ expiration: now + 100n, handles: [ethers.id("expiring")] });
      const revoked = sampleAcp({
        revokerContract: await revoker.getAddress(),
        revokerData: 1n,
        handles: [ethers.id("revoked")],
      });
      for (const acp of [live, expiring, revoked]) await registry.connect(issuer).share(acp, "0x");

      await revoker.connect(issuer).revokeSingle(1n);
      await time.increase(200);

      const [ids, headers] = await registry.sharesFor(recipient.address);
      expect(ids).to.deep.equal([shareIdOf(live)]);
      expect(headers).to.have.length(1);
      expect(await registry.isShareValid(shareIdOf(live))).to.equal(true);
      expect(await registry.isShareValid(shareIdOf(expiring))).to.equal(false);
      expect(await registry.isShareValid(shareIdOf(revoked))).to.equal(false);
    });
  });

  describe("removeShare", function () {
    for (const who of ["issuer", "recipient"] as const) {
      it(`lets the ${who} remove a share`, async function () {
        const acp = sampleAcp();
        const shareId = shareIdOf(acp);
        await registry.connect(issuer).share(acp, METADATA);
        const caller = who === "issuer" ? issuer : recipient;

        await expect(registry.connect(caller).removeShare(shareId))
          .to.emit(registry, "ShareRemoved")
          .withArgs(recipient.address, issuer.address, shareId);
        const [ids] = await registry.sharesFor(recipient.address);
        expect(ids).to.have.length(0);
        expect((await registry.getShare(shareId)).issuer).to.equal(ethers.ZeroAddress);
        expect(await registry.isShareValid(shareId)).to.equal(false);
      });
    }

    it("rejects a stranger and an unknown share", async function () {
      const acp = sampleAcp();
      await registry.connect(issuer).share(acp, "0x");
      await expect(registry.connect(stranger).removeShare(shareIdOf(acp))).to.be.revertedWithCustomError(
        registry,
        "NotIssuerOrRecipient",
      );
      await expect(registry.connect(issuer).removeShare(ethers.id("unknown"))).to.be.revertedWithCustomError(
        registry,
        "UnknownShare",
      );
    });

    it("lets a removed share be posted again, pointing at its new event", async function () {
      const acp = sampleAcp();
      const shareId = shareIdOf(acp);
      await registry.connect(issuer).share(acp, METADATA);
      const firstBlock = (await registry.getShare(shareId)).blockNumber;
      await registry.connect(recipient).removeShare(shareId);

      await registry.connect(issuer).share(acp, "0x0302");
      const header = await registry.getShare(shareId);
      expect(header.blockNumber).to.be.greaterThan(firstBlock);
      expect((await sharedEvent(shareId, header.blockNumber)).args.metadata).to.equal("0x0302");
    });
  });

  describe("gas", function () {
    // Not an assertion: prints what `share` costs here, for comparison with the payload-in-storage
    // version (297k at 1 ctHash, 434k at 7, 729k at 20, 2,545k at 100, measured with a proxy).
    it("prints the gas of share(acp, metadata) by number of ctHashes", async function () {
      const rows: string[] = [];
      for (const count of [1, 7, 20, 100]) {
        const handles = Array.from({ length: count }, (_, i) => ethers.id(`handle ${count} ${i}`));
        const without = await (await registry.connect(issuer).share(sampleAcp({ handles }), "0x")).wait();
        const labelled = sampleAcp({ handles, expiration: 4102444801n });
        const blob = "0x03" + "ab".repeat(5 * count);
        const withBlob = await (await registry.connect(issuer).share(labelled, blob)).wait();
        rows.push(`${count} ctHashes: ${without.gasUsed} gas, ${withBlob.gasUsed} with a ${5 * count + 1}-byte blob`);
      }
      console.log("      " + rows.join("\n      "));
    });
  });
});
