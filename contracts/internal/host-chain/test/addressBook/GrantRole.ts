import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { installAddressBook } from "../helpers/addressBook";
import { taskManagerId } from "../../utils/addressBook";
import { deployLinkedTaskManagerFactory } from "../taskManagerFactory";

const { ethers } = hre;

const ENV_KEYS = ["SAFE_ADMIN_ADDRESS", "SAFE_OWNER_KEY", "SAFE_BATCH_OUT"] as const;
const ROLE = "ACCESS_LIST_MANAGER_ROLE";

async function deployTaskManager(admin: HardhatEthersSigner): Promise<any> {
  const TaskManager = await deployLinkedTaskManagerFactory();
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

function batchPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grant-role-")), "batch.json");
}

describe("task:grantRole", function () {
  const saved: Record<string, string | undefined> = {};
  let deployer: HardhatEthersSigner;
  let taskManager: any;
  let role: string;
  let grantee: string;

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
    await (await book.setTm(taskManagerId(), await taskManager.getAddress())).wait();
    role = await taskManager[ROLE]();
    grantee = ethers.Wallet.createRandom().address;
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

  // An EOA stands in for the Safe. The deploy fixture uses a zero admin delay, so the transfer
  // can be accepted in the next block.
  async function handAdminToSafe(): Promise<any> {
    const safe = ethers.Wallet.createRandom().connect(ethers.provider);
    await (await deployer.sendTransaction({ to: safe.address, value: ethers.parseEther("1") })).wait();
    await (await taskManager.beginDefaultAdminTransfer(safe.address)).wait();
    await (await taskManager.connect(safe).acceptDefaultAdminTransfer()).wait();
    process.env.SAFE_ADMIN_ADDRESS = safe.address;
    return safe;
  }

  it("grants the role as the signer holding DEFAULT_ADMIN_ROLE", async function () {
    await hre.run("task:grantRole", { role: ROLE, account: grantee });
    expect(await taskManager.hasRole(role, grantee)).to.equal(true);
  });

  it("is a no-op when the account already holds the role, writing no batch", async function () {
    await hre.run("task:grantRole", { role: ROLE, account: grantee });
    await handAdminToSafe();
    const outPath = batchPath();
    await hre.run("task:grantRole", { role: ROLE, account: grantee, out: outPath });
    expect(fs.existsSync(outPath)).to.equal(false);
    expect(await taskManager.hasRole(role, grantee)).to.equal(true);
  });

  it("refuses a role the TaskManager does not declare", async function () {
    await expectRejection(hre.run("task:grantRole", { role: "NOT_A_ROLE", account: grantee }), /not declared/);
  });

  it("refuses a name that is not a *_ROLE constant", async function () {
    await expectRejection(hre.run("task:grantRole", { role: "grantRole", account: grantee }), /not a role name/);
  });

  it("refuses DEFAULT_ADMIN_ROLE", async function () {
    await expectRejection(
      hre.run("task:grantRole", { role: "DEFAULT_ADMIN_ROLE", account: grantee }),
      /beginDefaultAdminTransfer/,
    );
  });

  it("refuses address(0)", async function () {
    await expectRejection(hre.run("task:grantRole", { role: ROLE, account: ethers.ZeroAddress }), /address\(0\)/);
  });

  it("grants as the Safe when the signer lacks DEFAULT_ADMIN_ROLE", async function () {
    const safe = await handAdminToSafe();
    process.env.SAFE_OWNER_KEY = safe.privateKey;
    await hre.run("task:grantRole", { role: ROLE, account: grantee });
    expect(await taskManager.hasRole(role, grantee)).to.equal(true);
  });

  it("writes a Safe batch when SAFE_OWNER_KEY is unset, changing nothing on chain", async function () {
    await handAdminToSafe();
    const outPath = batchPath();
    await hre.run("task:grantRole", { role: ROLE, account: grantee, out: outPath });

    const batch = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(batch.transactions).to.have.length(1);
    expect(batch.transactions[0].to).to.equal(await taskManager.getAddress());
    expect(batch.transactions[0].data).to.equal(taskManager.interface.encodeFunctionData("grantRole", [role, grantee]));
    expect(await taskManager.hasRole(role, grantee)).to.equal(false);
  });

  it("AsSafe never sends as the signer, even when it holds DEFAULT_ADMIN_ROLE", async function () {
    process.env.SAFE_ADMIN_ADDRESS = ethers.Wallet.createRandom().address;
    const outPath = batchPath();
    await expectRejection(
      hre.run("task:grantRoleAsSafe", { role: ROLE, account: grantee, out: outPath }),
      /does not hold DEFAULT_ADMIN_ROLE/,
    );
    expect(fs.existsSync(outPath)).to.equal(false);
    expect(await taskManager.hasRole(role, grantee)).to.equal(false);
  });

  it("AsSafe writes a Safe batch when SAFE_OWNER_KEY is unset, changing nothing on chain", async function () {
    await handAdminToSafe();
    const outPath = batchPath();
    await hre.run("task:grantRoleAsSafe", { role: ROLE, account: grantee, out: outPath });

    const batch = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(batch.transactions).to.have.length(1);
    expect(batch.transactions[0].to).to.equal(await taskManager.getAddress());
    expect(batch.transactions[0].data).to.equal(taskManager.interface.encodeFunctionData("grantRole", [role, grantee]));
    expect(await taskManager.hasRole(role, grantee)).to.equal(false);
  });

  it("refuses when neither the signer nor the Safe holds DEFAULT_ADMIN_ROLE", async function () {
    await handAdminToSafe();
    process.env.SAFE_ADMIN_ADDRESS = ethers.Wallet.createRandom().address;
    await expectRejection(hre.run("task:grantRole", { role: ROLE, account: grantee }), /DEFAULT_ADMIN_ROLE/);
  });
});
