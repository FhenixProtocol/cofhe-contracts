import type { Signers } from "../types";
import { shouldBehaveLikeBatchVerifyInput } from "./VerifyInput.behavior";
import { deployDecryptResultFixture } from "../decryptResult/DecryptResult.fixture";
import hre from "hardhat";

describe("VerifyInput Tests", function () {
  before(async function () {
    this.signers = {} as Signers;

    // Reuse the decrypt-result fixture: it wires up ACL, PlaintextsStorage and
    // security zones. We additionally enable input signature verification.
    const fixture = await deployDecryptResultFixture();
    this.taskManager = fixture.taskManager;
    this.plaintextsStorage = fixture.plaintextsStorage;
    this.acl = fixture.acl;
    this.owner = fixture.owner;
    this.testSigner = fixture.testSigner;
    this.otherAccount = fixture.otherAccount;

    await this.taskManager.setVerifierSigner(this.testSigner.address);

    const signers = await hre.ethers.getSigners();
    this.signers.admin = signers[0];
  });

  describe("BatchVerifyInput", function () {
    shouldBehaveLikeBatchVerifyInput();
  });
});
