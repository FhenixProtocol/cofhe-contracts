import fs from "fs";
import { dirname, join } from "path";

import { HardhatRuntimeEnvironment } from "hardhat/types/runtime";

// Minimal Safe (v1.3+/v1.4) surface needed to execute a transaction as an owner.
const SAFE_ABI = [
  "function getThreshold() view returns (uint256)",
  "function isOwner(address owner) view returns (bool)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
];

/**
 * Executes a call through a Gnosis Safe, signed and sent by one of its owners.
 *
 * Uses the Safe's "pre-validated" signature type (v = 1): when the account sending the
 * transaction is the owner encoded in the signature's `r` slot, the Safe counts it as an
 * approval without an ECDSA signature. That covers exactly one approval, so this works only on
 * Safes with threshold 1 - anything higher needs the Safe app or transaction service, and this
 * helper refuses rather than half-approving.
 *
 * With safeTxGas = 0 and gasPrice = 0 the Safe reverts (GS013) when the inner call fails, so a
 * successful receipt means the inner call succeeded.
 *
 * Keep the signature in sync with the sibling copy in `registry-chain/utils/safe.ts` - the two
 * hardhat projects have no shared package, so this is duplicated on purpose.
 *
 * @param hre         The hardhat runtime environment.
 * @param safeAddress The Safe executing the call.
 * @param ownerSigner A signer that is an owner of the Safe; sends the transaction.
 * @param to          The call target.
 * @param data        The calldata the Safe forwards to `to`.
 */
export async function execTransactionThroughSafe(
  hre: HardhatRuntimeEnvironment,
  safeAddress: string,
  ownerSigner: any,
  to: string,
  data: string,
) {
  const { ethers } = hre;
  const safe = new ethers.Contract(safeAddress, SAFE_ABI, ownerSigner);

  const threshold = await safe.getThreshold();
  if (threshold !== 1n) {
    throw new Error(
      `Safe ${safeAddress} has threshold ${threshold}. This helper can only execute on 1-of-N ` +
        `Safes; propose the transaction through the Safe app instead.`,
    );
  }
  if (!(await safe.isOwner(ownerSigner.address))) {
    throw new Error(`${ownerSigner.address} is not an owner of Safe ${safeAddress}.`);
  }

  const preValidatedSignature = ethers.concat([
    ethers.zeroPadValue(ownerSigner.address, 32),
    ethers.ZeroHash,
    "0x01",
  ]);
  const tx = await safe.execTransaction(
    to,
    0,
    data,
    0, // operation: CALL
    0, // safeTxGas
    0, // baseGas
    0, // gasPrice
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    preValidatedSignature,
  );
  return await tx.wait();
}

/** One call in a Safe Transaction Builder batch. `value` defaults to "0". */
export interface SafeBatchTransaction {
  to: string;
  data: string;
  value?: string;
}

/**
 * Writes a Safe{Wallet} Transaction Builder batch file for calls the Safe has to make itself.
 *
 * This is the path taken whenever SAFE_OWNER_KEY is absent - a real multisig, or an owner key
 * that never leaves its hardware. Import the file in the Safe app under Apps -> Transaction
 * Builder, review the decoded calls, then create, sign and execute the batch.
 *
 * Batching is safe for these calls: Transaction Builder executes the batch as a
 * `MultiSendCallOnly` *delegatecall from the Safe*, so each inner call still has the Safe as
 * `msg.sender` - which is what `acceptDefaultAdminTransfer()` and `grantRole` require. The batch
 * is also atomic, so executing before a pending default-admin transfer's timelock expires reverts
 * the whole file rather than applying half of it.
 *
 * `chainId` and `value` are strings and `createdAt` is a millisecond timestamp because the
 * Transaction Builder schema requires exactly that. `meta.checksum` is omitted deliberately: it
 * exists to detect a tampered file and the app recomputes it on import.
 *
 * Keep the signature in sync with the sibling copy in `registry-chain/utils/safe.ts` - the two
 * hardhat projects have no shared package, so this is duplicated on purpose.
 *
 * @param hre          The hardhat runtime environment.
 * @param safeAddress  The Safe that will execute the batch.
 * @param slug         Short kebab-case tag used in the default filename.
 * @param name         Batch name shown in the Safe app.
 * @param description  Batch description shown in the Safe app.
 * @param transactions The calls to include, in order.
 * @param outPath      Overrides the default `<project>/safe-batches/<network>-<slug>-<unix>.json`.
 *                     Falls back to SAFE_BATCH_OUT, so the scripts that take no CLI parameters
 *                     can still be redirected.
 * @returns The path written.
 */
export function writeSafeBatch(
  hre: HardhatRuntimeEnvironment,
  {
    safeAddress,
    slug,
    name,
    description,
    transactions,
    outPath,
  }: {
    safeAddress: string;
    slug: string;
    name: string;
    description: string;
    transactions: SafeBatchTransaction[];
    outPath?: string;
  },
): string {
  const chainId = (hre.network.config as any)?.chainId;
  if (chainId === undefined) {
    throw new Error(
      `Network "${hre.network.name}" has no chainId in its hardhat config. The Safe app matches ` +
        `chainId on import, so a batch cannot be written without it.`,
    );
  }
  if (transactions.length === 0) {
    throw new Error("Refusing to write an empty Safe batch.");
  }

  const now = Date.now();
  const batch = {
    version: "1.0",
    chainId: String(chainId),
    createdAt: now,
    meta: {
      name,
      description,
      txBuilderVersion: "1.17.1",
      createdFromSafeAddress: safeAddress,
      createdFromOwnerAddress: "",
    },
    transactions: transactions.map((transaction) => ({
      to: transaction.to,
      value: transaction.value ?? "0",
      data: transaction.data,
      contractMethod: null,
      contractInputsValues: null,
    })),
  };

  const path =
    outPath ??
    process.env.SAFE_BATCH_OUT?.trim() ??
    join(
      hre.config.paths.root,
      "safe-batches",
      `${hre.network.name}-${slug}-${Math.floor(now / 1000)}.json`,
    );
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify(batch, null, 2)}\n`);
  return path;
}
