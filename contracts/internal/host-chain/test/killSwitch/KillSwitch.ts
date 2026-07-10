import { expect } from "chai";
import hre from "hardhat";
import type { Contract } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { deployOnChainFixture } from "../onChain/OnChain.fixture";

const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

// A valid euint8 return type and security zone within the fixture's configured range (-128..127).
const EUINT8 = 2;
const SECURITY_ZONE = 0;

// FunctionId.trivialEncrypt — the one non-random plaintext op createTask accepts.
const FUNCTION_ID_TRIVIAL_ENCRYPT = 26;
// trivialEncrypt extraInputs are [valueToEncrypt, toType, securityZone]; these pass
// createTask's own validation so the kill-switch is the only remaining revert path.
const TRIVIAL_ENCRYPT_EXTRA_INPUTS = [1, EUINT8, SECURITY_ZONE];

// Minimal EncryptedInput { uint256 ctHash; uint8 securityZone; uint8 utype; bytes signature }.
// The values only need to reach the kill-switch gate; verifyInput's signer check runs after it.
const DUMMY_INPUT = {
  ctHash: 1n,
  securityZone: SECURITY_ZONE,
  utype: EUINT8,
  signature: "0x",
};

describe("TaskManager isEnabled kill-switch", function () {
  let taskManager: Contract;
  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  before(async function () {
    await deployOnChainFixture();
    [owner, other] = await hre.ethers.getSigners();
    taskManager = await hre.ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS);
  });

  // Start every test from the enabled baseline so they are order-independent.
  beforeEach(async function () {
    await taskManager.connect(owner).enable();
  });

  it("gates createRandomTask when disabled", async function () {
    await taskManager.connect(owner).disable();

    await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE))
      .to.be.revertedWithCustomError(taskManager, "CofheIsUnavailable");
  });

  it("allows createRandomTask once re-enabled", async function () {
    await taskManager.connect(owner).disable();
    await taskManager.connect(owner).enable();

    await expect(taskManager.connect(other).createRandomTask(EUINT8, 1, SECURITY_ZONE)).to.not.be.reverted;
  });

  it("gates verifyInput when disabled", async function () {
    await taskManager.connect(owner).disable();

    await expect(taskManager.connect(other).verifyInput(DUMMY_INPUT, other.address))
      .to.be.revertedWithCustomError(taskManager, "CofheIsUnavailable");
  });

  it("does not revert verifyInput with CofheIsUnavailable once re-enabled", async function () {
    // beforeEach re-enables. verifyInput may still revert on its signer check
    // (verifierSigner defaults to address(1) in the fixture), so we assert only
    // that the kill-switch is specifically not the failure mode.
    await expect(taskManager.connect(other).verifyInput(DUMMY_INPUT, other.address))
      .to.not.be.revertedWithCustomError(taskManager, "CofheIsUnavailable");
  });

  it("gates createTask when disabled", async function () {
    // createTask is gated indirectly: it routes through sendEventCreated (private onlyIfEnabled),
    // so a disabled TaskManager reverts and rolls back the earlier acl.allowTransient.
    await taskManager.connect(owner).disable();

    await expect(
      taskManager
        .connect(other)
        .createTask(EUINT8, FUNCTION_ID_TRIVIAL_ENCRYPT, [], TRIVIAL_ENCRYPT_EXTRA_INPUTS)
    ).to.be.revertedWithCustomError(taskManager, "CofheIsUnavailable");
  });
});
