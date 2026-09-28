# FHE operation gas costs

One value per op: the cost barely depends on the encrypted type, because the FHE math runs offchain. Each value is the highest across the listed types, rounded to the nearest 100 gas. Type spread = highest − lowest raw `first` across those types.

- **first** — gas of the FHE call when it is the first FHE call in the transaction (cold TaskManager and ACL access).
- **extra** — gas of the same op again in the same transaction. The second call reuses no operand of the first, so the TaskManager is warm but the operands' ACL entries are cold.

## Measurement setup

| Item | Ethereum Sepolia | Arbitrum Sepolia |
|---|---|---|
| Chain ID | 11155111 | 421614 |
| Fork block | 11,793,690 | 313,281,513 |
| TaskManager proxy | `0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9` | `0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9` |
| TaskManager implementation | `0x988bf41f45AbDdA0d4d4397CbFA9ac8551789421` | `0xd5A90bcFa4DB735D2385FCd8B980b01d9cAbC1BE` |
| TaskManager `getVersion()` (upgrade counter only) | 10 | 11 |
| TaskManager source (bytecode-verified) | cofhe-contracts 0.3.0 (sources at `0de4946`) | cofhe-contracts 0.3.0 (sources at `0de4946`) |
| ACL proxy | `0x5ACD9054a211C1bF5aD24d47b16eA736ccC91b84` | `0x76d57191A9769A88a041FeeADc53AaE6EB663B83` |
| ACL implementation | `0x5484F3cC3F944F1C8791A1E68645551328981b76` | `0xB78000d9c885e37e66633fAFb7E712C26d52D27F` |
| ACL source (bytecode-verified) | cofhe-contracts 0.3.0 (sources at `0de4946`) | cofhe-contracts 0.3.0 (sources at `0de4946`) |
| PlaintextsStorage proxy | `0x11b3845fbe9cD1468588b586f3E83D8F936f916b` | `0x3150A5f542e5Ecb28b67399f1a48E6385c4ad579` |
| PlaintextsStorage implementation | `0x4FA356CbA86c4C2c68F49B25a79c06895A7a3B5D` | `0xcF19Bc30d7914ac6C28854355bf18190aC31bFC8` |
| PlaintextsStorage source (bytecode-verified) | cofhe-contracts 0.3.0 (sources at `0de4946`) | cofhe-contracts 0.3.0 (sources at `0de4946`) |
| FHE.sol in the measuring contract | cofhe-contracts 0.3.0 (FHE.sol at `be9ad56`) | same |
| Compiler | solc 0.8.25, optimizer 800 runs, viaIR, cancun | same |
| Method | Foundry fork; `gasleft()` delta around the single `FHE.*` call; each probe call is its own transaction (`isolate = true`) | same |

Both chains run the same cofhe-contracts code and were measured separately. Every published value is equal on both chains (Arbitrum Sepolia: 314 of 315 rows equal Sepolia to the gas unit; the rest differ by less than the rounding).

Engine check: every probe row and two FHERC20 transfers (317 calls) were replayed as `eth_call` with a state override on real nodes of Ethereum mainnet, Arbitrum One, Ethereum Sepolia, Arbitrum Sepolia. Each node's own EVM (geth, Arbitrum Nitro) returned exactly the same gas, equal to the fork values. CoFHE 0.3.0 is not deployed on Ethereum mainnet or Arbitrum One yet; the check used the verified 0.3.0 bytecode.

Arbitrum note: the numbers are L2 execution gas. Arbitrum also charges an L1 data fee for the calldata of the user's transaction. An FHE op inside a contract adds no calldata, so the fee does not change per op. Encrypted inputs (`FHE.asEuintX(InEuintX)`) do add calldata.

---

## Ethereum Sepolia and Arbitrum Sepolia

### FHERC20 transfer (whole transaction)

The reference `FHERC20` (its test harness) from `FhenixProtocol/fhenix-confidential-contracts` at `5138cb8`, deployed on each fork, with an encrypted input amount (`InEuint64`) where the call takes one. Gas is the full transaction: 21,000 base + calldata + execution. On Arbitrum, add the L1 data fee for the calldata.

