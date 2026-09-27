# FHE operation gas costs

Cell format: `first / extra`, rounded to the nearest 100 gas. `—` = the type does not support the op.

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

Arbitrum note: the numbers are L2 execution gas. Arbitrum also charges an L1 data fee for the calldata of the user's transaction. An FHE op inside a contract adds no calldata, so the fee does not change per op. Encrypted inputs (`FHE.asEuintX(InEuintX)`) do add calldata.

---

## Ethereum Sepolia (TaskManager v10)

### Arithmetic

| Operation | euint8 | euint16 | euint32 | euint64 | euint128 |
|---|---|---|---|---|---|
| `add` | 51,500 / 31,500 | 51,600 / 31,500 | 51,600 / 31,600 | 51,600 / 31,600 | 51,600 / 31,600 |
| `sub` | 51,400 / 31,400 | 51,400 / 31,400 | 51,400 / 31,400 | 51,500 / 31,400 | 51,500 / 31,500 |
| `mul` | 52,500 / 32,500 | 52,600 / 32,500 | 52,600 / 32,600 | 52,600 / 32,600 | 52,600 / 32,600 |
| `div` | 52,200 / 32,200 | 52,300 / 32,200 | 52,300 / 32,300 | 52,300 / 32,300 | 52,300 / 32,300 |
| `rem` | 52,400 / 32,400 | 52,400 / 32,400 | 52,400 / 32,400 | 52,500 / 32,400 | 52,500 / 32,500 |
| `square` | 48,800 / 28,700 | 48,800 / 28,800 | 48,800 / 28,800 | 48,800 / 28,800 | 48,900 / 28,800 |
| `min` | 53,500 / 33,500 | 53,500 / 33,500 | 53,600 / 33,500 | 53,600 / 33,600 | 53,600 / 33,600 |
| `max` | 53,700 / 33,600 | 53,700 / 33,700 | 53,700 / 33,700 | 53,700 / 33,700 | 53,800 / 33,700 |

### Comparison

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| `eq` | 52,700 / 32,700 | 52,600 / 32,600 | 52,600 / 32,600 | 52,600 / 32,600 | 52,700 / 32,600 | 52,700 / 32,700 | 52,700 / 32,700 |
| `ne` | 53,000 / 33,000 | 52,900 / 32,900 | 52,900 / 32,900 | 52,900 / 32,900 | 53,000 / 32,900 | 53,000 / 33,000 | 53,000 / 33,000 |
| `lt` | — | 52,900 / 32,900 | 53,000 / 32,900 | 53,000 / 33,000 | 53,000 / 33,000 | 53,000 / 33,000 | — |
| `lte` | — | 52,700 / 32,700 | 52,700 / 32,700 | 52,800 / 32,700 | 52,800 / 32,800 | 52,800 / 32,800 | — |
| `gt` | — | 53,200 / 33,200 | 53,300 / 33,200 | 53,300 / 33,300 | 53,300 / 33,300 | 53,300 / 33,300 | — |
| `gte` | — | 52,700 / 32,700 | 52,800 / 32,700 | 52,800 / 32,800 | 52,800 / 32,800 | 52,800 / 32,800 | — |

### Bitwise and shift

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 |
|---|---|---|---|---|---|---|
| `and` | 51,700 / 31,700 | 51,600 / 31,500 | 51,600 / 31,600 | 51,600 / 31,600 | 51,600 / 31,600 | 51,700 / 31,600 |
| `or` | 51,900 / 31,900 | 51,800 / 31,800 | 51,800 / 31,800 | 51,800 / 31,800 | 51,900 / 31,800 | 51,900 / 31,900 |
| `xor` | 51,500 / 31,500 | 51,400 / 31,400 | 51,400 / 31,400 | 51,400 / 31,400 | 51,500 / 31,400 | 51,500 / 31,500 |
| `not` | 45,700 / 25,700 | 45,500 / 25,500 | 45,600 / 25,500 | 45,600 / 25,600 | 45,600 / 25,600 | 45,600 / 25,600 |
| `shl` | — | 52,700 / 32,600 | 52,700 / 32,700 | 52,700 / 32,700 | 52,700 / 32,700 | 52,800 / 32,700 |
| `shr` | — | 52,800 / 32,800 | 52,800 / 32,800 | 52,900 / 32,800 | 52,900 / 32,900 | 52,900 / 32,900 |
| `rol` | — | 54,400 / 34,300 | 54,400 / 34,400 | 54,400 / 34,400 | 54,400 / 34,400 | 54,500 / 34,400 |
| `ror` | — | 54,500 / 34,500 | 54,500 / 34,500 | 54,600 / 34,500 | 54,600 / 34,600 | 54,600 / 34,600 |

