import { Example } from "../types";
import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";
import {getTaskManagerDeployment} from "../utils/getIgnitionDeployment";

task("task:doAddNonTrivial")
  .addParam("a", "First number", "1")
  .addParam("b", "Second number", "2")
  .addOptionalParam("tm", "Task Manager address", "")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhenixjs, ethers, deployments } = hre;
    const [signer] = await ethers.getSigners();

    if ((await ethers.provider.getBalance(signer.address)).toString() === "0") {
      await fhenixjs.getFunds(signer.address);
    }

    const TaskManager = await getTaskManagerDeployment(hre);
    const tm = taskArguments.tm || TaskManager.target;

    const Example = await deployments.get("Example");

    console.log(
      `Running doAdd(), targeting task manager contract at: ${tm},\n`,
      `Example contract at: ${Example.address}`,
    );

    const contract = await ethers.getContractAt("Example", Example.address);

    let contractWithSigner = contract.connect(signer) as unknown as Example;

    try {
      console.log(`Sending transaction to doAdd()`);
      // const tx = await contractWithSigner.doAddAllowed({ gasLimit: 1000000 });
      const tx = await contractWithSigner.doAddNotAllowed({ gasLimit: 1000000 });
      const receipt = await tx.wait();
      console.log(`Transaction sent`);
    } catch (e) {
      console.log(`Failed to send add transaction: ${e}`);
      return;
    }
  });
