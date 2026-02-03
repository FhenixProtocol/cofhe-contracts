import type { Signers } from "../types";
import { shouldBehaveLikeDecryptResult } from "./DecryptResult.behavior";
import { deployDecryptResultFixture, getTokensFromFaucet } from "./DecryptResult.fixture";
import hre from "hardhat";

describe("DecryptResult Tests", function () {
  before(async function () {
    this.signers = {} as Signers;

    // get tokens from faucet if we're on localfhenix and don't have a balance
    await getTokensFromFaucet();

    const fixture = await deployDecryptResultFixture();
    this.taskManager = fixture.taskManager;
    this.plaintextsStorage = fixture.plaintextsStorage;
    this.owner = fixture.owner;
    this.testSigner = fixture.testSigner;
    this.otherAccount = fixture.otherAccount;
    this.originalSigner = fixture.originalSigner;

    // set admin account/signer
    const signers = await hre.ethers.getSigners();
    this.signers.admin = signers[0];
  });

  after(async function () {
    // Restore the original decrypt result signer after tests
    if (this.taskManager && this.owner && this.originalSigner) {
      console.log("Restoring original decryptResultSigner:", this.originalSigner);
      await this.taskManager.connect(this.owner).setDecryptResultSigner(this.originalSigner);
    }
  });

  describe("PublishDecryptResult", function () {
    shouldBehaveLikeDecryptResult();
  });
});
