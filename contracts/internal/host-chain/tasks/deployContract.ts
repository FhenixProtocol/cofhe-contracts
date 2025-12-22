import { TaskArguments } from "hardhat/types";
import chalk from "chalk";
import { task } from "hardhat/config";
task("task:deployCounter").setAction(async function (taskArguments: TaskArguments, hre) {

    const { fhenixjs, ethers } = hre;
    const { deploy } = hre.deployments;
    const [signer] = await ethers.getSigners();

    if ((await ethers.provider.getBalance(signer.address)).toString() === "0") {
      if (hre.network.name === "localfhenix") {
        await fhenixjs.getFunds(signer.address);
      } else {
        console.log(
          chalk.red("Insufficient funds"));
        return;
      }
    }
    const tmContract = await deploy("Counter", {
      from: signer.address,
      args: [],
      log: true,
      skipIfAlreadyDeployed: false,
    });
    console.log(`Counter contract: `, tmContract.address);
});
