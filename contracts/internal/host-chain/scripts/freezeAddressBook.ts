import * as fs from "fs";
import hre from "hardhat";
import { getAddress } from "ethers";
import chalk from "chalk";

import { DETERMINISTIC_SALT } from "../utils/deployDeterministic";
import {
  ADDRESSES_FILE,
  DETERMINISTIC_DIR,
  IMPL_HEX_FILE,
  PROXY_HEX_FILE,
  computeAddressBookAddresses,
  readCommittedAddresses,
} from "../utils/addressBookDeterministic";

/**
 * Freezes the address book's creation bytecode and the canonical addresses derived from it.
 *
 * First run: ADDRESS_BOOK_BOOTSTRAP_OWNER must be set - the address that owns every new chain's
 * book until it is handed over. Later runs reuse the committed owner and refuse to move an address
 * unless FREEZE_FORCE=1, because moving it means a new FHE.sol release.
 */
async function main() {
  await hre.run("compile");
  const book = await hre.artifacts.readArtifact("CoFHEAddressBook");
  const proxy = await hre.artifacts.readArtifact("ERC1967Proxy");
  const artifacts = { implCreationCode: book.bytecode, proxyCreationCode: proxy.bytecode };

  const committed = fs.existsSync(ADDRESSES_FILE) ? readCommittedAddresses() : null;
  const ownerEnv = process.env.ADDRESS_BOOK_BOOTSTRAP_OWNER?.trim();
  if (!committed && !ownerEnv) {
    throw new Error(
      "ADDRESS_BOOK_BOOTSTRAP_OWNER must be set on the first run: the address of the key that owns " +
        "every new chain's address book until it is handed over.",
    );
  }
  const owner = getAddress(committed?.bootstrapOwner ?? ownerEnv!);
  const computed = computeAddressBookAddresses(owner, artifacts);

  const moved =
    committed !== null &&
    (committed.addressBook !== computed.addressBook || committed.addressBookImplV1 !== computed.addressBookImplV1);
  if (moved && process.env.FREEZE_FORCE !== "1") {
    throw new Error(
      `Refusing to move the canonical addresses: committed ${committed!.addressBook} / ` +
        `${committed!.addressBookImplV1}, computed ${computed.addressBook} / ${computed.addressBookImplV1}. ` +
        `The compiler output changed. Set FREEZE_FORCE=1 only for a deliberate address change.`,
    );
  }

  fs.mkdirSync(DETERMINISTIC_DIR, { recursive: true });
  fs.writeFileSync(IMPL_HEX_FILE, book.bytecode + "\n");
  fs.writeFileSync(PROXY_HEX_FILE, proxy.bytecode + "\n");
  fs.writeFileSync(
    ADDRESSES_FILE,
    JSON.stringify(
      {
        salt: DETERMINISTIC_SALT,
        bootstrapOwner: owner,
        addressBookImplV1: computed.addressBookImplV1,
        addressBook: computed.addressBook,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(chalk.green(`CoFHEAddressBook v1 implementation: ${computed.addressBookImplV1}`));
  console.log(chalk.green(`CoFHEAddressBook proxy:             ${computed.addressBook}`));
  console.log(chalk.green(`Bootstrap owner:                    ${owner}`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
