import { expect } from "chai";
import hre from "hardhat";

const { ethers, upgrades } = hre;

const ACP_TUPLE =
  "tuple(address issuer,uint64 expiration,address recipient,uint256 revokerData,address revokerContract,uint8 scope," +
  "address[] contracts,bytes32[] handles,bytes32 sealingKey,bytes issuerSignature,bytes recipientSignature)";
const SCOPE_HANDLES = 2;

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

describe("Issues #151/#152 — sharesFor gas bounding + pagination", function () {
  let issuer: any;
  let recipient: any;
  let registry: any;
  let gasBomb: any;
  let honestRevoker: any;

  function acp(overrides: Partial<Acp> = {}): Acp {
    return {
      issuer: issuer.address,
      expiration: 4102444800n,
      recipient: recipient.address,
      revokerData: 0n,
      revokerContract: ethers.ZeroAddress,
      scope: SCOPE_HANDLES,
      contracts: [],
      handles: [ethers.id("balance")],
      sealingKey: ethers.ZeroHash,
      issuerSignature: "0x" + "11".repeat(65),
      recipientSignature: "0x",
      ...overrides,
    };
  }

  before(async function () {
    [, issuer, recipient] = await ethers.getSigners();
  });

  beforeEach(async function () {
    const factory = await ethers.getContractFactory("ACPShareRegistry");
    registry = await upgrades.deployProxy(factory, [issuer.address], { kind: "uups", initializer: "initialize" });
    await registry.waitForDeployment();

    // Revoker mock: honest one returns false; gas bomb burns all forwarded gas via
    // tight sstore loop in an invalid() fallback, then reverts.
    gasBomb = await (await ethers.getContractFactory("GasBombRevoker")).deploy();
    await gasBomb.waitForDeployment();
    honestRevoker = await (await ethers.getContractFactory("HonestRevoker")).deploy();
    await honestRevoker.waitForDeployment();
  });

  it("#151: a gas-bomb revoker marks its share invalid without DoSing the whole query", async function () {
    const bombAcp = acp({ revokerData: 1n, revokerContract: await gasBomb.getAddress() });
    const okAcp = acp({ revokerData: 1n, revokerContract: await honestRevoker.getAddress() });

    await registry.connect(issuer).share(bombAcp, "0x");
    await registry.connect(issuer).share(okAcp, "0x");

    // isShareValid fails closed for the bombed share — cheaply, not by combustion:
    expect(await registry.isShareValid(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([ACP_TUPLE], [bombAcp])))).to.equal(false);
    expect(await registry.isShareValid(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([ACP_TUPLE], [okAcp])))).to.equal(true);

    // sharesFor filters the bomb out (fail-closed) and stays executable:
    const [ids, headers] = await registry.sharesFor(recipient.address);
    expect(ids.length).to.equal(1);
    expect(headers.length).to.equal(1);
    expect(ids[0]).to.equal(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([ACP_TUPLE], [okAcp])));
  });

  it("#152: sharesForPage reads a spam-inflated inbox without hitting the gas wall", async function () {
    // Post ~60 shares (the pre-fix wall sits far lower than this with revokers probing;
    // enough to make the point that pages always succeed where one bulk call may not)
    const acps: Acp[] = [];
    for (let i = 0; i < 60; i++) {
      const a = acp({ handles: [ethers.id(`share-${i}`)] });
      acps.push(a);
      await registry.connect(issuer).share(a, "0x");
    }

    // walk all pages with a small page size; every page succeeds on plain gas
    let offset = 0;
    let total = 0;
    let pages = 0;
    while (offset < 60) {
      const [, hdrs, nextOffset] = await registry.sharesForPage(recipient.address, offset, 10);
      total += hdrs.length;
      pages += 1;
      expect(Number(nextOffset)).to.equal(offset + 10); // stable, non-overlapping
      offset = Number(nextOffset);
    }
    expect(total).to.equal(60);
    expect(pages).to.equal(6);

    // offset past the end returns an empty page and the set length
    const [, empty, next] = await registry.sharesForPage(recipient.address, 60, 5);
    expect(empty.length).to.equal(0);
    expect(next).to.equal(60n);

    await expect(registry.sharesForPage(recipient.address, 0, 0)).to.be.revertedWithCustomError(registry, "InvalidPage");
  });
});
