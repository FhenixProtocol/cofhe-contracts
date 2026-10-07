import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const { ethers, upgrades } = hre;

const ACP_TUPLE =
  "tuple(address issuer,uint64 expiration,address recipient,uint256 revokerData,address revokerContract,uint8 scope," +
  "address[] contracts,bytes32[] handles,bytes32 sealingKey,bytes issuerSignature,bytes recipientSignature)";

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

const shareIdOf = (acp: Acp) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([ACP_TUPLE], [acp]));

/**
 * The in-place upgrade from the first ACPShareRegistry (whole payload in storage) to the
 * pointer-based one: the layout check passes, and `migrateV1Shares` re-posts the live first-version
 * shares so they read exactly like new ones.
 */
describe("ACPShareRegistry: in-place upgrade from v1", function () {
  let admin: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const acpFor = (recipient: HardhatEthersSigner, tag: string, overrides: Partial<Acp> = {}): Acp => ({
    issuer: issuer.address,
    expiration: 4102444800n,
    recipient: recipient.address,
    revokerData: 0n,
    revokerContract: ethers.ZeroAddress,
    scope: 2,
    contracts: [],
    handles: [ethers.id(tag)],
    sealingKey: ethers.ZeroHash,
    issuerSignature: "0x" + "11".repeat(65),
    recipientSignature: "0x",
    ...overrides,
  });

  /** A v1 proxy holding: two live shares for alice, one live and one expired for bob, one revoked for bob, one removed. */
  async function v1WithShares() {
    [admin, issuer, alice, bob, stranger] = await ethers.getSigners();
    const V1 = await ethers.getContractFactory("ACPShareRegistryV1");
    const registry: any = await upgrades.deployProxy(V1, [admin.address], { kind: "uups", initializer: "initialize" });
    await registry.waitForDeployment();
    const revoker = await (await ethers.getContractFactory("ACPTimestampRevoker")).deploy();

    const now = BigInt(await time.latest());
    const shares = {
      alice1: acpFor(alice, "alice-1"),
      alice2: acpFor(alice, "alice-2", { handles: [ethers.id("a"), ethers.id("b")] }),
      bobLive: acpFor(bob, "bob-live"),
      bobExpiring: acpFor(bob, "bob-expiring", { expiration: now + 100n }),
      bobRevoked: acpFor(bob, "bob-revoked", { revokerContract: await revoker.getAddress(), revokerData: 1n }),
      bobRemoved: acpFor(bob, "bob-removed"),
    };
    for (const acp of Object.values(shares)) await (await registry.connect(issuer).share(acp)).wait();
    await (await registry.connect(bob).removeShare(shareIdOf(shares.bobRemoved))).wait();
    await (await revoker.connect(issuer).revokeSingle(1n)).wait();
    await time.increase(200);

    return { registry, shares, V2: await ethers.getContractFactory("ACPShareRegistry") };
  }

  it("passes the OpenZeppelin layout check", async function () {
    const { registry, V2 } = await v1WithShares();
    await upgrades.validateUpgrade(await registry.getAddress(), V2, { kind: "uups" });
  });

  it("re-posts the unexpired v1 shares inside upgradeToAndCall, dropping expired ones", async function () {
    const { registry, shares, V2 } = await v1WithShares();
    const upgraded: any = await upgrades.upgradeProxy(await registry.getAddress(), V2, {
      kind: "uups",
      call: { fn: "migrateV1Shares", args: [[alice.address, bob.address]] },
    });
    const receipt = await upgraded.deployTransaction?.wait?.();
    const upgradeBlock = BigInt(receipt?.blockNumber ?? (await ethers.provider.getBlockNumber()));

    const [aliceIds, aliceHeads] = await upgraded.sharesFor(alice.address);
    expect([...aliceIds]).to.have.members([shareIdOf(shares.alice1), shareIdOf(shares.alice2)]);
    // the revoked share is migrated (its head keeps the revoker) and hidden by the read-time check
    const [bobIds] = await upgraded.sharesFor(bob.address);
    expect([...bobIds]).to.deep.equal([shareIdOf(shares.bobLive)]);
    expect((await upgraded.getShare(shareIdOf(shares.bobRevoked))).issuer).to.equal(issuer.address);
    expect(await upgraded.isShareValid(shareIdOf(shares.bobRevoked))).to.equal(false);
    expect((await upgraded.getShare(shareIdOf(shares.bobExpiring))).issuer).to.equal(ethers.ZeroAddress);
    expect(await upgraded.isShareValid(shareIdOf(shares.bobExpiring))).to.equal(false);
    expect(await upgraded.isShareValid(shareIdOf(shares.bobRemoved))).to.equal(false);

    // a migrated share reads like a new one: its head points at the block of a Shared event
    // that carries the full v1 payload and empty metadata
    for (const head of aliceHeads) expect(head.blockNumber).to.equal(upgradeBlock);
    const logs = await upgraded.queryFilter(upgraded.filters.Shared(undefined, undefined, shareIdOf(shares.alice2)), upgradeBlock, upgradeBlock);
    expect(logs).to.have.length(1);
    expect(logs[0].args.acp.toArray(true)).to.deep.equal([
      shares.alice2.issuer,
      shares.alice2.expiration,
      shares.alice2.recipient,
      shares.alice2.revokerData,
      shares.alice2.revokerContract,
      BigInt(shares.alice2.scope),
      shares.alice2.contracts,
      shares.alice2.handles,
      shares.alice2.sealingKey,
      shares.alice2.issuerSignature,
      shares.alice2.recipientSignature,
    ]);
    expect(logs[0].args.metadata).to.equal("0x");

    const counts = await upgraded.queryFilter(upgraded.filters.V1SharesMigrated(), upgradeBlock, upgradeBlock);
    expect(counts.map((l: any) => [l.args.recipient, l.args.migrated, l.args.dropped])).to.deep.equal([
      [alice.address, 2n, 0n],
      [bob.address, 2n, 1n],
    ]);
  });

  it("is a no-op when repeated, and does not bring back a migrated share that was then removed", async function () {
    const { registry, shares, V2 } = await v1WithShares();
    const upgraded: any = await upgrades.upgradeProxy(await registry.getAddress(), V2, {
      kind: "uups",
      call: { fn: "migrateV1Shares", args: [[alice.address]] },
    });
    await (await upgraded.connect(alice).removeShare(shareIdOf(shares.alice1))).wait();

    await expect(upgraded.migrateV1Shares([alice.address])).to.not.emit(upgraded, "Shared");
    const [ids] = await upgraded.sharesFor(alice.address);
    expect([...ids]).to.deep.equal([shareIdOf(shares.alice2)]);
  });

  it("migrates further pages after the upgrade, as the admin only", async function () {
    const { registry, shares, V2 } = await v1WithShares();
    const upgraded: any = await upgrades.upgradeProxy(await registry.getAddress(), V2, {
      kind: "uups",
      call: { fn: "migrateV1Shares", args: [[alice.address]] },
    });
    await expect(upgraded.connect(stranger).migrateV1Shares([bob.address])).to.be.revertedWithCustomError(
      upgraded,
      "NotAdminOrUpgrader",
    );
    expect((await upgraded.sharesFor(bob.address))[0]).to.have.length(0);

    await expect(upgraded.connect(admin).migrateV1Shares([bob.address]))
      .to.emit(upgraded, "V1SharesMigrated")
      .withArgs(bob.address, 2n, 1n);
    expect([...(await upgraded.sharesFor(bob.address))[0]]).to.deep.equal([shareIdOf(shares.bobLive)]);
  });

  it("keeps a share whose revoker reverts during the migration, and lists it once the revoker answers", async function () {
    const { registry, V2 } = await v1WithShares();
    const revoker: any = await (await ethers.getContractFactory("SwitchableRevoker")).deploy();
    const acp = acpFor(alice, "alice-flaky-revoker", { revokerContract: await revoker.getAddress(), revokerData: 7n });
    await (await registry.connect(issuer).share(acp)).wait();
    await (await revoker.setReverting(true)).wait();

    const upgraded: any = await upgrades.upgradeProxy(await registry.getAddress(), V2, {
      kind: "uups",
      call: { fn: "migrateV1Shares", args: [[alice.address]] },
    });
    const id = shareIdOf(acp);
    expect((await upgraded.getShare(id)).issuer).to.equal(issuer.address);
    expect(await upgraded.isShareValid(id)).to.equal(false); // fails closed while the revoker reverts

    await (await revoker.setReverting(false)).wait();
    expect(await upgraded.isShareValid(id)).to.equal(true);
    expect([...(await upgraded.sharesFor(alice.address))[0]]).to.include(id);
  });

  it("lets a migrated share be removed and posted again with labels", async function () {
    const { registry, shares, V2 } = await v1WithShares();
    const upgraded: any = await upgrades.upgradeProxy(await registry.getAddress(), V2, {
      kind: "uups",
      call: { fn: "migrateV1Shares", args: [[alice.address]] },
    });
    const id = shareIdOf(shares.alice1);
    await expect(upgraded.connect(issuer).share(shares.alice1, "0x03")).to.be.revertedWithCustomError(
      upgraded,
      "AlreadyShared",
    );
    await (await upgraded.connect(issuer).removeShare(id)).wait();
    await (await upgraded.connect(issuer).share(shares.alice1, "0x03")).wait();
    const head = await upgraded.getShare(id);
    const [log] = await upgraded.queryFilter(upgraded.filters.Shared(undefined, undefined, id), head.blockNumber, head.blockNumber);
    expect(log.args.metadata).to.equal("0x03");
  });
});
