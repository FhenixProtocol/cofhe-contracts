import * as fs from "fs";
import * as path from "path";
import { AbiCoder, Interface, concat, getAddress, getCreate2Address, keccak256 } from "ethers";

import { CREATEX_ADDRESS } from "./deployCreateX";
import { DETERMINISTIC_SALT } from "./deployDeterministic";

export { createdAddressFromReceipt } from "./deployDeterministic";

export const DETERMINISTIC_DIR = path.join(__dirname, "../deterministic");
export const IMPL_HEX_FILE = path.join(DETERMINISTIC_DIR, "CoFHEAddressBookV1.creation.hex");
export const PROXY_HEX_FILE = path.join(DETERMINISTIC_DIR, "ERC1967Proxy.creation.hex");
export const ADDRESSES_FILE = path.join(DETERMINISTIC_DIR, "addresses.json");

export interface FrozenArtifacts {
  implCreationCode: string;
  proxyCreationCode: string;
}

export interface CommittedAddresses {
  salt: string;
  bootstrapOwner: string;
  addressBookImplV1: string;
  addressBook: string;
}

export interface ComputedAddresses {
  addressBookImplV1: string;
  addressBook: string;
  proxyInitCode: string;
}

const INITIALIZE = new Interface(["function initialize(address initialOwner)"]);

/**
 * CreateX guards a salt whose first 20 bytes match neither the sender nor zero as
 * keccak256(abi.encode(salt)), so the resulting address depends only on the salt and the init
 * code - never on who sends the deployment.
 */
export function guardedSalt(salt: string = DETERMINISTIC_SALT): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32"], [salt]));
}

export function proxyInitCode(owner: string, implementation: string, artifacts: FrozenArtifacts): string {
  const initData = INITIALIZE.encodeFunctionData("initialize", [getAddress(owner)]);
  return concat([
    artifacts.proxyCreationCode,
    AbiCoder.defaultAbiCoder().encode(["address", "bytes"], [implementation, initData]),
  ]);
}

export function computeAddressBookAddresses(
  owner: string,
  artifacts: FrozenArtifacts,
  rawSalt: string = DETERMINISTIC_SALT,
): ComputedAddresses {
  const salt = guardedSalt(rawSalt);
  const addressBookImplV1 = getCreate2Address(CREATEX_ADDRESS, salt, keccak256(artifacts.implCreationCode));
  const initCode = proxyInitCode(owner, addressBookImplV1, artifacts);
  const addressBook = getCreate2Address(CREATEX_ADDRESS, salt, keccak256(initCode));
  return { addressBookImplV1, addressBook, proxyInitCode: initCode };
}

export function readFrozenArtifacts(): FrozenArtifacts {
  return {
    implCreationCode: fs.readFileSync(IMPL_HEX_FILE, "utf8").trim(),
    proxyCreationCode: fs.readFileSync(PROXY_HEX_FILE, "utf8").trim(),
  };
}

export function readCommittedAddresses(): CommittedAddresses {
  return JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
}
