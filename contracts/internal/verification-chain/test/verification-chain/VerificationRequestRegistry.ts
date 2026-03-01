import type { Signers } from "../types";
import { shouldBehaveLikeVerificationRequestRegistry } from "./VerificationRequestRegistry.behavior";
import { deployVerificationRequestRegistryFixture } from "./VerificationRequestRegistry.fixture";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("VerificationRequestRegistry Tests", function () {
  beforeEach(async function () {
    this.signers = {} as Signers;

    const fixture = await loadFixture(deployVerificationRequestRegistryFixture);
    this.verificationRegistry = fixture.contract;
    this.owner = fixture.owner;
    this.otherAccount = fixture.otherAccount;

    const signers = await hre.ethers.getSigners();
    this.signers.admin = signers[0];
  });

  describe("VerificationRequestRegistry", function () {
    shouldBehaveLikeVerificationRequestRegistry();
  });
});
