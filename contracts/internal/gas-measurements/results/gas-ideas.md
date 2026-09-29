# Gas-saving ideas for confidential transfers

A log of ideas to reduce the gas of a confidential transfer. Each idea has a status and a result.
Numbers come only from real fork runs (CoFHE 0.3.0 TaskManager, Ethereum Sepolia and Arbitrum Sepolia; both give the same numbers).

Status values:
- **Measured**: we built it and measured it on the fork.
- **Not tried**: an idea only. The saving is derived from measured parts, not measured itself.

## Baseline: where the gas goes

One FHERC20 `confidentialTransfer` to an existing holder costs **421,530 gas** (full transaction).
The trace of one transfer shows these parts:

| Part | Calls | Gas | Share |
|---|---|---|---|
| ACL `allow` / `allowThis` | 7 × 25,833 | 180,800 | 43% |
| FHE tasks (`gte`, trivial 0, `select`, `sub`, `add`) | 5 × 23,800–29,100 | 133,500 | 32% |
| Input verification (`batchVerifyInputs`) | 1 | 34,900 | 8% |
| `shareCtHash` | 1 | 4,800 | 1% |
| Token logic (balance and indicator writes, events, reentrancy guard, base cost) | — | ~67,000 | 16% |

Each `allow` is about 22,100 gas for a new storage slot plus about 3,700 gas of call overhead.

## Ideas

### 1. Cache the encrypted zero in the token

- **What:** `asEuint64(0)` always returns the same handle. The token creates it once at init, calls `allowThis` on it, and stores it. The transfer path then uses the stored handle instead of a new trivial-encrypt task each time. It is used in `trySpend`, in the recipient `add` for a new holder, in mint, and in `transferAndCall`.
- **Where:** token only (fhenix-confidential-contracts). No protocol change.
- **Status:** Measured.
- **Result:**

| Action | Original | Zero cache | Saving |
|---|---|---|---|
| `confidentialTransfer` to an existing holder | 421,530 | 400,997 | −20,533 (−4.9%) |
| `confidentialTransfer` to a new holder | 474,401 | 433,283 | −41,118 (−8.7%) |
| `confidentialTransfer`, repeated | 421,530 | 400,997 | −20,533 (−4.9%) |
| `confidentialTransferFrom` by an operator | 424,798 | 404,265 | −20,533 (−4.8%) |

- **Behavior:** the same. After the same transfers, the balance handles of all three holders are identical to the original token. Handles are pure functions of their inputs, so the encrypted computation is identical.
- **How it was measured:** both tokens ran on the same clean fork state, with the same inputs. The state is restored between the two runs. Without this, the second token looks ~100k cheaper, because ACL entries such as `allow(handle, alice)` are keyed by handle and account, and the first run had already written them.
- **Caveats:**
  - `FHERC20Upgradeable` needs a reinitializer that sets `_zero` on tokens that are already deployed.
  - Ask the cofhe team to confirm that the coprocessor keeps the trivial-zero ciphertext for the life of the token.
  - Each use of the stored zero reads its ACL entry from storage (about +2,500 gas on the `select`). The saving above is net of this.
- **Code:** `src/variants/`; diff against upstream in `results/zero-cache.patch`; test `test/Fherc20ZeroCacheGas.t.sol`.

### 2. Allow several accounts in one call

- **What:** a new FHE.sol and TaskManager call that grants one handle to several accounts, for example `allow(h, [this, from])`. The 7 allow calls of a transfer go to 2–3 accounts per handle, so 7 calls become 3.
- **Where:** FHE.sol + TaskManager API (additive, not breaking).
- **Status:** Not tried.
- **Expected result:** it removes the call overhead of 4 calls, about 15,000 gas (~3.5%). The 22,100-gas storage writes stay.

### 3. A leaner `createTask`

- **What:** remove the op-name string from the `TaskCreated` event (use the enum value instead). Reduce the TaskManager → ACL proxy hops per task.
- **Where:** TaskManager + coprocessor (the coprocessor reads the event, so the event format changes).
- **Status:** Not tried.
- **Expected result:** up to about 50,000 gas per transfer (~12%). Evidence: Zama's additional ops cost about 12,000 gas less than ours (19,600 vs 31,600 for `add`), and a transfer runs 5 tasks.
- **Note:** this changes an interface. Do it before v1.0.0.

### 4. One fused "try-subtract" op

- **What:** `trySpend` runs `gte` + `select` + `sub` (81,800 gas). One new op returns `(ok, newBalance, spent)` in one task.
- **Where:** TaskManager + coprocessor (new FunctionId and its FHE implementation).
- **Status:** Not tried.
- **Expected result:** about 50,000 gas per transfer (~12%).

## User ideas

<!-- Add ideas here. For each: what, where, status, result. -->
