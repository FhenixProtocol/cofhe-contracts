import { TaskArguments } from "hardhat/types";
import chalk from "chalk";
import { task } from "hardhat/config";

task("task:deployExample").setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, deployments } = hre;
    const { deploy } = deployments;
    const [signer] = await ethers.getSigners();

    if ((await ethers.provider.getBalance(signer.address)).toString() === "0") {
      if (hre.network.name === "localfhenix") {
        if (hre.fhenixjs && hre.fhenixjs.getFunds) {
          await hre.fhenixjs.getFunds(signer.address);
        } else {
          console.log(chalk.red("fhenixjs.getFunds not available. Please fund your account manually."));
          return;
        }
      } else {
        console.log(
          chalk.red("Please fund your account with testnet FHE from https://faucet.fhenix.zone"));
        return;
      }
    }

    const result = await deploy("Example", {
      from: signer.address,
      args: [],
      log: true,
      skipIfAlreadyDeployed: false,
    });

    console.log(`Example contract: `, result.address);
}); 