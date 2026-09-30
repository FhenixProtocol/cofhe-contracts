import chalk from "chalk";

import {CREATEX_ADDRESS, isAlreadyDeployed} from "./deployCreateX";
import { Interface, getAddress } from "ethers";
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
  const receipt = await tx.wait();
  const created = createdAddressFromReceipt(receipt);
  if (created && created.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(
      `${label}: CreateX deployed to ${created}, not to the expected ${expectedAddress}. The init code or the ` +
        `salt does not reproduce the canonical address on this network.`,
    );
  }
  // A load-balanced RPC can answer eth_getCode from a node that has not seen the block yet.
  if (!(await waitForCode(hre, expectedAddress))) {
    throw new Error(
      `${label}: CreateX reported the contract at ${expectedAddress} but the RPC still returns no code there ` +
        `after ${CODE_WAIT_ATTEMPTS * CODE_WAIT_DELAY_MS / 1000}s. The endpoint is lagging; re-run once it has caught up.`,
    );
  }
  console.log(chalk.green(`${label} deployed to the deterministic address:`, expectedAddress));
}

const CREATEX_EVENTS = new Interface(["event ContractCreation(address indexed newContract, bytes32 indexed salt)"]);
const CODE_WAIT_ATTEMPTS = 15;
const CODE_WAIT_DELAY_MS = 2000;

/** The address CreateX names in its ContractCreation log, or null when the receipt carries none. */
export function createdAddressFromReceipt(
  receipt: { logs: readonly { address: string; topics: readonly string[]; data: string }[] } | null,
): string | null {
  for (const log of receipt?.logs ?? []) {
    if (log.address.toLowerCase() !== CREATEX_ADDRESS.toLowerCase()) {
      continue;
    }
    try {
      const parsed = CREATEX_EVENTS.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "ContractCreation") {
        return getAddress(parsed.args.newContract);
      }
    } catch {
      // some other CreateX event
    }
  }
  return null;
}

/** Polls eth_getCode until `address` has code, for lagging RPC pools. */
export async function waitForCode(
  hre: HardhatRuntimeEnvironment,
  address: string,
  attempts = CODE_WAIT_ATTEMPTS,
  delayMs = CODE_WAIT_DELAY_MS,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await isAlreadyDeployed(hre, address)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}
