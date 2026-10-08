import { expect } from "chai";
import hre from "hardhat";
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
 * pointer-based one: the layout check passes, the proxy keeps its address and roles, and the first
 * version's shares are abandoned (left in its storage, unread).
 */
describe("ACPShareRegistry: in-place upgrade from v1", function () {
  let admin: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;

  const acpFor = (recipient: HardhatEthersSigner, tag: string): Acp => ({
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
  });

  async function v1WithShare() {
    [admin, issuer, alice] = await ethers.getSigners();
    const V1 = await ethers.getContractFactory("ACPShareRegistryV1");
    const registry: any = await upgrades.deployProxy(V1, [admin.address], { kind: "uups", initializer: "initialize" });
    await registry.waitForDeployment();
    const acp = acpFor(alice, "alice");
    await (await registry.connect(issuer).share(acp)).wait();
    expect(await registry.isShareValid(shareIdOf(acp))).to.equal(true);
    return { registry, acp, V2: await ethers.getContractFactory("ACPShareRegistry") };
  }

  it("passes the OpenZeppelin layout check", async function () {
    const { registry, V2 } = await v1WithShare();
    await upgrades.validateUpgrade(await registry.getAddress(), V2, { kind: "uups" });
  });

  it("keeps the address and roles, and abandons the first version's shares", async function () {
    const { registry, acp, V2 } = await v1WithShare();
    const address = await registry.getAddress();
    const upgraded: any = await upgrades.upgradeProxy(address, V2, { kind: "uups" });

    expect(await upgraded.getAddress()).to.equal(address);
    expect(await upgraded.hasRole(await upgraded.UPGRADER_ROLE(), admin.address)).to.equal(true);
    expect((await upgraded.sharesFor(alice.address))[0]).to.have.length(0);
    expect(await upgraded.isShareValid(shareIdOf(acp))).to.equal(false);
  });

  it("accepts the same ACP again after the upgrade, now with labels", async function () {
    const { registry, acp, V2 } = await v1WithShare();
    const upgraded: any = await upgrades.upgradeProxy(await registry.getAddress(), V2, { kind: "uups" });
    const id = shareIdOf(acp);

    await (await upgraded.connect(issuer).share(acp, "0x03")).wait();
    expect([...(await upgraded.sharesFor(alice.address))[0]]).to.deep.equal([id]);
    const header = await upgraded.getShare(id);
    const [log] = await upgraded.queryFilter(upgraded.filters.Shared(undefined, undefined, id), header.blockNumber, header.blockNumber);
    expect(log.args.metadata).to.equal("0x03");
  });
});
