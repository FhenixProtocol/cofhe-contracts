import { expect } from "chai";
import hre from "hardhat";

import { installAddressBook } from "../helpers/addressBook";
import { addressBookAddress, resolveTaskManager, taskManagerId } from "../../utils/addressBook";

const { ethers } = hre;

const ENV_KEYS = [
  "AGGREGATOR_KEY",
  "VERIFIER_ADDRESS",
  "DECRYPT_RESULT_SIGNER",
  "TM_ADMIN_ADDRESS",
  "TM_ADMIN_DELAY",
  "SAFE_ADMIN_ADDRESS",
  "SAFE_OWNER_KEY",
  "MAINTENANCE_ADDRESS",
  "REGISTER_TASK_MANAGER",
  "FULL_REDEPLOY",
] as const;

// deploy.ts loads ../.env with dotenv, which never overrides a variable that is already set,
// so set every one it reads rather than deleting it.
function setDeployEnv(deployer: string, safe = "", safeOwnerKey = "") {
  process.env.AGGREGATOR_KEY = ethers.Wallet.createRandom().privateKey;
  process.env.VERIFIER_ADDRESS = ethers.ZeroAddress;
  process.env.DECRYPT_RESULT_SIGNER = ethers.ZeroAddress;
  process.env.TM_ADMIN_ADDRESS = deployer;
  process.env.TM_ADMIN_DELAY = "";
  process.env.SAFE_ADMIN_ADDRESS = safe;
  process.env.SAFE_OWNER_KEY = safeOwnerKey;
  process.env.MAINTENANCE_ADDRESS = "";
  process.env.REGISTER_TASK_MANAGER = "";
  process.env.FULL_REDEPLOY = "";
}

describe("hardhat deploy against the address book", function () {
  const saved: Record<string, string | undefined> = {};

  before(function () {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
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

  it("registers a fresh TaskManager, then upgrades it in place on a second run", async function () {
    this.timeout(300_000);
    await ethers.provider.send("hardhat_reset", []);
    const [deployer] = await ethers.getSigners();
    setDeployEnv(deployer.address);

    const book = await installAddressBook(deployer);
    await hre.run("deploy", { reset: true });
    const first = await resolveTaskManager(hre);
    expect(await ethers.provider.getCode(first)).to.not.equal("0x");
    expect(await book.getTm(taskManagerId())).to.equal(first);
    const taskManager = await ethers.getContractAt("TaskManager", first);
    const acl = await taskManager.acl();
    const plaintextsStorage = await taskManager.plaintextsStorage();

    await hre.run("deploy", { reset: true });
    expect(await resolveTaskManager(hre)).to.equal(first);
    expect(await taskManager.acl()).to.equal(acl);
    expect(await taskManager.plaintextsStorage()).to.equal(plaintextsStorage);
    expect(addressBookAddress()).to.equal(await book.getAddress());
  });

  it("hands over to an EOA that accepts directly with its own key", async function () {
    this.timeout(300_000);
    await ethers.provider.send("hardhat_reset", []);
    const [deployer] = await ethers.getSigners();
    const newOwner = ethers.Wallet.createRandom().connect(ethers.provider);
    setDeployEnv(deployer.address, newOwner.address, newOwner.privateKey);

    const book = await installAddressBook(deployer);
    await hre.run("deploy", { reset: true });
    // Funding mines a block, so the zero admin delay used on local networks has passed.
    await (await deployer.sendTransaction({ to: newOwner.address, value: ethers.parseEther("1") })).wait();
    await hre.run("task:acceptAdminAsSafe");

    expect(await book.owner()).to.equal(newOwner.address);
    const taskManager = await ethers.getContractAt("TaskManager", await resolveTaskManager(hre));
    const acl = await ethers.getContractAt("ACL", await taskManager.acl());
    const plaintextsStorage = await ethers.getContractAt("PlaintextsStorage", await taskManager.plaintextsStorage());
    for (const contract of [taskManager, acl, plaintextsStorage]) {
      expect(await contract.defaultAdmin()).to.equal(newOwner.address);
    }
  });

  it("leaves a fresh mainnet TaskManager disabled with the access list on", async function () {
    this.timeout(300_000);
    await ethers.provider.send("hardhat_reset", []);
    const [deployer, , safe, maintenance] = await ethers.getSigners();
    setDeployEnv(deployer.address, safe.address);
    process.env.MAINTENANCE_ADDRESS = maintenance.address;
    // Mainnet deploys require code at SAFE_ADMIN_ADDRESS; a stub stands in for the Safe.
    await ethers.provider.send("hardhat_setCode", [safe.address, "0x00"]);
    const networkConfig = hre.network.config as any;
    const chainId = networkConfig.chainId;
    networkConfig.chainId = 1;
    try {
      await installAddressBook(deployer);
      await hre.run("deploy", { reset: true });
    } finally {
      networkConfig.chainId = chainId;
    }

    const taskManager = await ethers.getContractAt("TaskManager", await resolveTaskManager(hre));
    expect(await taskManager.isEnabled()).to.equal(false);
    expect(await taskManager.accessListEnabled()).to.equal(true);
    expect(await taskManager.hasRole(await taskManager.PAUSER_ROLE(), maintenance.address)).to.equal(true);
  });

  it("nominates SAFE_ADMIN_ADDRESS as the book's pending owner", async function () {
    this.timeout(300_000);
    await ethers.provider.send("hardhat_reset", []);
    const [deployer, , safe] = await ethers.getSigners();
    setDeployEnv(deployer.address, safe.address);

    const book = await installAddressBook(deployer);
    await hre.run("deploy", { reset: true });

    expect(await book.owner()).to.equal(deployer.address);
    expect(await book.pendingOwner()).to.equal(safe.address);
    const taskManager = await ethers.getContractAt("TaskManager", await resolveTaskManager(hre));
    const [pendingAdmin] = await taskManager.pendingDefaultAdmin();
    expect(pendingAdmin).to.equal(safe.address);
  });

  it("aborts before deploying anything when the book fails for a reason other than TaskManagerNotSet", async function () {
    this.timeout(300_000);
    await ethers.provider.send("hardhat_reset", []);
    const [deployer] = await ethers.getSigners();
    setDeployEnv(deployer.address);

    const Reverting = await ethers.getContractFactory("RevertingAddressBook");
    const temp = await Reverting.deploy();
    await temp.waitForDeployment();
    await ethers.provider.send("hardhat_setCode", [
      addressBookAddress(),
      await ethers.provider.getCode(await temp.getAddress()),
    ]);
    // `owner` is the contract's only state variable, so it lives in slot 0.
    await ethers.provider.send("hardhat_setStorageAt", [
      addressBookAddress(),
      "0x0",
      ethers.zeroPadValue(deployer.address, 32),
    ]);

    const nonceBefore = await ethers.provider.getTransactionCount(deployer.address);
    await expect(hre.run("deploy", { reset: true })).to.be.rejectedWith(/Boom|unknown custom error|revert/);
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonceBefore);
  });
});
