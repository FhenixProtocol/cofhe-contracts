import fs from "fs";
import { join } from "path";
import { getAddress } from "ethers";

/**
 * The original canonical TaskManager address.
 *
 * Frozen on purpose: it is derived from init code embedding the intentionally-public bootstrap
 * key, so it can be claimed by anyone on any chain where it is still free. Claiming it is a
 * denial measure and must always target this exact address, never whatever the configurable
 * constant currently says.
 */
export const LEGACY_TM_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

const CONSTANT_FILE = join(__dirname, "../contracts/addresses/TaskManagerAddress.sol");
const PATTERN = /address constant taskManagerAddress = (0x[0-9a-fA-F]{40});/;

let cached: string | undefined;

/**
 * The TaskManager address the contracts are currently compiled against.
 *
 * Read from `contracts/addresses/TaskManagerAddress.sol` rather than duplicated as a TypeScript
 * literal: ACL, PlaintextsStorage and FHE.sol all compile that constant in, so a TS copy that
 * drifts from it produces a deployment wired to an address the contracts do not believe in. There
 * were fourteen such copies before this existed.
 */
export function taskManagerAddress(): string {
  if (cached === undefined) {
    const source = fs.readFileSync(CONSTANT_FILE, "utf8");
    const match = source.match(PATTERN);
    if (!match) {
      throw new Error(
        `Could not read taskManagerAddress from ${CONSTANT_FILE}. The constant must stay in the ` +
          `form \`address constant taskManagerAddress = 0x...;\` - the deploy scripts parse it.`,
      );
    }
    cached = getAddress(match[1]);
  }
  return cached;
}

/**
 * Rewrites the compiled-in constant. Callers must recompile afterwards: ACL and PlaintextsStorage
 * bake the value in, so changing it without rebuilding produces contracts that still point at the
 * old address.
 */
export function setTaskManagerAddress(newAddress: string): void {
  const address = getAddress(newAddress);
  const source = fs.readFileSync(CONSTANT_FILE, "utf8");
  if (!PATTERN.test(source)) {
    throw new Error(`Could not find the taskManagerAddress constant in ${CONSTANT_FILE}.`);
  }
  fs.writeFileSync(
    CONSTANT_FILE,
    source.replace(PATTERN, `address constant taskManagerAddress = ${address};`),
    "utf8",
  );
  cached = address;
}
