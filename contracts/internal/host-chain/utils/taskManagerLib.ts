import { getCreate2Address, keccak256 } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

import { guardedSalt } from "./addressBookDeterministic";
import { CREATEX_ADDRESS, deployCreateX, isAlreadyDeployed } from "./deployCreateX";
import { deployCreate2ViaCreateX } from "./deployDeterministic";
import { isLocalNetwork } from "./roles";

/// TaskManager links TaskManagerLib; the OpenZeppelin upgrades plugin refuses linked libraries
/// unless told otherwise. The library has no storage and no constructor, so linking it is safe.
export const LINKED_LIBRARY_OPTS = { unsafeAllowLinkedLibraries: true } as const;

/** The CREATE2 address of TaskManagerLib: it depends only on the library's bytecode. */
async function taskManagerLibAddress(hre: HardhatRuntimeEnvironment): Promise<string> {
  const lib = await hre.artifacts.readArtifact("TaskManagerLib");
  return getCreate2Address(CREATEX_ADDRESS, guardedSalt(), keccak256(lib.bytecode));
}

/**
 * Deploys TaskManagerLib through CreateX CREATE2 with the deterministic salt, or reuses it when the
 * same bytecode is already there, and returns its address. An unchanged library keeps its address;
 * a changed library lands at a new one. A local chain without CreateX gets CreateX first, as
 * task:deployAddressBook does; a live chain without CreateX is an error.
 */
export async function deployTaskManagerLib(hre: HardhatRuntimeEnvironment, signer: any): Promise<string> {
  if (!(await isAlreadyDeployed(hre, CREATEX_ADDRESS))) {
    if (!isLocalNetwork(hre)) {
      throw new Error(
        `CreateX is not deployed at ${CREATEX_ADDRESS} on ${hre.network.name}, so TaskManagerLib cannot get its ` +
          `deterministic address. Deploy CreateX first.`,
      );
    }
    await deployCreateX(hre, signer);
  }
  const lib = await hre.artifacts.readArtifact("TaskManagerLib");
  const libAddress = await taskManagerLibAddress(hre);
  await deployCreate2ViaCreateX(hre, signer, libAddress, lib.bytecode, "TaskManagerLib");
  return libAddress;
}

/**
 * Returns a TaskManager factory linked to TaskManagerLib's CREATE2 address.
 *
 * With `deploy: false` nothing is sent: the factory links the predicted address, which is the one
 * deployTaskManagerLib uses. Deploy the library before deploying from such a factory.
 */
export async function linkedTaskManagerFactory(
  hre: HardhatRuntimeEnvironment,
  signer: any,
  { deploy = true }: { deploy?: boolean } = {},
) {
  const libAddress = deploy ? await deployTaskManagerLib(hre, signer) : await taskManagerLibAddress(hre);
  return hre.ethers.getContractFactory("TaskManager", { signer, libraries: { TaskManagerLib: libAddress } });
}
