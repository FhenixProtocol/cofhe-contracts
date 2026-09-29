import chalk from "chalk";

import {CREATEX_ADDRESS, isAlreadyDeployed} from "./deployCreateX";
import {HardhatRuntimeEnvironment} from "hardhat/types/runtime";

// The salt every deterministic CoFHE deployment uses. Its first 20 bytes match neither the
// deployer nor the zero address, so CreateX guards it as keccak256(abi.encode(salt)) - i.e. the
// resulting address is deployer-agnostic and depends only on this salt and the init code.
export const DETERMINISTIC_SALT =
  "0xF4E00000F4E00000F4E00000F4E00000F4E00000F40000000000000004B16B1C";

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