### Select

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| `select` | 55,900 / 35,900 | 55,800 / 35,800 | 55,800 / 35,800 | 55,900 / 35,800 | 55,900 / 35,900 | 55,900 / 35,900 | 55,900 / 35,900 |

### Encrypt (create a ciphertext)

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| Trivial encrypt `FHE.asEuintX(plaintext)` ¹ | 45,400 / 25,300 | 45,100 / 25,000 | 45,100 / 25,100 | 45,200 / 25,100 | 45,200 / 25,200 | 45,300 / 25,200 | 45,400 / 25,300 |
| Encrypted input `FHE.asEuintX(InEuintX)` | 39,800 / 17,800 | 39,800 / 17,800 | 39,800 / 17,800 | 39,800 / 17,800 | 39,800 / 17,800 | 39,800 / 17,800 | 39,800 / 17,800 |
| Encrypted input, ABI-encoded `FHE.asEuintX(bytes)` | 40,400 / 18,400 | 40,400 / 18,400 | 40,400 / 18,400 | 40,400 / 18,400 | 40,400 / 18,400 | 40,400 / 18,400 | 40,400 / 18,400 |
| Random `FHE.randomEuintX()` | — | 40,800 / 16,000 | 40,800 / 16,000 | 40,900 / 16,100 | 40,900 / 16,100 | 40,900 / 16,100 | — |

### Access control

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| `allow` | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 |
| `allowThis` ² | 26,300 / 26,300 | 26,300 / 26,300 | 26,300 / 26,300 | 26,300 / 26,300 | 26,300 / 26,300 | 26,300 / 26,300 | 26,300 / 26,300 |
| `allowSender` | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 |
| `allowTransient` | 23,000 / 7,000 | 23,000 / 7,000 | 23,000 / 7,000 | 23,000 / 7,000 | 23,000 / 7,000 | 23,000 / 7,000 | 23,000 / 7,000 |
| `allowGlobal` | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 |
| `allowPublic` | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 |
| `isAllowed` (view) ⁵ | 22,200 / 6,200 | 22,200 / 6,200 | 22,200 / 6,200 | 22,200 / 6,200 | 22,200 / 6,200 | 22,200 / 6,200 | 22,200 / 6,200 |
| `isPubliclyAllowed` (view) | 21,900 / 5,900 | 21,900 / 5,900 | 21,900 / 5,900 | 21,900 / 5,900 | 21,900 / 5,900 | 21,900 / 5,900 | 21,900 / 5,900 |

### Sharing

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| `shareX` | 25,900 / 7,900 | 25,900 / 7,900 | 25,900 / 7,900 | 25,900 / 7,900 | 25,900 / 7,900 | 25,900 / 7,900 | 25,900 / 7,900 |
| `receiveXParam` ³ | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 |
| `receiveXFromCall` ³ | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 |

