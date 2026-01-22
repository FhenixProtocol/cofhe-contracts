import type { Signers } from "../types";
import { shouldBehaveLikeTaskManagerERC2771 } from "./TaskManager.behavior";
import { deployTaskManagerFixture, getTokensFromFaucet } from "./TaskManager.fixture";
import hre from "hardhat";

describe("TaskManager Tests", function () {
  before(async function () {
    this.signers = {} as Signers;

    // get tokens from faucet if we're on localfhenix and don't have a balance
    await getTokensFromFaucet();

    const { taskManager, taskManagerAddress } = await deployTaskManagerFixture();
    this.taskManager = taskManager;
    this.taskManagerAddress = taskManagerAddress;

    // set admin account/signer
    const signers = await hre.ethers.getSigners();
    this.signers.admin = signers[0];
  });

  describe("TaskManager", function () {
    shouldBehaveLikeTaskManagerERC2771();
  });
});
