import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre from "hardhat";

import { installAddressBook } from "../helpers/addressBook";
import { resolveTaskManager } from "../../utils/addressBook";

const { ethers } = hre;

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

async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let message = "";
  try {
    await promise;
  } catch (error: any) {
    message = String(error?.message ?? error);
  }
  expect(message).to.match(pattern);
}

describe("task:set*SignerAsSafe", function () {
  const saved: Record<string, string | undefined> = {};
  let taskManager: any;
  let finalAdmin: any;

  before(async function () {
    this.timeout(300_000);
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    await ethers.provider.send("hardhat_reset", []);
    const [deployer] = await ethers.getSigners();
    // An EOA stands in for the Safe: SAFE_OWNER_KEY is then its own key and the task sends directly.
    finalAdmin = ethers.Wallet.createRandom().connect(ethers.provider);
    setDeployEnv(deployer.address, finalAdmin.address, finalAdmin.privateKey);

    await installAddressBook(deployer);
    await hre.run("deploy", { reset: true });
    await (await deployer.sendTransaction({ to: finalAdmin.address, value: ethers.parseEther("1") })).wait();
    await hre.run("task:acceptAdminAsSafe");
    await hre.run("task:renounceDeployerRoles");
    taskManager = await ethers.getContractAt("TaskManager", await resolveTaskManager(hre));
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

  it("sets the verifier signer as the final admin and leaves the other signer alone", async function () {
    const verifier = ethers.Wallet.createRandom().address;
    const decryptBefore = await taskManager.decryptResultSigner();
    await hre.run("task:setVerifierSignerAsSafe", { address: verifier });
    expect(await taskManager.verifierSigner()).to.equal(verifier);
    expect(await taskManager.decryptResultSigner()).to.equal(decryptBefore);
  });

  it("sets the decrypt-result signer as the final admin", async function () {
    const decrypt = ethers.Wallet.createRandom().address;
    await hre.run("task:setDecryptResultSignerAsSafe", { address: decrypt });
    expect(await taskManager.decryptResultSigner()).to.equal(decrypt);
  });

  it("is a no-op when the signer already matches", async function () {
    const current = await taskManager.verifierSigner();
    await hre.run("task:setVerifierSignerAsSafe", { address: current });
    expect(await taskManager.verifierSigner()).to.equal(current);
  });

  it("refuses address(0) and the Safe itself", async function () {
    await expectRejection(hre.run("task:setVerifierSignerAsSafe", { address: ethers.ZeroAddress }), /disables verification/);
    await expectRejection(hre.run("task:setDecryptResultSignerAsSafe", { address: finalAdmin.address }), /not an admin/);
  });

  it("writes one Safe batch with both setters when SAFE_OWNER_KEY is unset, changing nothing on chain", async function () {
    const verifier = ethers.Wallet.createRandom().address;
    const decrypt = ethers.Wallet.createRandom().address;
    const verifierBefore = await taskManager.verifierSigner();
    const decryptBefore = await taskManager.decryptResultSigner();
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "set-signers-")), "batch.json");
    process.env.SAFE_OWNER_KEY = "";
    process.env.SAFE_BATCH_OUT = outPath;
    try {
      await hre.run("task:setSignersAsSafe", { verifier, decrypt });
    } finally {
      process.env.SAFE_OWNER_KEY = finalAdmin.privateKey;
      process.env.SAFE_BATCH_OUT = "";
    }

    const batch = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const tmAddress = await taskManager.getAddress();
    expect(batch.transactions).to.have.length(2);
    expect(batch.transactions[0].to).to.equal(tmAddress);
    expect(batch.transactions[0].data).to.equal(taskManager.interface.encodeFunctionData("setVerifierSigner", [verifier]));
    expect(batch.transactions[1].to).to.equal(tmAddress);
    expect(batch.transactions[1].data).to.equal(
      taskManager.interface.encodeFunctionData("setDecryptResultSigner", [decrypt]),
    );
    expect(await taskManager.verifierSigner()).to.equal(verifierBefore);
    expect(await taskManager.decryptResultSigner()).to.equal(decryptBefore);
  });
});