### Decryption results

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| `publishDecryptResult` ⁴ | 71,400 / 53,400 | 71,400 / 53,400 | 71,400 / 53,400 | 71,400 / 53,400 | 71,400 / 53,400 | 71,400 / 53,400 | 71,400 / 53,400 |
| `verifyDecryptResult` (view) | 15,100 / 6,100 | 15,100 / 6,100 | 15,100 / 6,100 | 15,100 / 6,100 | 15,100 / 6,100 | 15,100 / 6,100 | 15,100 / 6,100 |
| `verifyDecryptResultSafe` (view) | 15,700 / 6,700 | 15,700 / 6,700 | 15,700 / 6,700 | 15,700 / 6,700 | 15,700 / 6,700 | 15,700 / 6,700 | 15,700 / 6,700 |
| `getDecryptResult` (view) | 24,300 / 8,300 | 24,300 / 8,300 | 24,300 / 8,300 | 24,300 / 8,300 | 24,300 / 8,300 | 24,300 / 8,300 | 24,300 / 8,300 |
| `getDecryptResultSafe` (view) | 23,200 / 7,200 | 23,200 / 7,200 | 23,200 / 7,200 | 23,200 / 7,200 | 23,200 / 7,200 | 23,200 / 7,200 | 23,200 / 7,200 |

### Batch encrypted inputs (`FHE.asEuint32s`, one signature)

| Inputs in batch | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| Total gas | 39,600 | 45,400 | 56,900 | 79,900 |
| Gas per input | 39,600 | 22,700 | 14,200 | 10,000 |

### Cast (`FHE.asX(eY)`) — row = from, column = to

FHE.sol has no cast to `eaddress`. A cast to `ebool` is `ne(value, asEuintX(0))`: two TaskManager tasks, so it costs about 30k more than other casts.

| from \ to | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| `ebool` | — | 45,700 / 25,600 | 45,700 / 25,700 | 45,800 / 25,700 | 45,800 / 25,800 | 45,900 / 25,800 | — |
| `euint8` | 75,400 / 51,400 | — | 45,700 / 25,700 | 45,800 / 25,700 | 45,800 / 25,800 | 45,900 / 25,800 | — |
| `euint16` | 75,500 / 51,500 | 45,700 / 25,600 | — | 45,800 / 25,700 | 45,800 / 25,800 | 45,900 / 25,800 | — |
| `euint32` | 75,600 / 51,500 | 45,700 / 25,600 | 45,700 / 25,700 | — | 45,800 / 25,800 | 45,900 / 25,800 | — |
| `euint64` | 75,600 / 51,600 | 45,700 / 25,600 | 45,700 / 25,700 | 45,800 / 25,700 | — | 45,900 / 25,800 | — |
| `euint128` | 75,700 / 51,700 | 45,700 / 25,600 | 45,700 / 25,700 | 45,800 / 25,700 | 45,800 / 25,800 | — | — |
| `eaddress` | 75,800 / 51,800 | 45,700 / 25,600 | 45,700 / 25,700 | 45,800 / 25,700 | 45,800 / 25,800 | 45,900 / 25,800 | — |

### Batch decryption results (euint32)

| Results in batch | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| `publishDecryptResultBatch` total | 75,100 | 128,700 | 235,800 | 450,100 |
| `verifyDecryptResultBatch` total | 18,800 | 24,300 | 35,500 | 57,800 |
| `verifyDecryptResultBatchSafe` total | 19,500 | 25,400 | 37,100 | 60,700 |

---

## Arbitrum Sepolia (TaskManager v11)

### Arithmetic

| Operation | euint8 | euint16 | euint32 | euint64 | euint128 |
|---|---|---|---|---|---|
| `add` | 51,500 / 31,500 | 51,600 / 31,500 | 51,600 / 31,600 | 51,600 / 31,600 | 51,600 / 31,600 |
| `sub` | 51,400 / 31,400 | 51,400 / 31,400 | 51,400 / 31,400 | 51,500 / 31,400 | 51,500 / 31,500 |
| `mul` | 52,500 / 32,500 | 52,600 / 32,500 | 52,600 / 32,600 | 52,600 / 32,600 | 52,600 / 32,600 |
| `div` | 52,200 / 32,200 | 52,300 / 32,200 | 52,300 / 32,300 | 52,300 / 32,300 | 52,300 / 32,300 |
| `rem` | 52,400 / 32,400 | 52,400 / 32,400 | 52,400 / 32,400 | 52,500 / 32,400 | 52,500 / 32,500 |
| `square` | 48,800 / 28,700 | 48,800 / 28,800 | 48,800 / 28,800 | 48,800 / 28,800 | 48,900 / 28,800 |
| `min` | 53,500 / 33,500 | 53,500 / 33,500 | 53,600 / 33,500 | 53,600 / 33,600 | 53,600 / 33,600 |
| `max` | 53,700 / 33,600 | 53,700 / 33,700 | 53,700 / 33,700 | 53,700 / 33,700 | 53,800 / 33,700 |

