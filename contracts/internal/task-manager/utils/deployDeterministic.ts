import chalk from "chalk";

import {isAlreadyDeployed} from "./deployCreateX";
import {HardhatRuntimeEnvironment} from "hardhat/types/runtime";
import {Addressable} from "ethers";

export async function deployDeterministic(
  hre: HardhatRuntimeEnvironment,
  expectedAddress,
  module,
  constructorParams: Object | undefined = undefined,
): Promise<string | Addressable> {
  if (await isAlreadyDeployed(hre, expectedAddress)) {
    console.log(`${module.id} contract already deterministically deployed at:`, expectedAddress);
    return expectedAddress;
  }

  console.log(`deploying ${module.id} contract`);

  const deployParams = {
    config: {
      requiredConfirmations: 1,
    },
    strategy: "create2",
    strategyConfig: {
      // To learn more about salts, see the CreateX documentation
      salt: "0xF4E00000F4E00000F4E00000F4E00000F4E00000F4E00000F4E00000F4E00000",
    },
  };

  if (constructorParams) {
    deployParams.parameters = {
      [module.id]: constructorParams,
    };
  }

  const deployResults = await hre.ignition.deploy(
    module,
    deployParams,
  );

  const contract = deployResults[module.id];

  if (contract.target !== expectedAddress) {
    // This should happen only in development networks
    console.log(chalk.red(`${module.id} deployed to an unexpected address, expected:`, expectedAddress, " got: ", contract.target));
  } else {
    console.log(chalk.green(`${module.id} deployed to the deterministic address:`, expectedAddress));
  }

  return contract.target;
}