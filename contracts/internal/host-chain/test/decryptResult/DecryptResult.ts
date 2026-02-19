import type { Signers } from "../types";
import { shouldBehaveLikeDecryptResult } from "./DecryptResult.behavior";
import { deployDecryptResultFixture } from "./DecryptResult.fixture";
import hre from "hardhat";

describe("DecryptResult Tests", function () {
  before(async function () {
    this.signers = {} as Signers;

    const fixture = await deployDecryptResultFixture();
    this.taskManager = fixture.taskManager;
    this.plaintextsStorage = fixture.plaintextsStorage;
    this.acl = fixture.acl;
    this.owner = fixture.owner;
    this.testSigner = fixture.testSigner;
    this.otherAccount = fixture.otherAccount;

    // set admin account/signer
    const signers = await hre.ethers.getSigners();
    this.signers.admin = signers[0];
  });

  describe("PublishDecryptResult", function () {
    shouldBehaveLikeDecryptResult();
  });
});
