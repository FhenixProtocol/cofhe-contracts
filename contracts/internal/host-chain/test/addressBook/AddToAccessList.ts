import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { installAddressBook } from "../helpers/addressBook";
import { taskManagerId } from "../../utils/addressBook";

const { ethers } = hre;

const ENV_KEYS = ["SAFE_ADMIN_ADDRESS", "SAFE_OWNER_KEY", "SAFE_BATCH_OUT"] as const;

async function deployTaskManager(admin: HardhatEthersSigner): Promise<any> {
  const TaskManager = await ethers.getContractFactory("TaskManager");
  const impl = await TaskManager.deploy();
  await impl.waitForDeployment();
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await ERC1967Proxy.deploy(
    await impl.getAddress(),
    TaskManager.interface.encodeFunctionData("initialize", [admin.address, 0]),
  );
  await proxy.waitForDeployment();
  return await ethers.getContractAt("TaskManager", await proxy.getAddress());
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

describe("task:addToAccessList", function () {
  const saved: Record<string, string | undefined> = {};
  let deployer: HardhatEthersSigner;
  let taskManager: any;
  let first: string;
  let second: string;

  before(function () {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
  });

  beforeEach(async function () {
    // Set rather than deleted: dotenv never overrides a variable that is already present.
    process.env.SAFE_ADMIN_ADDRESS = "";
    process.env.SAFE_OWNER_KEY = "";
    process.env.SAFE_BATCH_OUT = "";
    await ethers.provider.send("hardhat_reset", []);
    [deployer] = await ethers.getSigners();
    const book = await installAddressBook(deployer);
    taskManager = await deployTaskManager(deployer);
    await (await taskManager.grantRole(await taskManager.ACCESS_LIST_MANAGER_ROLE(), deployer.address)).wait();
    await (await book.setTm(taskManagerId(), await taskManager.getAddress())).wait();
    first = await book.getAddress();
    second = await (await deployTaskManager(deployer)).getAddress();
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

  async function handRoleToSafe(): Promise<any> {
    const safe = ethers.Wallet.createRandom().connect(ethers.provider);
    await (await deployer.sendTransaction({ to: safe.address, value: ethers.parseEther("1") })).wait();
    const role = await taskManager.ACCESS_LIST_MANAGER_ROLE();
    await (await taskManager.grantRole(role, safe.address)).wait();
    await (await taskManager.revokeRole(role, deployer.address)).wait();
    process.env.SAFE_ADMIN_ADDRESS = safe.address;
    return safe;
  }

  it("adds a single contract", async function () {
    await hre.run("task:addToAccessList", { accounts: first });
    expect(await taskManager.accessList(first)).to.equal(true);
    expect(await taskManager.accessList(second)).to.equal(false);
  });

  it("adds a list of contracts, ignoring duplicates and blanks", async function () {
    await hre.run("task:addToAccessList", { accounts: `${first}, ${second},${first.toLowerCase()},` });
    expect(await taskManager.accessList(first)).to.equal(true);
    expect(await taskManager.accessList(second)).to.equal(true);
  });

  it("is a no-op for accounts already on the list", async function () {
    await hre.run("task:addToAccessList", { accounts: first });
    await hre.run("task:addToAccessList", { accounts: `${first},${second}` });
    expect(await taskManager.accessList(first)).to.equal(true);
    expect(await taskManager.accessList(second)).to.equal(true);
  });

  it("refuses address(0) and an empty list", async function () {
    await expectRejection(hre.run("task:addToAccessList", { accounts: ethers.ZeroAddress }), /address\(0\)/);
    await expectRejection(hre.run("task:addToAccessList", { accounts: " , " }), /empty/);
  });

  it("adds as the Safe when the signer lacks the role", async function () {
    const safe = await handRoleToSafe();
    process.env.SAFE_OWNER_KEY = safe.privateKey;
    await hre.run("task:addToAccessList", { accounts: `${first},${second}` });
    expect(await taskManager.accessList(first)).to.equal(true);
    expect(await taskManager.accessList(second)).to.equal(true);
  });

  it("refuses when neither the signer nor the Safe holds the role", async function () {
    await handRoleToSafe();
    process.env.SAFE_ADMIN_ADDRESS = ethers.Wallet.createRandom().address;
    await expectRejection(hre.run("task:addToAccessList", { accounts: first }), /ACCESS_LIST_MANAGER_ROLE/);
  });

  it("writes a Safe batch when SAFE_OWNER_KEY is unset, changing nothing on chain", async function () {
    await hre.run("task:addToAccessList", { accounts: first });
    await handRoleToSafe();
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "access-list-")), "batch.json");
    await hre.run("task:addToAccessList", { accounts: `${first},${second}`, out: outPath });

    const batch = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(batch.transactions).to.have.length(1);
    expect(batch.transactions[0].to).to.equal(await taskManager.getAddress());
    expect(batch.transactions[0].data).to.equal(
      taskManager.interface.encodeFunctionData("addToAccessList", [[second]]),
    );
    expect(await taskManager.accessList(second)).to.equal(false);
  });
});
