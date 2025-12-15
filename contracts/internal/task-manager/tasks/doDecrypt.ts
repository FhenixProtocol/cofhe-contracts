import { Example } from "../types";
import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";
import {getTaskManagerDeployment} from "../utils/getIgnitionDeployment";

task("task:doDecrypt")
  .addParam("cthash", "Ciphertext hash", "0x0000000000000000000000000000000000000000")
  .addOptionalParam("tm", "Task Manager address", "")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhenixjs, ethers, deployments } = hre;
    const [signer] = await ethers.getSigners();

    if ((await ethers.provider.getBalance(signer.address)).toString() === "0") {
      await fhenixjs.getFunds(signer.address);
    }

    const Example = await deployments.get("Example");
    console.log(
      `Running doDecrypt(${taskArguments.cthash}), Example contract at: ${Example.address}`,
    );

    const contract = await ethers.getContractAt("Example", Example.address);

    let contractWithSigner = contract.connect(signer) as unknown as Example;

    try {
      console.log(`Sending decrypt transaction...`);
      console.log(taskArguments.cthash);
      let num = BigInt(taskArguments.cthash);
      console.log(num);
      console.log("type of num: ", typeof num);
      await contractWithSigner.doDecrypt(num);
    } catch (e) {
      console.log(`Failed to send decrypt transaction: ${e}`);
      return;
    }
  });
