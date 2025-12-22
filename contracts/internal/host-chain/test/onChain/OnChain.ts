import type { Signers } from "../types";
import { shouldBehaveLikeOnChain } from "./OnChain.behavior";
import { deployOnChainFixture, getTokensFromFaucet } from "./OnChain.fixture";
import hre from "hardhat";

describe("Unit tests", function () {
  before(async function () {
    this.signers = {} as Signers;

    // get tokens from faucet if we're on localfhenix and don't have a balance
    await getTokensFromFaucet();

    const { testContract, testContract2 } = await deployOnChainFixture();
    this.testContract = testContract;
    this.testContract2 = testContract2;

    // set admin account/signer
    const signers = await hre.ethers.getSigners();
    this.signers.admin = signers[0];
  });

  describe("OnChain", function () {
    shouldBehaveLikeOnChain();
  });
});
