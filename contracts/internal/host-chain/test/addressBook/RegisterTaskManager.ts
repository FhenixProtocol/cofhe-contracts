import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { installAddressBook } from "../helpers/addressBook";
import { taskManagerId } from "../../utils/addressBook";

const { ethers } = hre;

async function deployTaskManager(admin: HardhatEthersSigner): Promise<string> {
  const TaskManager = await ethers.getContractFactory("TaskManager");
  const impl = await TaskManager.deploy();
  await impl.waitForDeployment();
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await ERC1967Proxy.deploy(
    await impl.getAddress(),
    TaskManager.interface.encodeFunctionData("initialize", [admin.address, 0]),
  );
  await proxy.waitForDeployment();
  return await proxy.getAddress();
}

describe("task:registerTaskManager", function () {
  let deployer: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let book: any;
  let existing: string;

  const savedSafeAdmin = process.env.SAFE_ADMIN_ADDRESS;

  beforeEach(async function () {
    // Set rather than deleted: dotenv never overrides a variable that is already present.
    process.env.SAFE_ADMIN_ADDRESS = "";
    await ethers.provider.send("hardhat_reset", []);
    [deployer, other] = await ethers.getSigners();
    book = await installAddressBook(deployer);
    existing = await deployTaskManager(deployer);
  });

  after(function () {
    if (savedSafeAdmin === undefined) {
      delete process.env.SAFE_ADMIN_ADDRESS;
    } else {
      process.env.SAFE_ADMIN_ADDRESS = savedSafeAdmin;
    }
  });

  it("points the id at an already deployed TaskManager", async function () {
    await hre.run("task:registerTaskManager", { address: existing });
    expect(await book.getTm(taskManagerId())).to.equal(existing);
  });

  it("is idempotent for the same address", async function () {
    await hre.run("task:registerTaskManager", { address: existing });
    await hre.run("task:registerTaskManager", { address: existing });
    expect(await book.getTm(taskManagerId())).to.equal(existing);
  });

  it("refuses to repoint an id that is already set unless forced", async function () {
    await hre.run("task:registerTaskManager", { address: existing });
    const another = await deployTaskManager(deployer);
    await expect(hre.run("task:registerTaskManager", { address: another })).to.be.rejectedWith(/already points at/);
    expect(await book.getTm(taskManagerId())).to.equal(existing);
    await hre.run("task:registerTaskManager", { address: another, force: true });
    expect(await book.getTm(taskManagerId())).to.equal(another);
  });

  it("refuses an address without code", async function () {
    await expect(hre.run("task:registerTaskManager", { address: other.address })).to.be.rejectedWith(/No code at/);
  });

  it("refuses a contract that is not a TaskManager", async function () {
    await expect(hre.run("task:registerTaskManager", { address: await book.getAddress() })).to.be.rejectedWith(
      /does not look like a TaskManager/,
    );
  });

  it("leaves the book's ownership alone without SAFE_ADMIN_ADDRESS", async function () {
    await hre.run("task:registerTaskManager", { address: existing });
    expect(await book.owner()).to.equal(deployer.address);
    expect(await book.pendingOwner()).to.equal(ethers.ZeroAddress);
  });

  it("nominates SAFE_ADMIN_ADDRESS as the book's pending owner", async function () {
    process.env.SAFE_ADMIN_ADDRESS = other.address;
    await hre.run("task:registerTaskManager", { address: existing });
    expect(await book.getTm(taskManagerId())).to.equal(existing);
    expect(await book.owner()).to.equal(deployer.address);
    expect(await book.pendingOwner()).to.equal(other.address);

    // Re-running is a no-op, and the nominee accepts exactly as task:acceptAdminAsSafe does.
    await hre.run("task:registerTaskManager", { address: existing });
    expect(await book.pendingOwner()).to.equal(other.address);
    await (await book.connect(other).acceptOwnership()).wait();
    expect(await book.owner()).to.equal(other.address);
  });

  it("refuses when the signer does not own the book", async function () {
    await (await book.connect(deployer).transferOwnership(other.address)).wait();
    await (await book.connect(other).acceptOwnership()).wait();
    await expect(hre.run("task:registerTaskManager", { address: existing })).to.be.rejectedWith(/is owned by/);
  });
});