### Comparison

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| `eq` | 52,700 / 32,700 | 52,600 / 32,600 | 52,600 / 32,600 | 52,600 / 32,600 | 52,700 / 32,600 | 52,700 / 32,700 | 52,700 / 32,700 |
| `ne` | 53,000 / 33,000 | 52,900 / 32,900 | 52,900 / 32,900 | 52,900 / 32,900 | 53,000 / 32,900 | 53,000 / 33,000 | 53,000 / 33,000 |
| `lt` | — | 52,900 / 32,900 | 53,000 / 32,900 | 53,000 / 33,000 | 53,000 / 33,000 | 53,000 / 33,000 | — |
| `lte` | — | 52,700 / 32,700 | 52,700 / 32,700 | 52,800 / 32,700 | 52,800 / 32,800 | 52,800 / 32,800 | — |
| `gt` | — | 53,200 / 33,200 | 53,300 / 33,200 | 53,300 / 33,300 | 53,300 / 33,300 | 53,300 / 33,300 | — |
| `gte` | — | 52,700 / 32,700 | 52,800 / 32,700 | 52,800 / 32,800 | 52,800 / 32,800 | 52,800 / 32,800 | — |

### Bitwise and shift

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 |
|---|---|---|---|---|---|---|
| `and` | 51,700 / 31,700 | 51,600 / 31,500 | 51,600 / 31,600 | 51,600 / 31,600 | 51,600 / 31,600 | 51,700 / 31,600 |
| `or` | 51,900 / 31,900 | 51,800 / 31,800 | 51,800 / 31,800 | 51,800 / 31,800 | 51,900 / 31,800 | 51,900 / 31,900 |
| `xor` | 51,500 / 31,500 | 51,400 / 31,400 | 51,400 / 31,400 | 51,400 / 31,400 | 51,500 / 31,400 | 51,500 / 31,500 |
| `not` | 45,700 / 25,700 | 45,500 / 25,500 | 45,600 / 25,500 | 45,600 / 25,600 | 45,600 / 25,600 | 45,600 / 25,600 |
| `shl` | — | 52,700 / 32,600 | 52,700 / 32,700 | 52,700 / 32,700 | 52,700 / 32,700 | 52,800 / 32,700 |
| `shr` | — | 52,800 / 32,800 | 52,800 / 32,800 | 52,900 / 32,800 | 52,900 / 32,900 | 52,900 / 32,900 |
| `rol` | — | 54,400 / 34,300 | 54,400 / 34,400 | 54,400 / 34,400 | 54,400 / 34,400 | 54,500 / 34,400 |
| `ror` | — | 54,500 / 34,500 | 54,500 / 34,500 | 54,600 / 34,500 | 54,600 / 34,600 | 54,600 / 34,600 |

### Select

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| `select` | 55,900 / 35,900 | 55,800 / 35,800 | 55,800 / 35,800 | 55,900 / 35,800 | 55,900 / 35,900 | 55,900 / 35,900 | 55,900 / 35,900 |

