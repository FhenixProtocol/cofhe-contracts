import * as fs from "fs";
import { join } from "path";
import { getAddress } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

// The copy the contracts compile against: pnpm copies the `file:` dependency, it does not link it.
const FHE_SOL = join(__dirname, "../node_modules/@fhenixprotocol/cofhe-contracts/FHE.sol");
const BOOK_PATTERN = /address constant COFHE_ADDRESS_BOOK = (0x[0-9a-fA-F]{40});/;
const ID_PATTERN = /uint256 constant TASK_MANAGER_ID = (\d+);/;

function readConstant(pattern: RegExp, name: string): string {
  const source = fs.readFileSync(FHE_SOL, "utf8");
  const match = source.match(pattern);
  if (!match) {
    throw new Error(
      `Could not read ${name} from ${FHE_SOL}. The constant must keep the form the deploy scripts parse.`,
    );
  }
  return match[1];
}

/** The address-book address FHE.sol is compiled against. */
export function addressBookAddress(): string {
  return getAddress(readConstant(BOOK_PATTERN, "COFHE_ADDRESS_BOOK"));
}

/** The TaskManager id this FHE.sol release resolves. */
export function taskManagerId(): bigint {
  return BigInt(readConstant(ID_PATTERN, "TASK_MANAGER_ID"));
}

/**
 * Rewrites the compiled-in book address. Local networks only, where the book is owned by the
 * local deployer and so lands at a local address. Callers must recompile afterwards.
 */
export function setAddressBookAddressInSolidity(newAddress: string): void {
  const address = getAddress(newAddress);
  const source = fs.readFileSync(FHE_SOL, "utf8");
  if (!BOOK_PATTERN.test(source)) {
    throw new Error(`Could not find COFHE_ADDRESS_BOOK in ${FHE_SOL}.`);
  }
  fs.writeFileSync(FHE_SOL, source.replace(BOOK_PATTERN, `address constant COFHE_ADDRESS_BOOK = ${address};`), "utf8");
}

/** The TaskManager FHE.sol resolves to on the connected network. Reverts when the id is unset. */
export async function resolveTaskManager(hre: HardhatRuntimeEnvironment): Promise<string> {
  const book: any = await hre.ethers.getContractAt("CoFHEAddressBook", addressBookAddress());
  return await book.getTm(taskManagerId());
}