| Action | Gas (full transaction) |
|---|---|
| `confidentialTransfer` to an existing holder | 421,500 |
| `confidentialTransfer`, repeated (same sender and recipient) | 421,500 |
| `confidentialTransfer` to a new holder (no balance yet) | 474,400 |
| `confidentialTransferFrom` by an operator | 424,800 |
| `setOperator` (one-time approval) | 46,700 |
| Baseline: plain OpenZeppelin ERC20 `transfer` to an existing holder | 34,500 |
| Baseline: plain OpenZeppelin ERC20 `transfer` to a new holder | 51,600 |

### ERC20Confidential transfer (whole transaction)

`ERC20Confidential` (hybrid public + confidential balances; its mock, linked to `ERC20ConfidentialLib`) from `FhenixProtocol/fhenix-confidential-contracts` at `5138cb8`, deployed on each fork, with an encrypted input amount (`InEuint64`) where the call takes one. Gas is the full transaction: 21,000 base + calldata + execution. On Arbitrum, add the L1 data fee for the calldata.

| Action | Gas (full transaction) |
|---|---|
| `confidentialTransfer` to an existing holder | 430,000 |
| `confidentialTransfer` to a new holder (no balance yet) | 482,900 |
| `confidentialTransferFrom` by an operator | 433,800 |
| `confidentialTransfer` to an existing holder, with an observer set | 508,900 |
| `shield` (public balance → confidential balance) | 407,900 |
| `setOperator` (one-time approval) | 46,800 |
| Public ERC20 `transfer` on the same token, to an existing holder | 34,900 |
| Public ERC20 `transfer` on the same token, to a new holder | 52,000 |

### Arithmetic

| Operation | first | extra | Types | Type spread (gas) |
|---|---|---|---|---|
| `add` | 51,600 | 31,600 | euint8–euint128 | 104 |
| `sub` | 51,500 | 31,500 | euint8–euint128 | 104 |
| `mul` | 52,600 | 32,600 | euint8–euint128 | 104 |
| `div` | 52,300 | 32,300 | euint8–euint128 | 104 |
| `rem` | 52,500 | 32,500 | euint8–euint128 | 104 |
| `square` | 48,900 | 28,800 | euint8–euint128 | 104 |
| `min` | 53,600 | 33,600 | euint8–euint128 | 104 |
| `max` | 53,800 | 33,700 | euint8–euint128 | 104 |

### Comparison

| Operation | first | extra | Types | Type spread (gas) |
|---|---|---|---|---|
| `eq` | 52,700 | 32,700 | all 7 types | 136 |
| `ne` | 53,000 | 33,000 | all 7 types | 136 |
| `lt` | 53,000 | 33,000 | euint8–euint128 | 104 |
| `lte` | 52,800 | 32,800 | euint8–euint128 | 104 |
| `gt` | 53,300 | 33,300 | euint8–euint128 | 104 |
| `gte` | 52,800 | 32,800 | euint8–euint128 | 104 |

### Bitwise and shift

| Operation | first | extra | Types | Type spread (gas) |
|---|---|---|---|---|
| `and` | 51,700 | 31,700 | ebool, euint8–euint128 | 136 |
| `or` | 51,900 | 31,900 | ebool, euint8–euint128 | 136 |
| `xor` | 51,500 | 31,500 | ebool, euint8–euint128 | 136 |
| `not` | 45,700 | 25,700 | ebool, euint8–euint128 | 136 |
| `shl` | 52,800 | 32,700 | euint8–euint128 | 104 |
| `shr` | 52,900 | 32,900 | euint8–euint128 | 104 |
| `rol` | 54,500 | 34,400 | euint8–euint128 | 104 |
| `ror` | 54,600 | 34,600 | euint8–euint128 | 104 |

### Select

| Operation | first | extra | Types | Type spread (gas) |
|---|---|---|---|---|
| `select` | 55,900 | 35,900 | all 7 types | 136 |

### Encrypt (create a ciphertext)