### Encrypt (create a ciphertext)

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| Trivial encrypt `FHE.asEuintX(plaintext)` ¹ | 45,400 / 25,300 | 45,100 / 25,000 | 45,100 / 25,100 | 45,200 / 25,100 | 45,200 / 25,200 | 45,300 / 25,200 | 45,400 / 25,300 |
| Encrypted input `FHE.asEuintX(InEuintX)` | 39,800 / 17,800 | 39,800 / 17,800 | 39,800 / 17,800 | 39,800 / 17,800 | 39,800 / 17,800 | 39,800 / 17,800 | 39,800 / 17,800 |
| Encrypted input, ABI-encoded `FHE.asEuintX(bytes)` | 40,400 / 18,400 | 40,400 / 18,400 | 40,400 / 18,400 | 40,400 / 18,400 | 40,400 / 18,400 | 40,400 / 18,400 | 40,400 / 18,400 |
| Random `FHE.randomEuintX()` | — | 40,800 / 16,000 | 40,800 / 16,000 | 40,900 / 16,100 | 40,900 / 16,100 | 40,900 / 16,100 | — |

### Access control

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| `allow` | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 |
| `allowThis` ² | 26,300 / 26,300 | 26,300 / 26,300 | 26,300 / 26,300 | 26,300 / 26,300 | 26,300 / 26,300 | 26,300 / 26,300 | 26,300 / 26,300 |
| `allowSender` | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 | 44,700 / 28,700 |
| `allowTransient` | 23,000 / 7,000 | 23,000 / 7,000 | 23,000 / 7,000 | 23,000 / 7,000 | 23,000 / 7,000 | 23,000 / 7,000 | 23,000 / 7,000 |
| `allowGlobal` | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 |
| `allowPublic` | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 | 44,100 / 28,100 |
| `isAllowed` (view) ⁵ | 22,200 / 6,200 | 22,200 / 6,200 | 22,200 / 6,200 | 22,200 / 6,200 | 22,200 / 6,200 | 22,200 / 6,200 | 22,200 / 6,200 |
| `isPubliclyAllowed` (view) | 21,900 / 5,900 | 21,900 / 5,900 | 21,900 / 5,900 | 21,900 / 5,900 | 21,900 / 5,900 | 21,900 / 5,900 | 21,900 / 5,900 |

### Sharing

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| `shareX` | 25,900 / 7,900 | 25,900 / 7,900 | 25,900 / 7,900 | 25,900 / 7,900 | 25,900 / 7,900 | 25,900 / 7,900 | 25,900 / 7,900 |
| `receiveXParam` ³ | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 |
| `receiveXFromCall` ³ | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 | 6,300 / 6,300 |

### Decryption results

| Operation | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| `publishDecryptResult` ⁴ | 71,400 / 53,400 | 71,400 / 53,400 | 71,400 / 53,400 | 71,400 / 53,400 | 71,400 / 53,400 | 71,400 / 53,400 | 71,400 / 53,400 |
| `verifyDecryptResult` (view) | 15,100 / 6,100 | 15,100 / 6,100 | 15,100 / 6,100 | 15,100 / 6,100 | 15,100 / 6,100 | 15,100 / 6,100 | 15,100 / 6,100 |
| `verifyDecryptResultSafe` (view) | 15,700 / 6,700 | 15,700 / 6,700 | 15,700 / 6,700 | 15,700 / 6,700 | 15,700 / 6,700 | 15,700 / 6,700 | 15,700 / 6,700 |
| `getDecryptResult` (view) | 24,300 / 8,300 | 24,300 / 8,300 | 24,300 / 8,300 | 24,300 / 8,300 | 24,300 / 8,300 | 24,300 / 8,300 | 24,300 / 8,300 |
| `getDecryptResultSafe` (view) | 23,200 / 7,200 | 23,200 / 7,200 | 23,200 / 7,200 | 23,200 / 7,200 | 23,200 / 7,200 | 23,200 / 7,200 | 23,200 / 7,200 |

### Batch encrypted inputs (`FHE.asEuint32s`, one signature)

| Inputs in batch | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| Total gas | 39,600 | 45,400 | 56,900 | 79,900 |
| Gas per input | 39,600 | 22,700 | 14,200 | 10,000 |

### Cast (`FHE.asX(eY)`) — row = from, column = to

FHE.sol has no cast to `eaddress`. A cast to `ebool` is `ne(value, asEuintX(0))`: two TaskManager tasks, so it costs about 30k more than other casts.

