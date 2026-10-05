import * as os from "os";
import { Worker } from "worker_threads";
import { AbiCoder, Interface, getAddress, getBytes } from "ethers";

import { CREATEX_ADDRESS } from "../utils/deployCreateX";
import { DETERMINISTIC_SALT } from "../utils/deployDeterministic";
import { computeAddressBookAddresses, readCommittedAddresses, readFrozenArtifacts } from "../utils/addressBookDeterministic";

/**
 * Searches for a deterministic salt under which the CoFHEAddressBook proxy lands on an address
 * starting with VANITY_PREFIX, for the bootstrap owner in ADDRESS_BOOK_BOOTSTRAP_OWNER (default:
 * the committed one). Only the last 11 bytes of the salt vary: the first 20 stay as they are, so
 * CreateX keeps treating the salt as deployer-agnostic, and byte 20 keeps its "unspecified" flag.
 *
 *   VANITY_PREFIX=0xC0F4E00 VANITY_WORKERS=16 npx hardhat run scripts/findVanitySalt.ts --network hardhat
 *
 * Every attempt re-derives both addresses (the implementation address is part of the proxy init
 * code), so a 7-digit prefix costs about 2^28 attempts. VANITY_CHECKSUM=1 additionally requires
 * the EIP-55 casing to match the prefix as typed. VANITY_START offsets the nonce for resuming.
 */
const WORKER = String.raw`
const { parentPort, workerData } = require("worker_threads");
const { keccak256 } = require(workerData.ethersPath);
const { createX, implCodeHash, initCodeTail, proxyCode, saltPrefix, prefixHex, workerIndex, workers, start } = workerData;

const salt = Buffer.alloc(32); Buffer.from(saltPrefix).copy(salt, 0);      // bytes 0..20 fixed
const initCode = Buffer.concat([Buffer.from(proxyCode), Buffer.from(initCodeTail)]);
const implOffset = proxyCode.length + 12;                                  // the address word's last 20 bytes
const pre = Buffer.alloc(85); pre[0] = 0xff; Buffer.from(createX).copy(pre, 1);
const implHash = Buffer.from(implCodeHash);
const hex = (b) => keccak256(b);                                           // "0x" + 64 hex chars
const bytesOf = (h) => Buffer.from(h.slice(2), "hex");

let nonce = BigInt(start) + BigInt(workerIndex);
let attempts = 0;
for (;;) {
  salt.writeBigUInt64BE(nonce & ((1n << 64n) - 1n), 24);
  salt.writeUIntBE(Number((nonce >> 64n) & 0xffffffn), 21, 3);
  const guarded = bytesOf(hex(salt));
  guarded.copy(pre, 21); implHash.copy(pre, 53);
  const implAddr = bytesOf(hex(pre)).subarray(12);
  implAddr.copy(initCode, implOffset);
  bytesOf(hex(initCode)).copy(pre, 53);
  const proxyHex = hex(pre).slice(26);                                     // last 20 bytes as hex
  if (proxyHex.startsWith(prefixHex)) {
    parentPort.postMessage({ type: "found", salt: "0x" + salt.toString("hex"), attempts });
    break;
  }
  nonce += BigInt(workers);
  if (++attempts % 500000 === 0) parentPort.postMessage({ type: "progress", attempts: 500000 });
}
`;

async function main() {
  const prefixRaw = (process.env.VANITY_PREFIX ?? "0xC0F4E00").trim();
  if (!/^0x[0-9a-fA-F]{1,40}$/.test(prefixRaw)) {
    throw new Error(`VANITY_PREFIX must be 0x followed by hex digits, got ${JSON.stringify(prefixRaw)}`);
  }
  const prefixHex = prefixRaw.slice(2).toLowerCase();
  const requireChecksum = process.env.VANITY_CHECKSUM === "1";
  const workers = Number(process.env.VANITY_WORKERS ?? os.cpus().length);
  const start = BigInt(process.env.VANITY_START ?? "0");
  const owner = getAddress(process.env.ADDRESS_BOOK_BOOTSTRAP_OWNER?.trim() || readCommittedAddresses().bootstrapOwner);
  const frozen = readFrozenArtifacts();

  const implCode = getBytes(frozen.implCreationCode);
  const proxyCode = getBytes(frozen.proxyCreationCode);
  const initData = new Interface(["function initialize(address initialOwner)"]).encodeFunctionData("initialize", [owner]);
  const initCodeTail = getBytes(AbiCoder.defaultAbiCoder().encode(["address", "bytes"], [getAddress("0x" + "00".repeat(20)), initData]));
  const saltPrefix = getBytes(DETERMINISTIC_SALT).slice(0, 21);
  const { keccak256 } = await import("ethers");

  const expected = 16 ** prefixHex.length * (requireChecksum ? 2 ** (prefixHex.replace(/[0-9]/g, "").length) : 1);
  console.log(`owner ${owner}, prefix 0x${prefixHex}${requireChecksum ? " (checksum-exact)" : ""}, ${workers} workers, ~${expected.toExponential(2)} attempts expected`);

  const startedAt = Date.now();
  let total = 0;
  const pool: Worker[] = [];
  const result = await new Promise<{ salt: string; attempts: number }>((resolve, reject) => {
    for (let i = 0; i < workers; i++) {
      const w = new Worker(WORKER, {
        eval: true,
        workerData: {
          ethersPath: require.resolve("ethers"),
          createX: getBytes(CREATEX_ADDRESS),
          implCodeHash: getBytes(keccak256(implCode)),
          initCodeTail,
          proxyCode,
          saltPrefix,
          prefixHex,
          workerIndex: i,
          workers,
          start: start.toString(),
        },
      });
      pool.push(w);
      w.on("message", (m: any) => {
        if (m.type === "progress") {
          total += m.attempts;
          if (total % (workers * 500000) === 0) {
            const s = (Date.now() - startedAt) / 1000;
            console.log(`${(total / 1e6).toFixed(1)}M attempts, ${(total / s / 1000).toFixed(0)}k/s, ~${((expected - total) / (total / s) / 60).toFixed(1)} min to expected`);
          }
          return;
        }
        if (m.type === "found") {
          const computed = computeAddressBookAddresses(owner, frozen, m.salt);
          if (!computed.addressBook.toLowerCase().startsWith("0x" + prefixHex)) {
            reject(new Error(`worker result does not verify: ${m.salt} -> ${computed.addressBook}`));
            return;
          }
          if (requireChecksum && !computed.addressBook.startsWith(prefixRaw)) {
            return; // keep searching for the exact casing
          }
          resolve({ salt: m.salt, attempts: total + m.attempts });
        }
      });
      w.on("error", reject);
    }
  }).finally(() => pool.forEach((w) => w.terminate()));

  const computed = computeAddressBookAddresses(owner, frozen, result.salt);
  const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\nfound after ~${(result.attempts / 1e6).toFixed(1)}M attempts in ${minutes} min`);
  console.log(`DETERMINISTIC_SALT    ${result.salt}`);
  console.log(`CoFHEAddressBook      ${computed.addressBook}`);
  console.log(`v1 implementation     ${computed.addressBookImplV1}`);
  console.log(`bootstrap owner       ${owner}`);
  console.log(
    `\nTo adopt it: set DETERMINISTIC_SALT in utils/deployDeterministic.ts, run ` +
      `ADDRESS_BOOK_BOOTSTRAP_OWNER=${owner} FREEZE_FORCE=1 pnpm freeze:addressBook, ` +
      `set COFHE_ADDRESS_BOOK in contracts/FHE.sol to ${computed.addressBook}, refresh the node_modules copy, run pnpm test.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
