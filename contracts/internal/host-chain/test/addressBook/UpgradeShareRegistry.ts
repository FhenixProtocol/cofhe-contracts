import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";

import { installAddressBook } from "../helpers/addressBook";
import { resolveTaskManager } from "../../utils/addressBook";

const { ethers, upgrades } = hre;

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const ENV_KEYS = [
  "AGGREGATOR_KEY",
  "VERIFIER_ADDRESS",
  "DECRYPT_RESULT_SIGNER",
  "TM_ADMIN_ADDRESS",
  "TM_ADMIN_DELAY",
  "SAFE_ADMIN_ADDRESS",
  "SAFE_OWNER_KEY",
  "SAFE_BATCH_OUT",
  "MAINTENANCE_ADDRESS",
  "REGISTER_TASK_MANAGER",
  "FULL_REDEPLOY",
] as const;

// deploy.ts loads ../.env with dotenv, which never overrides a variable that is already set,
// so set every one it reads rather than deleting it.
function setDeployEnv(deployer: string, safe: string, safeOwnerKey: string) {
  process.env.AGGREGATOR_KEY = ethers.Wallet.createRandom().privateKey;
  process.env.VERIFIER_ADDRESS = ethers.ZeroAddress;
  process.env.DECRYPT_RESULT_SIGNER = ethers.ZeroAddress;
  process.env.TM_ADMIN_ADDRESS = deployer;
  process.env.TM_ADMIN_DELAY = "";
  process.env.SAFE_ADMIN_ADDRESS = safe;
  process.env.SAFE_OWNER_KEY = safeOwnerKey;
  process.env.SAFE_BATCH_OUT = "";
  process.env.MAINTENANCE_ADDRESS = "";
  process.env.REGISTER_TASK_MANAGER = "";
  process.env.FULL_REDEPLOY = "";
}

async function implementationOf(proxy: string): Promise<string> {
  return ethers.getAddress("0x" + (await ethers.provider.getStorage(proxy, IMPLEMENTATION_SLOT)).slice(-40));
}

async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let message = "";
  try {
    await promise;
  } catch (error: any) {
    message = String(error?.message ?? error);
  }
  expect(message).to.match(pattern);
}

/**
 * A network deployed before the pointer-based registry: the ACL serves a first-version
 * ACPShareRegistry holding shares, and the Safe holds its roles after the handover. The upgrade
 * keeps the proxy and abandons those shares.
 */
