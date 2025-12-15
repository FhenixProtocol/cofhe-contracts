import { keccak256 } from "ethers";
import { TaskManager } from "../types";
import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

task("task:asyncAdd")
  .addParam("input1", "first input", "1")
  .addParam("input2", "second input", "2")
  .addParam("address", "shtok", "")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhenixjs, ethers, deployments } = hre;
    const [signer] = await ethers.getSigners();

    if ((await ethers.provider.getBalance(signer.address)).toString() === "0") {
      await fhenixjs.getFunds(signer.address);
    }

    const counter = await deployments.get("Counter");

    console.log(
      `Running asyncAdd(${taskArguments.input1} , ${taskArguments.input2}), targeting contract at: ${counter.address}`,
    );

    const contract = await ethers.getContractAt("Counter", counter.address);

    try {
      // add() gets `bytes calldata encryptedValue`
      // therefore we need to pass in the `data` property
      await contract.liortheking(taskArguments.input1, taskArguments.input2, taskArguments.address);
      console.log(`Transaction sent`);
    } catch (e) {
      console.log(`Failed to send add transaction: ${e}`);
      return;
    }
  });
