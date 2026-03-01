import { DeployFunction } from "hardhat-deploy/types";
import chalk from "chalk";
import hre, { ethers } from "hardhat";

const func: DeployFunction = async function () {
  console.log(chalk.bold.blue("-----------------------Network-----------------------------"));
  console.log(chalk.green("Network name:", hre.network.name));
  console.log("\n");

  const [signer] = await ethers.getSigners();
  console.log(chalk.green("Deployer address:", signer.address));

  const VerificationRequestRegistry = await ethers.getContractFactory("VerificationRequestRegistry");
  const contract = await VerificationRequestRegistry.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(chalk.green("VerificationRequestRegistry deployed to:", address));
};

export default func;
func.id = "deploy_verification_chain";
func.tags = ["VerificationRequestRegistry"];