describe("task:upgradeShareRegistry after the handover", function () {
  const saved: Record<string, string | undefined> = {};
  let finalAdmin: any;
  let registryAddress: string;
  let liveIds: Record<string, string>;
  let alice: any;
  let bob: any;

  const acpFor = (issuer: string, recipient: string, tag: string, expiration = 4102444800n) => ({
    issuer,
    expiration,
    recipient,
    revokerData: 0n,
    revokerContract: ethers.ZeroAddress,
    scope: 2,
    contracts: [],
    handles: [ethers.id(tag)],
    sealingKey: ethers.ZeroHash,
    issuerSignature: "0x" + "11".repeat(65),
    recipientSignature: "0x",
  });
  const shareIdOf = (acp: any) =>
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        [
          "tuple(address,uint64,address,uint256,address,uint8,address[],bytes32[],bytes32,bytes,bytes)",
        ],
        [Object.values(acp)],
      ),
    );

  before(async function () {
    this.timeout(300_000);
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    await ethers.provider.send("hardhat_reset", []);
    const signers = await ethers.getSigners();
    const [deployer, issuer] = signers;
    [alice, bob] = [signers[5], signers[6]];
    // An EOA stands in for the Safe: SAFE_OWNER_KEY is then its own key and the task sends directly.
    finalAdmin = ethers.Wallet.createRandom().connect(ethers.provider);
    setDeployEnv(deployer.address, finalAdmin.address, finalAdmin.privateKey);

    await installAddressBook(deployer);
    await hre.run("deploy", { reset: true });

    // Swap in a first-version registry, as deployed on the live networks, holding shares; the
    // deploy granted the Safe its roles on the registry it made, so grant them here too.
    const V1 = await ethers.getContractFactory("ACPShareRegistryV1");
    const v1: any = await upgrades.deployProxy(V1, [deployer.address], { kind: "uups", initializer: "initialize" });
    await v1.waitForDeployment();
    registryAddress = await v1.getAddress();
    await (await v1.grantRole(await v1.DEFAULT_ADMIN_ROLE(), finalAdmin.address)).wait();
    await (await v1.grantRole(await v1.UPGRADER_ROLE(), finalAdmin.address)).wait();
    const taskManager = await ethers.getContractAt("TaskManager", await resolveTaskManager(hre));
    const acl = await ethers.getContractAt("ACL", await taskManager.acl());
    await (await acl.setShareRegistry(registryAddress)).wait();

    const shares = {
      alice: acpFor(issuer.address, alice.address, "alice"),
      bob: acpFor(issuer.address, bob.address, "bob"),
      bobExpiring: acpFor(issuer.address, bob.address, "bob-expiring", BigInt(Math.floor(Date.now() / 1000)) + 10n ** 6n),
    };
    for (const acp of Object.values(shares)) await (await v1.connect(issuer).share(acp)).wait();
    liveIds = { alice: shareIdOf(shares.alice), bob: shareIdOf(shares.bob), bobExpiring: shareIdOf(shares.bobExpiring) };

    await (await deployer.sendTransaction({ to: finalAdmin.address, value: ethers.parseEther("1") })).wait();
    await hre.run("task:acceptAdminAsSafe");
    await hre.run("task:renounceDeployerRoles");
    expect(await v1.hasRole(await v1.UPGRADER_ROLE(), deployer.address)).to.equal(false);
  });

  after(function () {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it("validates only with --onlyvalidate, changing nothing", async function () {
    this.timeout(300_000);
    const before = await implementationOf(registryAddress);
    await hre.run("task:upgradeShareRegistry", { onlyvalidate: true });
    expect(await implementationOf(registryAddress)).to.equal(before);
  });

  it("writes one Safe batch when SAFE_OWNER_KEY is unset, changing nothing on chain", async function () {
    this.timeout(300_000);
    const before = await implementationOf(registryAddress);
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-share-registry-")), "batch.json");
    process.env.SAFE_OWNER_KEY = "";
    process.env.SAFE_BATCH_OUT = outPath;
    try {
      await hre.run("task:upgradeShareRegistry");
    } finally {
      process.env.SAFE_OWNER_KEY = finalAdmin.privateKey;
      process.env.SAFE_BATCH_OUT = "";
    }

    const V2 = await ethers.getContractFactory("ACPShareRegistry");
    const batch = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(batch.transactions).to.have.length(1);
    expect(batch.transactions[0].to).to.equal(registryAddress);
    const [newImplementation, call] = V2.interface.decodeFunctionData("upgradeToAndCall", batch.transactions[0].data);
    expect(await ethers.provider.getCode(newImplementation)).to.not.equal("0x");
    expect(call).to.equal("0x");
    expect(await implementationOf(registryAddress)).to.equal(before);
  });

  it("refuses when SAFE_ADMIN_ADDRESS does not hold UPGRADER_ROLE", async function () {
    this.timeout(300_000);
    process.env.SAFE_ADMIN_ADDRESS = ethers.Wallet.createRandom().address;
    try {
      await expectRejection(hre.run("task:upgradeShareRegistry"), /does not hold UPGRADER_ROLE/);
    } finally {
      process.env.SAFE_ADMIN_ADDRESS = finalAdmin.address;
    }
  });

  it("upgrades in place as the Safe, keeping the address and abandoning the v1 shares", async function () {
    this.timeout(300_000);
    const before = await implementationOf(registryAddress);
    await hre.run("task:upgradeShareRegistry");
    expect(await implementationOf(registryAddress)).to.not.equal(before);

    const registry: any = await ethers.getContractAt("ACPShareRegistry", registryAddress);
    expect((await registry.sharesFor(alice.address))[0]).to.have.length(0);
    expect((await registry.sharesFor(bob.address))[0]).to.have.length(0);
    expect(await registry.isShareValid(liveIds.alice)).to.equal(false);
    expect(await registry.hasRole(await registry.UPGRADER_ROLE(), finalAdmin.address)).to.equal(true);
  });

  it("re-runs as a no-op once upgraded", async function () {
    this.timeout(300_000);
    const before = await implementationOf(registryAddress);
    await hre.run("task:upgradeShareRegistry");
    expect(await implementationOf(registryAddress)).to.equal(before);
  });
});
