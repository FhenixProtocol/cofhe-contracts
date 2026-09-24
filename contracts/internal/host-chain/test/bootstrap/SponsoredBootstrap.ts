import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { taskManagerAddress } from "../../utils/taskManagerAddress";

const { ethers } = hre;

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const OWNABLE_SLOT = "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300";
// The mechanism under test does not depend on the address, only on who owns what, so this stays
// hermetic - no committed keys, no CreateX.
const PROXY_ADDRESS = taskManagerAddress();

/**
 * Installs ERC1967Proxy runtime at a fixed address pointing at `implementation`, then runs
 * `initData` against it - the same trick OnChain.fixture.ts uses, because a proxy cannot be
 * `deployProxy`d to a chosen address.
 */
async function installProxyAt(target: string, implementation: string, initData: string) {
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const temp = await ERC1967Proxy.deploy(implementation, "0x");
  await temp.waitForDeployment();
  await ethers.provider.send("hardhat_setCode", [
    target,
    await ethers.provider.getCode(await temp.getAddress()),
  ]);
  await ethers.provider.send("hardhat_setStorageAt", [
    target,
    IMPL_SLOT,
    ethers.zeroPadValue(implementation, 32),
  ]);
  const [signer] = await ethers.getSigners();
  await (await signer.sendTransaction({ to: target, data: initData })).wait();
}

/**
 * The sponsored bootstrap exists because the canonical proxy is unavoidably born owned by a
 * publicly-known key, and on mainnet that account cannot be funded - a hostile EIP-7702
 * delegation forwards any incoming value out inside the funding transaction itself.
 *
 * What these assert is the property that makes the workaround sound: the bootstrap account
 * authorizes the migration while spending nothing, because delegated code runs with
 * `msg.sender` set to the account that signed the authorization, not the account that paid.
 */
describe("Sponsored bootstrap (EIP-7702)", function () {
  let sponsor: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let bootstrap: any;
  let executor: any;
  let taskManagerImpl: string;
  let migrationData: string;

  beforeEach(async function () {
    await ethers.provider.send("hardhat_reset", []);
    [sponsor, admin, stranger] = await ethers.getSigners();

    // A throwaway stand-in for the public bootstrap key. It is never funded.
    bootstrap = ethers.Wallet.createRandom().connect(ethers.provider);

    const stubFactory = await ethers.getContractFactory("DeterministicTM");
    const stub = await stubFactory.deploy();
    await stub.waitForDeployment();
    await installProxyAt(
      PROXY_ADDRESS,
      await stub.getAddress(),
      stubFactory.interface.encodeFunctionData("initialize", [bootstrap.address]),
    );

    const tmFactory = await ethers.getContractFactory("TaskManager");
    const impl = await tmFactory.deploy();
    await impl.waitForDeployment();
    taskManagerImpl = await impl.getAddress();
    migrationData = tmFactory.interface.encodeFunctionData("initializeV2", [admin.address, 600]);

    const executorFactory = await ethers.getContractFactory("BootstrapExecutor");
    executor = await executorFactory.deploy(sponsor.address);
    await executor.waitForDeployment();
  });

  async function runSponsored(from: HardhatEthersSigner = sponsor) {
    const authorization = await bootstrap.authorize({
      address: await executor.getAddress(),
      chainId: (await ethers.provider.getNetwork()).chainId,
      nonce: await ethers.provider.getTransactionCount(bootstrap.address),
    });
    const tx = await from.sendTransaction({
      type: 4,
      to: bootstrap.address,
      data: executor.interface.encodeFunctionData("bootstrap", [
        ethers.ZeroAddress, // CreateX - unused, the proxy already has code
        ethers.ZeroHash,
        "0x",
        PROXY_ADDRESS,
        taskManagerImpl,
        migrationData,
      ]),
      authorizationList: [authorization],
    } as any);
    return tx.wait();
  }

  it("migrates the proxy without the bootstrap account ever holding a balance", async function () {
    expect(await ethers.provider.getBalance(bootstrap.address)).to.equal(0n);

    await runSponsored();

    const taskManager = (await ethers.getContractFactory("TaskManager")).attach(PROXY_ADDRESS) as any;
    expect(await taskManager.defaultAdmin()).to.equal(admin.address);

    // The whole point: it never held or spent anything, and the sponsor paid.
    expect(await ethers.provider.getBalance(bootstrap.address)).to.equal(0n);
  });

  it("consumes one nonce per authorization, so a stale one cannot be replayed", async function () {
    // EIP-7702 increments the authority's nonce when the authorization is applied, even though
    // the account sends no transaction. That is why the task reads the nonce immediately before
    // signing: anything touching the account in between invalidates the authorization.
    expect(await ethers.provider.getTransactionCount(bootstrap.address)).to.equal(0);
    await runSponsored();
    expect(await ethers.provider.getTransactionCount(bootstrap.address)).to.equal(1);
    expect(await ethers.provider.getBalance(bootstrap.address)).to.equal(0n);
  });

  it("grants the admin the operational roles, so the proxy is not left bricked", async function () {
    await runSponsored();
    const taskManager = (await ethers.getContractFactory("TaskManager")).attach(PROXY_ADDRESS) as any;
    for (const role of ["UPGRADER_ROLE", "PAUSER_ROLE", "CONFIG_MANAGER_ROLE"]) {
      expect(await taskManager.hasRole(await taskManager[role](), admin.address), role).to.equal(true);
    }
  });

  it("leaves intake disabled - migrating must not open the kill switch", async function () {
    await runSponsored();
    const taskManager = (await ethers.getContractFactory("TaskManager")).attach(PROXY_ADDRESS) as any;
    expect(await taskManager.isEnabled()).to.equal(false);
  });

  it("installs the delegation on the bootstrap account", async function () {
    await runSponsored();
    const code = await ethers.provider.getCode(bootstrap.address);
    expect(code.startsWith("0xef0100")).to.equal(true);
    expect(code.toLowerCase()).to.contain((await executor.getAddress()).slice(2).toLowerCase());
  });

  it("abandons the legacy Ownable owner, which is what initializeV2 was gated on", async function () {
    await runSponsored();
    const raw = await ethers.provider.getStorage(PROXY_ADDRESS, OWNABLE_SLOT);
    // The slot is reserved, not cleared - the point is that it no longer authorizes anything,
    // since TaskManager._authorizeUpgrade is onlyRole(UPGRADER_ROLE).
    expect(ethers.getAddress("0x" + raw.slice(-40))).to.equal(bootstrap.address);
    const taskManager = (await ethers.getContractFactory("TaskManager")).attach(PROXY_ADDRESS) as any;
    expect(await taskManager.hasRole(await taskManager.UPGRADER_ROLE(), bootstrap.address)).to.equal(
      false,
    );
  });

  it("refuses a caller that is not the sponsor", async function () {
    await expect(runSponsored(stranger)).to.be.revertedWithCustomError(executor, "NotSponsor");
  });

  it("cannot be replayed once migrated", async function () {
    await runSponsored();
    await expect(runSponsored()).to.be.revertedWithCustomError(executor, "UpgradeFailed");
  });
});
