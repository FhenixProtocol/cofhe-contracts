import chalk from "chalk";

import {CREATEX_ADDRESS, isAlreadyDeployed} from "./deployCreateX";
import {HardhatRuntimeEnvironment} from "hardhat/types/runtime";
import {Addressable} from "ethers";

// The salt every deterministic CoFHE deployment uses. Its first 20 bytes match neither the
// deployer nor the zero address, so CreateX guards it as keccak256(abi.encode(salt)) - i.e. the
// resulting address is deployer-agnostic and depends only on this salt and the init code.
export const DETERMINISTIC_SALT =
  "0xF4E00000F4E00000F4E00000F4E00000F4E00000F4E00000F4E00000F4E00000";

/**
 * Deploys `initCode` through CreateX's `deployCreate2` directly, without ignition. Used on live
 * networks, where ignition's journal adds state that a one-shot bootstrap does not need.
 * Idempotent: returns quietly when `expectedAddress` already has code.
 */
export async function deployCreate2ViaCreateX(
  hre: HardhatRuntimeEnvironment,
  signer: any,
  expectedAddress: string,
  initCode: string,
  label: string,
): Promise<void> {
  if (await isAlreadyDeployed(hre, expectedAddress)) {
    console.log(`${label} already deterministically deployed at:`, expectedAddress);
    return;
  }
  const createX = new hre.ethers.Contract(
    CREATEX_ADDRESS,
    ["function deployCreate2(bytes32 salt, bytes initCode) payable returns (address)"],
    signer,
  );
  const tx = await createX.deployCreate2(DETERMINISTIC_SALT, initCode);
  await tx.wait();
  if (!(await isAlreadyDeployed(hre, expectedAddress))) {
    throw new Error(
      `${label}: deployCreate2 succeeded but no code at the expected address ${expectedAddress}. ` +
        `The init code does not reproduce the canonical address on this network.`,
    );
  }
  console.log(chalk.green(`${label} deployed to the deterministic address:`, expectedAddress));
}

export async function deployDeterministic(
  hre: HardhatRuntimeEnvironment,
  expectedAddress: string,
  module: any,
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
      salt: DETERMINISTIC_SALT,
    },
  };

  if (constructorParams) {
    (deployParams as any).parameters = {
      [module.id]: constructorParams,
    };
  }

  const deployResults = await hre.ignition.deploy(
    module,
    deployParams as any,
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