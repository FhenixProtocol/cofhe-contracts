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

### 5. Constant handles for 0 and `true` (variants A and B)

- **What:** a trivial constant always has the same handle, on every chain and for every contract: the handle derives only from (value, type, security zone, op). So the token uses hardcoded handles instead of a new trivial-encrypt task each time:
  - `ZERO_EUINT64 = 0x43662edd94f2cbb937c25150b4e534c629d27a2e7f7c7b9e5d7367635dbc8500`
  - `TRUE_EBOOL = 0xb3e26d30bbd0fa3e41a1d86cb7844842fbb2638ed221cf36790bbd9c9f3e8000`

  Both values were checked against the live Sepolia and Arbitrum Sepolia TaskManagers (static `createTask`).
- **Where:** token only. Every constant trivial encrypt on the token paths is replaced: `FHESafeMath` (`trySpend`, `tryIncrease`, `tryDecrease`, `tryAdd`, `trySub`), `FHERC20Core` (`_update`, `_transferAndCall`, the `add` for a new holder), and `FHERC20Utils.checkOnTransferReceived`.
- **ACL access:** a hardcoded handle still needs ACL access, because the TaskManager checks every input (`transient || persisted || global`).
  - **A (allowThis):** the constructor creates each constant once and calls `allowThis`.
  - **B (global):** a one-time, chain-wide registrar creates each constant and calls `allowGlobal`. Tokens then need no setup. See U4.
- **Status:** Measured (Sepolia fork; Arbitrum Sepolia gives the same numbers).
- **Result** (whole-transaction gas; delta vs the original):

| Action | Original | Zero cache (idea 1) | A: constants + allowThis | B: constants + global |
|---|---|---|---|---|
| Deploy the token (one time) | 2,399,007 | +153,551 | +193,021 | +55,244 |
| Mint, first ever | 420,567 | −41,113 (−9.8%) | −66,145 (−15.7%) | −61,044 (−14.5%) |
| Mint to a new account | 447,381 | −41,114 (−9.2%) | −43,330 (−9.7%) | −40,596 (−9.1%) |
| Mint to a holder | 394,510 | −20,527 (−5.2%) | −22,645 (−5.7%) | −20,278 (−5.1%) |
| Burn | 365,330 | −20,562 (−5.6%) | −22,661 (−6.2%) | −20,294 (−5.6%) |
| `confidentialTransfer` to a holder | 421,530 | −20,533 (−4.9%) | −22,632 (−5.4%) | −20,265 (−4.8%) |
| `confidentialTransfer` to a new holder | 474,401 | −41,118 (−8.7%) | −43,317 (−9.1%) | −40,583 (−8.6%) |
| `confidentialTransferFrom` by an operator | 424,798 | −20,533 (−4.8%) | −22,632 (−5.3%) | −20,265 (−4.8%) |
| `confidentialTransferAndCall` to an EOA | 897,190 | −82,186 (−9.2%) | −107,446 (−12.0%) | −101,611 (−11.3%) |

- **Behavior:** the same. After the same flow, the balances of 4 accounts and the total supply have identical handles in all variants.
- **A vs B:** B costs about 2,370 gas more per use than A. With a global entry, `isAllowed` first misses the persisted entry and then reads the global entry (one more cold storage read).
- **A vs zero cache:** A saves about 2,100 more per transfer. There is no storage read of a cached handle, and `true` is covered too.
- **Recommendation:** A for one token. B if FHE.sol ships the constants for everyone (U4).
- **Caveats:** the coprocessor must keep the constant ciphertexts for good. `FHERC20Upgradeable` needs a reinitializer for A.
- **Code:** `src/variants/constants/`; test `test/Fherc20ConstantsGas.t.sol`; results `results/fherc20-constants-*.json`.

### 6. Skip the zero refund in `transferAndCall` to an EOA (variant D)

- **What:** when the recipient has no code, `checkOnTransferReceived` makes no callback and returns a constant `true`. The original then still runs `refund = _update(to, from, select(TRUE, ZERO, sent))`, a full second transfer of an encrypted 0, and `transferred = sub(sent, refund)`. D returns `sent` directly when `to.code.length == 0`. The path for contract recipients does not change.
- **Where:** token only (`FHERC20Core._transferAndCall`).
- **Status:** Measured (Sepolia fork; Arbitrum Sepolia gives the same numbers).
- **Result:**

