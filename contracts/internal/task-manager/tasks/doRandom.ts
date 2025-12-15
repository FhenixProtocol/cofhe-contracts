import { Example } from "../types";
import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";
import {getTaskManagerDeployment} from "../utils/getIgnitionDeployment";

task("task:doRandom")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhenixjs, ethers, deployments } = hre;
    const [signer] = await ethers.getSigners();
    // console.log("0 Signer used:", signerUsed.address);

    if ((await ethers.provider.getBalance(signer.address)).toString() === "0") {
      await fhenixjs.getFunds(signer.address);
    }

    const Example = await deployments.get("Example");

    console.log(
      `Running doRandom(),\n`,
      `Example contract at: ${Example.address}`,
    );

    const contract = await ethers.getContractAt("Example", Example.address);

    let contractWithSigner = contract.connect(signer) as unknown as Example;

    try {
      console.log(`Sending transaction to doRandom()`);
      // const tx = await contractWithSigner.doRandom({ gasLimit: 1000000 });
      const tx = await contractWithSigner.doRandom8({ gasLimit: 1000000 });
      const receipt = await tx.wait();
      console.log(`Transaction sent`);

      // Find the event in the logs
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
      console.log(`Failed to send random transaction: ${e}`);
      return;
    }
  });