| Operation | first | extra | Types | Type spread (gas) |
|---|---|---|---|---|
| Trivial encrypt `FHE.asEuintX(plaintext)` ¹ | 45,400 | 25,300 | all 7 types | 267 |
| Encrypted input `FHE.asEuintX(InEuintX)` | 39,800 | 17,800 | all 7 types | 1 |
| Encrypted input, ABI-encoded `FHE.asEuintX(bytes)` | 40,400 | 18,400 | all 7 types | 6 |
| Random `FHE.randomEuintX()` | 40,900 | 16,100 | euint8–euint128 | 104 |

### Cast

| Operation | first | extra | Types | Type spread (gas) |
|---|---|---|---|---|
| Cast `FHE.asX(eY)`, not to `ebool` | 45,900 | 25,800 | any → euint8–euint128 | 208 |
| Cast to `ebool` `FHE.asEbool(eY)` ¹ ⁶ | 75,800 | 51,800 | euint8–euint128, eaddress → ebool | 422 |

### Access control

| Operation | first | extra | Types | Type spread (gas) |
|---|---|---|---|---|
| `allow` | 44,700 | 28,700 | all 7 types | 0 |
| `allowThis` ² | 26,300 | 26,300 | all 7 types | 0 |
| `allowSender` | 44,700 | 28,700 | all 7 types | 0 |
| `allowTransient` | 23,000 | 7,000 | all 7 types | 0 |
| `allowGlobal` | 44,100 | 28,100 | all 7 types | 0 |
| `allowPublic` | 44,100 | 28,100 | all 7 types | 0 |
| `isAllowed` (view) ⁵ | 22,200 | 6,200 | all 7 types | 0 |
| `isPubliclyAllowed` (view) | 21,900 | 5,900 | all 7 types | 0 |

### Sharing

| Operation | first | extra | Types | Type spread (gas) |
|---|---|---|---|---|
| `shareX` | 25,900 | 7,900 | all 7 types | 0 |
| `receiveXParam` ³ | 6,300 | 6,300 | all 7 types | 0 |
| `receiveXFromCall` ³ | 6,300 | 6,300 | all 7 types | 0 |

### Decryption results

| Operation | first | extra | Types | Type spread (gas) |
|---|---|---|---|---|
| `publishDecryptResult` ⁴ | 71,400 | 53,400 | all 7 types | 0 |
| `verifyDecryptResult` (view) | 15,100 | 6,100 | all 7 types | 0 |
| `verifyDecryptResultSafe` (view) | 15,700 | 6,700 | all 7 types | 0 |
| `getDecryptResult` (view) | 24,300 | 8,300 | all 7 types | 0 |
| `getDecryptResultSafe` (view) | 23,200 | 7,200 | all 7 types | 0 |

### Batch encrypted inputs (`FHE.asEuint32s`, one signature)

| Inputs in batch | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| Total gas | 39,600 | 45,400 | 56,900 | 79,900 |
| Gas per input | 39,600 | 22,700 | 14,200 | 10,000 |

### Batch decryption results (euint32)

| Results in batch | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| `publishDecryptResultBatch` total | 75,100 | 128,700 | 235,800 | 450,100 |
| `verifyDecryptResultBatch` total | 18,800 | 24,300 | 35,500 | 57,800 |
| `verifyDecryptResultBatchSafe` total | 19,500 | 25,400 | 37,100 | 60,700 |

---

## Notes

¹ Trivial `ebool` has only two handles (`true`, `false`), shared by every contract on the chain. Their ACL state differs per chain, so these cells can differ by a few gas between chains. The same holds for a cast to `ebool`, which uses the shared trivial-0 handle.
² `allowThis` is measured on a result handle created earlier in the same transaction (the normal pattern: compute, then `allowThis`). The TaskManager is already warm, so `first` and `extra` are close.
³ A receive always follows a share in the same transaction, so the TaskManager is already warm; `first` and `extra` are close.
⁴ Measured with a non-zero result. A zero result (for example `false` or an amount of 0) leaves one storage slot at zero, so it costs less.
⁵ Measured on a handle already allowed to the account, which returns early. A "not allowed" answer reads more storage, so it costs more.
⁶ FHE.sol implements a cast to `ebool` as `ne(value, asEuintX(0))`: two TaskManager tasks instead of one.
