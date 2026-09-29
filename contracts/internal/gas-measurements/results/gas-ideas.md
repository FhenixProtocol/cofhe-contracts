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

### U1. A fused or batch FHE op for the transfer (Haim, 2026-09-29)

- **What:** one task that runs a whole sequence of ops off-chain in FHEOS and returns only the handles the contract keeps. For a transfer: `transfer(balFrom, balTo, amount) → (newFrom, newTo, moved)`. A generic form takes a small op sequence ("batch"), so auctions, votes and swaps can use it too.
- **Why:** the intermediate handles (`success`, `zero`, `spent`) cost tasks, not storage. The 5 tasks cost 133.5k (measured); only 3 results must live on.
- **Where:** TaskManager (a task with several output handles, for example handle = hash(op, inputs, output index)) + FHEOS (run the sequence) + the token. The TaskManager already accepts 3 inputs per task.
- **Expected:** about 95–100k per transfer (~23%). Derived from the measured per-task cost (~27k), not measured as a whole.
- **Open questions:** a transfer-only op vs a generic batch op; handle derivation for several outputs; FHEOS support and latency.
- **Status:** Not tried. Next step: measure the on-chain side on a fork with a modified TaskManager that accepts one multi-output task.

### U2. Permissions attached to the task (Haim, 2026-09-29)

- **What:** the task call carries the output permissions (for example "newFrom → this + from"), so the TaskManager writes them in the same call. No separate `allow` calls.
- **Why:** each of the 7 allows costs 25.8k: 22.1k for the new storage slot + about 3.7k call overhead (measured).
- **Where:** TaskManager + FHE.sol API.
- **Expected:** about 26k per transfer (the call overhead of 7 allows). The storage writes stay. Derived, not measured.
- **Status:** Not tried. Measure together with U1.

### U3. Owner permissions from token state instead of ACL entries (Haim, 2026-09-29)

- **What:** the decryption network checks ownership through the token (for example "is this handle `balanceOf(user)`?") instead of an ACL slot per (handle, account).
- **Why:** 7 × 22.1k = 155k of each transfer is ACL storage. The minimum for "confidential ERC20" semantics is the two balances and who owns them, which the token already stores.
- **Where:** ACL model, decryption network, SDK permits. A protocol design change with security implications.
- **Expected:** at least ~44k (the two owner allows), more if the contract's own access is also implied. Derived, not measured.
- **Status:** Not tried. Needs a design review first.

### Combined target (derived, not measured)

| Version | Gas per transfer |
|---|---|
| Today (FHERC20, measured) | 421,500 |
| + zero cache (measured) | 401,000 |
| + U1 fused or batch op | ~305,000 |
| + U2 permissions attached to the task | ~280,000 |
| + U3 ACL model change | ~235,000 or less |
| Plain ERC20 (measured) | 34,500 |