| from \ to | ebool | euint8 | euint16 | euint32 | euint64 | euint128 | eaddress |
|---|---|---|---|---|---|---|---|
| `ebool` | — | 45,700 / 25,600 | 45,700 / 25,700 | 45,800 / 25,700 | 45,800 / 25,800 | 45,900 / 25,800 | — |
| `euint8` | 75,400 / 51,400 | — | 45,700 / 25,700 | 45,800 / 25,700 | 45,800 / 25,800 | 45,900 / 25,800 | — |
| `euint16` | 75,500 / 51,500 | 45,700 / 25,600 | — | 45,800 / 25,700 | 45,800 / 25,800 | 45,900 / 25,800 | — |
| `euint32` | 75,600 / 51,500 | 45,700 / 25,600 | 45,700 / 25,700 | — | 45,800 / 25,800 | 45,900 / 25,800 | — |
| `euint64` | 75,600 / 51,600 | 45,700 / 25,600 | 45,700 / 25,700 | 45,800 / 25,700 | — | 45,900 / 25,800 | — |
| `euint128` | 75,700 / 51,700 | 45,700 / 25,600 | 45,700 / 25,700 | 45,800 / 25,700 | 45,800 / 25,800 | — | — |
| `eaddress` | 75,800 / 51,800 | 45,700 / 25,600 | 45,700 / 25,700 | 45,800 / 25,700 | 45,800 / 25,800 | 45,900 / 25,800 | — |

### Batch decryption results (euint32)

| Results in batch | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| `publishDecryptResultBatch` total | 75,100 | 128,700 | 235,800 | 450,100 |
| `verifyDecryptResultBatch` total | 18,800 | 24,300 | 35,500 | 57,800 |
| `verifyDecryptResultBatchSafe` total | 19,500 | 25,400 | 37,100 | 60,700 |

---

## Notes

¹ Trivial `ebool` has only two handles (`true`, `false`), shared by every contract on the chain. Their ACL state differs per chain, so these cells can differ by a few gas between chains. The same holds for the cast-to-`ebool` column, which uses the shared trivial-0 handle.
² `allowThis` is measured on a result handle created earlier in the same transaction (the normal pattern: compute, then `allowThis`). The TaskManager is already warm, so `first` and `extra` are close.
³ A receive always follows a share in the same transaction, so the TaskManager is already warm; `first` and `extra` are close.
⁴ Measured with a non-zero result. A zero result (for example `false` or an amount of 0) leaves one storage slot at zero, so it costs less.
⁵ Measured on a handle already allowed to the account, which returns early. A "not allowed" answer reads more storage, so it costs more.

## Type dependence summary

Spread = max − min of `first` across types for one op; the table shows the largest op spread in the category. Flat = spread ≤ 200 gas. Casts to `ebool` are left out (see the cast table).

| Category | Flat across types? | Max spread across types, Sepolia | Max spread across types, Arb Sepolia |
|---|---|---|---|
| Arithmetic | yes | 104 | 104 |
| Comparison | yes | 136 | 136 |
| Bitwise and shift | yes | 136 | 136 |
| Select | yes | 136 | 136 |
| Encrypt | no | 267 | 267 |
| Cast | no | 208 | 208 |
| Access control | yes | 0 | 0 |
| Sharing | yes | 0 | 0 |
| Decryption results | yes | 0 | 0 |

## Chain difference summary

| Category | Sepolia median `first` | Arb Sepolia median `first` | Delta (raw gas) |
|---|---|---|---|
| Arithmetic | 52,400 | 52,400 | +0 |
| Comparison | 52,900 | 52,900 | +0 |
| Bitwise and shift | 51,900 | 51,900 | +0 |
| Select | 55,900 | 55,900 | +0 |
| Encrypt | 40,400 | 40,400 | +0 |
| Cast | 45,800 | 45,800 | +0 |
| Access control | 35,200 | 35,200 | +0 |
| Sharing | 6,300 | 6,300 | +0 |
| Decryption results | 23,200 | 23,200 | +0 |
