import { Example } from "../types";
import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";
import {readTaskManagerAddressFromSolidity} from "../utils/updateTaskManagerAddress";

task("task:doAdd")
  .addParam("a", "First number", "1")
  .addParam("b", "Second number", "2")
  .addOptionalParam("tm", "Task Manager address", "")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhenixjs, ethers, deployments } = hre;
    const [signer] = await ethers.getSigners();

    if ((await ethers.provider.getBalance(signer.address)).toString() === "0") {
      await fhenixjs.getFunds(signer.address);
    }

    const a = Number(taskArguments.a);
    const b = Number(taskArguments.b);
    const tm = taskArguments.tm || await readTaskManagerAddressFromSolidity();

    const Example = await deployments.get("Example");

    console.log(
      `Running doAdd(${a}, ${b}), targeting task manager contract at: ${tm},\n`,
      `Example contract at: ${Example.address}`,
    );

    const contract = await ethers.getContractAt("Example", Example.address);

    let contractWithSigner = contract.connect(signer) as unknown as Example;

    try {
      console.log(`Sending transaction to doAdd(${a}, ${b})`);
      const tx = await contractWithSigner.doAdd(a, b, { gasLimit: 1000000 });
      const receipt = await tx.wait();
      console.log(`Transaction sent`);
      const event = receipt.logs?.find(l => l.fragment?.name === "ctHashEvent");
      if (event) {
        const value = event.args[0].toString();
        console.log("Emitted value:", value);
        const hex = BigInt(value).toString(16);
        console.log("Hex", hex, "sanity length:", hex.length);
      } else {
        console.log("Event not found");
      }
    } catch (e) {
      console.log(`Failed to send add transaction: ${e}`);
      return;
    }
  });
