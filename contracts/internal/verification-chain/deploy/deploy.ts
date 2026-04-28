import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import chalk from "chalk";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;

  console.log(chalk.bold.blue("-----------------------Network-----------------------------"));
  console.log(chalk.green("Network name:", hre.network.name));
  console.log("\n");

  const { deployer } = await getNamedAccounts();
  console.log(chalk.green("Deployer address:", deployer));

  const result = await deploy("VerificationRequestRegistry", {
    from: deployer,
    args: [],
    log: true,
  });

  console.log(chalk.green("VerificationRequestRegistry deployed to:", result.address));
};

export default func;
func.id = "deploy_verification_chain";
func.tags = ["VerificationRequestRegistry"];