| Action | Original | A: constants | D alone | D + A |
|---|---|---|---|---|
| `confidentialTransferAndCall` to a new EOA | 897,190 | 789,744 (−12.0%) | 477,955 (−46.7%) | 434,635 (−51.6%) |
| `confidentialTransferAndCall` to an EOA holder | 841,505 | 754,746 (−10.3%) | 425,072 (−49.5%) | 402,437 (−52.2%) |
| `confidentialTransfer` to a holder (no change expected) | 421,518 | 398,886 (−5.4%) | 421,518 (0) | 398,886 (−5.4%) |

- **Proof that the skipped refund is always 0:** on the original, the fork logs show exactly one refund `select` per call, with condition `TRUE_EBOOL` and "if true" `ZERO_EUINT64`. `select(TRUE, ZERO, x)` is ZERO by definition. Example refund handle: `0x3dad69baee75374a10768137fdbb81aab7d70e09d3e2d7218c584821b75a0500`.
- **Behavior difference:**
  - The same plaintext balances: the original adds and subtracts a zero refund.
  - Different balance handles, because the original's zero refund creates new handles.
  - One fewer `ConfidentialTransfer` event per call (2 → 1). The zero-amount refund event goes away.
  - The ERC20 indicator (`balanceOf`) now moves. In the original, the refund undoes the indicator step, so after two `transferAndCall`s to EOAs the sender and recipient indicators show no change (7,984.0000). With D, they move like a normal transfer (sender 7,983.9998, recipient 7,984.0001).
  - The returned `transferred` handle is `sent`, which already has persistent access for sender, recipient and token. In the original, it is a new handle with transient access only.
- **The branch:** it is on public data (does `to` have code?), so it leaks nothing. The user asked if this branch is wanted. Security-wise it is safe; the event and indicator changes above are the real review points.
- **Code:** `src/variants/refundskip/` (D alone) and `src/variants/constants/*RefundSkip*` (D + A); test `test/Fherc20RefundSkipGas.t.sol`; evidence `results/fherc20-refundskip-evidence-*.json`.

### 7. Trivial handles as literals (protocol idea)

- **What:** a trivial handle carries its plaintext value. The TaskManager then skips the ACL check for trivial handles, and FHEOS builds the ciphertext on demand. No contract ever pays a task or an ACL entry for a constant.
- **Where:** TaskManager, ACL, FHEOS. Needs a security review: FHEOS must reject a handle that claims to be trivial but does not match its value.
- **Status:** Not tried.

### Note: 12-gas differences between chains

Some whole-transaction rows differ by 12 gas between Sepolia and Arbitrum Sepolia. The cause is the calldata: the input proof is signed over the chain id, so its bytes differ per chain, and a zero calldata byte costs 4 gas vs 16 for a non-zero byte. It is not an engine difference, and it is below the 100-gas rounding.

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

### U4. Global FHE constants registry (Haim, 2026-09-29)

- **What:** a one-time, per-chain setup creates a fixed set of constants (for example 0..49 for each type, plus `true` and `false`) and calls `allowGlobal` on each. FHE.sol then ships them as constants (`FHE.ZERO_EUINT64` and so on), and any contract uses them with no setup.
- **Where:** FHE.sol (the constant handles) + a one-time registrar per chain. No TaskManager change: `allowGlobal` exists today.
- **Status:** Measured for 0 and `true` (variant B in idea 5).
- **Result:**
  - One-time registrar for 2 constants: 119,241 gas (one transaction: 2 trivial encrypts + 2 `allowGlobal`), so about 49,000 per constant after the 21,000 base.
  - Per use: about 2,370 gas more than the allowThis path (A), and about 20,000 less than a new trivial encrypt.
  - For 0..49 of each of 7 types plus `true`/`false` (352 constants): about 17M gas once per chain (derived from the measured cost per constant).
- **Caveats:**
  - A global entry lets anyone use and decrypt the handle. That is fine: the value of a constant is public anyway.
  - The coprocessor must keep these ciphertexts for good.

### Combined target (derived, not measured)

| Version | Gas per transfer |
|---|---|
| Today (FHERC20, measured) | 421,500 |
| + zero cache (measured) | 401,000 |
| + constants A instead of the zero cache (measured) | 398,900 |
| + U1 fused or batch op | ~305,000 |
| + U2 permissions attached to the task | ~280,000 |
| + U3 ACL model change | ~235,000 or less |
| Plain ERC20 (measured) | 34,500 |
