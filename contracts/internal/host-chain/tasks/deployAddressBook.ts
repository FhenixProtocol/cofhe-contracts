import chalk from "chalk";
import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

import { addressBookAddress, setAddressBookAddressInSolidity } from "../utils/addressBook";
import {
  computeAddressBookAddresses,
  readCommittedAddresses,
  readFrozenArtifacts,
} from "../utils/addressBookDeterministic";
import type { ComputedAddresses, FrozenArtifacts } from "../utils/addressBookDeterministic";
import { CREATEX_ADDRESS, deployCreateX, isAlreadyDeployed } from "../utils/deployCreateX";
import { deployCreate2ViaCreateX } from "../utils/deployDeterministic";
import { fundAccount } from "../utils/fund";
import { isLocalNetwork } from "../utils/roles";

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// ERC-7201 slot of `openzeppelin.storage.Ownable` (OpenZeppelin 5.2.0).
const OWNABLE_SLOT = "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300";

async function addressInSlot(hre: HardhatRuntimeEnvironment, at: string, slot: string): Promise<string> {
  // A lagging RPC node answers with an empty slot for a proxy that was created moments ago.
  for (let attempt = 0; ; attempt++) {
    const raw = await hre.ethers.provider.getStorage(at, slot);
    const address = hre.ethers.getAddress("0x" + raw.slice(-40));
    if (address !== hre.ethers.ZeroAddress || attempt >= 5) {
      return address;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Checks that the proxy at `book` runs `expectedImplementation` and is owned by one of
 * `acceptedOwners`. Anything else means the canonical address was claimed with different init
 * code, or has changed hands - stop and investigate rather than build on it.
 */
export async function verifyAddressBookDeployment(
  hre: HardhatRuntimeEnvironment,
  book: string,
  expectedImplementation: string,
  acceptedOwners: string[],
): Promise<void> {
  const implementation = await addressInSlot(hre, book, IMPLEMENTATION_SLOT);
  if (implementation.toLowerCase() !== expectedImplementation.toLowerCase()) {
    throw new Error(
      `Address book at ${book} runs implementation ${implementation}, expected ${expectedImplementation}. ` +
        `Do NOT proceed - investigate.`,
    );
  }
  const owner = await addressInSlot(hre, book, OWNABLE_SLOT);
  if (!acceptedOwners.some((accepted) => accepted.toLowerCase() === owner.toLowerCase())) {
    throw new Error(
      `Address book at ${book} is owned by ${owner}, expected one of ${acceptedOwners.join(", ")}. ` +
        `Do NOT proceed - investigate.`,
    );
  }
}

async function deployBook(
  hre: HardhatRuntimeEnvironment,
  signer: any,
  frozen: FrozenArtifacts,
  book: ComputedAddresses,
): Promise<void> {
  await deployCreate2ViaCreateX(hre, signer, book.addressBookImplV1, frozen.implCreationCode, "CoFHEAddressBook v1 implementation");
  await deployCreate2ViaCreateX(hre, signer, book.addressBook, book.proxyInitCode, "CoFHEAddressBook proxy");
}

task("task:deployAddressBook", "Deploy the CoFHEAddressBook at its canonical address").setAction(
  async function (_taskArguments, hre) {
    const { ethers } = hre;
    const [signer, signerProxy, aggregatorSigner] = await ethers.getSigners();

    if (isLocalNetwork(hre)) {
      // A local chain has no bootstrap owner: the book is owned by the local deployer, so it lands
      // at a local address, and FHE.sol is patched to it before anything compiles against it.
      if (hre.network.name.includes("localfhenix")) {
        await fundAccount(hre, signerProxy);
        await fundAccount(hre, aggregatorSigner);
      }
      await fundAccount(hre, signer);
      if (!(await isAlreadyDeployed(hre, CREATEX_ADDRESS))) {
        await deployCreateX(hre, signer);
      }
      const frozen = readFrozenArtifacts();
      const book = computeAddressBookAddresses(signer.address, frozen);
      const { addressBookImplV1, addressBook } = book;
      await deployBook(hre, signer, frozen, book);
      await verifyAddressBookDeployment(hre, addressBook, addressBookImplV1, [signer.address]);
      // The in-process Hardhat network is gone when the command ends; nothing compiles against it.
      if (hre.network.name !== "hardhat" && addressBookAddress().toLowerCase() !== addressBook.toLowerCase()) {
        setAddressBookAddressInSolidity(addressBook);
        await hre.run("compile");
      }
      console.log(chalk.green(`Local CoFHEAddressBook at ${addressBook}, owned by ${signer.address}`));
      return;
    }

    if (!(await isAlreadyDeployed(hre, CREATEX_ADDRESS))) {
      throw new Error(
        `CreateX is not deployed at ${CREATEX_ADDRESS} on this network - refusing to bootstrap. ` +
          `See https://github.com/pcaversaccio/createx for chains where it is available.`,
      );
    }
    const committed = readCommittedAddresses();
    const frozen = readFrozenArtifacts();
    const book = computeAddressBookAddresses(committed.bootstrapOwner, frozen);
    const { addressBookImplV1, addressBook } = book;
    // Compare before any transaction is sent: a drifted freeze must not deploy anything.
    if (addressBook !== committed.addressBook || addressBookImplV1 !== committed.addressBookImplV1) {
      throw new Error(
        `Computed ${addressBook} / ${addressBookImplV1} but deterministic/addresses.json says ` +
          `${committed.addressBook} / ${committed.addressBookImplV1}. Run the FrozenBytecode test.`,
      );
    }
    await deployBook(hre, signer, frozen, book);
    const acceptedOwners = [committed.bootstrapOwner];
    const finalAdmin = process.env.SAFE_ADMIN_ADDRESS?.trim();
    if (finalAdmin) {
      acceptedOwners.push(ethers.getAddress(finalAdmin));
    }
    await verifyAddressBookDeployment(hre, addressBook, addressBookImplV1, acceptedOwners);
    console.log(
      chalk.green(`CoFHEAddressBook at ${addressBook} (implementation ${addressBookImplV1}), owner verified.`),
    );
  },
);
