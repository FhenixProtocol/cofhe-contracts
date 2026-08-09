# CoFHE Contracts — AI Security Audit

**Date:** 2026-08
**Commit:** cofhe-contracts `master` (see PR)
**Compiler:** solc 0.8.25, `viaIR`, optimizer runs 800, `evmVersion: cancun`, `metadata.bytecodeHash: none`
**Method:** AI-driven manual review with adversarial verification of each reported finding.

## Scope

| Contract | Role |
|---|---|
| `contracts/internal/host-chain/contracts/TaskManager.sol` (incl. `library TMCommon`) | Core coprocessor entrypoint |
| `contracts/internal/host-chain/contracts/ACL.sol` | Per-handle access control |
| `contracts/internal/host-chain/contracts/Permissioned.sol` | EIP-712 read permissions |
| `contracts/internal/host-chain/contracts/PlaintextsStorage.sol` | Decrypt-result store |
| `contracts/internal/host-chain/contracts/ERC1967Proxy.sol` | Local OZ proxy copy |
| `contracts/internal/registry-chain/contracts/commitment-registry/CommitmentRegistry.sol` | Commitment registry |
| `contracts/FHE.sol`, `contracts/ICofhe.sol` | dApp-facing library + interface |

**Out of scope:** `contracts/internal/host-chain/contracts/detereministic-tm/` (frozen bootstrap snapshots, deployed then upgraded away — but note the findings below apply to their live twins), `contracts/**/tests/`, and all vendored/generated code (`node_modules`, `artifacts`, `types`).

**Static-analysis baseline:** the existing CI (`.github/workflows/checks.yml`, `slither.config.json`, `fail_on: medium`) runs Slither on host-chain on every PR; registry-chain has no static-analysis job. This audit is a manual/AI review layered on top of that baseline, not a re-run of Slither.

## Summary of findings

| ID | Severity | Contract | Title |
|---|---|---|---|
| H-1 | **High** (Critical impact) | TaskManager | `verifyInput` signature is replayable and not bound to the consuming caller |
| M-1 | Low (revised from Medium) | TaskManager | `handleDecryptResult` bypasses signatures and the kill switch, and overwrites signed results |
| M-2 | Informational (revised from Medium) | FHE.sol | Hardcoded `TASK_MANAGER_ADDRESS` with a "CHANGE ME" banner; a stale value silently misroutes ops |
| L-1 | Low | TaskManager | Signed messages omit `address(this)`; no nonce/expiry |
| L-2 | Low | TaskManager | Security-zone signed/unsigned inconsistency in `verifyInput` |
| L-3 | Low | CommitmentRegistry | `getCommitment` ignores version status |
| L-4 | Low | CommitmentRegistry | `postCommitmentsSafe` silently skips a handle whose stored hash differs |
| L-5 | Low | CommitmentRegistry | `renounceOwnership()` can permanently brick the registry |
| L-6 | Low | CommitmentRegistry | `getHandles` reverts on `offset + limit` overflow |
| L-7 | Low | FHE.sol | Uninitialized `ebool` operands fail open to `true` in `and`/`or`/`xor`/`eq`/`ne` |
| L-8 | Low | FHE.sol | Ops silently substitute trivial-encrypted defaults for uninitialized handles |
| L-9 | Low | FHE.sol | `BindingsE*` omit ops that `library FHE` exposes (div/rem, euint128 mul/square) |
| L-10 | Low | FHE.sol | `wrapE*` re-tagging is unchecked against a handle's embedded type |
| L-11 | Low | ICofhe.sol | `isAllowed` declared non-`view`, unusable from consumer view functions |
| I-* | Informational | various | See the Informational section |

**Counts:** 1 High, 12 Low, plus Informational items. (The two items originally rated Medium — M-1 and M-2 — were revised down after reviewing their runtime usage; see the notes in each.)

The most impactful item is **H-1** (a confidentiality break of arbitrary users' encrypted inputs, verified end-to-end). Findings apply to the deployed contracts; per the engagement this report does not patch them — see the follow-up note at the end.

---

## H-1 — `verifyInput` signature is replayable and not bound to the consuming caller

**Severity:** High (impact is Critical: confidentiality break of arbitrary users' encrypted inputs)
**Location:** `TaskManager.sol` — `verifyInput` (~776-798), `extractSigner` (~826-843), the grant at ~796; downstream `allow`/`allowForDecryption` (~800-816), `ACL.sol` `allowTransient` (153-170), `allowForDecryption` (126-142), `isAllowed` (247-249).
**Status:** Confirmed by independent adversarial verification (all six links of the exploit chain traced against the code).

### Description

`extractSigner` verifies the verifier signer's ECDSA signature over:

```
keccak256(input.ctHash, input.utype, input.securityZone, sender, block.chainid)
```

The preimage binds `sender` (the account that created the encryption) but **not `msg.sender`** (the contract consuming the input), and there is no nonce or expiry. Yet the ACL grant is made to `msg.sender`:

```solidity
address signer = extractSigner(input, sender);
if (signer != verifierSigner) revert ...;
...
acl.allowTransient(appendedHash, msg.sender, address(this)); // grantee = msg.sender, unbound
```

`verifyInput` carries only `onlyAccessListed`, which short-circuits when `accessListEnabled` is `false` — and `accessListEnabled` is never set in `initialize`, so it defaults to `false`. In the default/expected production configuration `verifyInput` is callable by any address.

Because the victim's entire `EncryptedInput` blob and `sender` appear publicly in the victim's transaction calldata, an attacker can replay the identical `(input, sender)` tuple from their own contract. `appendedHash` is derived by the `pure` `TMCommon.appendMetadata` from public inputs, so the attacker manipulates the byte-for-byte-identical handle.

### Impact

The ACL is the sole authority over who may reencrypt/seal or decrypt a value. After replay the attacker is `isAllowed` (transiently) on the handle and can, in the same transaction:

- call `allowForDecryption(appendedHash)` → sets the **persistent** `allowedForDecryption` flag → the decrypt network publishes the plaintext, readable by anyone via `getDecryptResult`; and/or
- call `allow(appendedHash, attacker)` → persists ordinary access for later off-chain reencryption/sealing.

The on-chain ACL manipulation is unconditional under default config. Realized plaintext disclosure then follows from the off-chain threshold/reencryption network honoring the on-chain ACL — which is the system's designed behavior, not an added assumption. No front-running race is required: with no nonce/expiry and the ciphertext persisting off-chain, a tuple from historical calldata can be replayed at any later time.

### Exploit (concrete)

1. Victim calls `dApp.foo(inEuintX)`; `FHE.verifyInput` calls `TaskManager.verifyInput(input, victimEOA)`, publishing the signed blob and `sender`.
2. Attacker contract, in one transaction: (a) `verifyInput(victimInput, victimEOA)` → transient allow to attacker; (b) `allowForDecryption(appendedHash)` → persistent decrypt flag.
3. The decrypt network decrypts and `publishDecryptResult` stores the plaintext; attacker reads `getDecryptResult(appendedHash)`.

### Recommendation

Bind authorization to the consumer and add anti-replay:

- Include `msg.sender` (the consuming contract) in the signed preimage — mirroring FHEVM's `(userAddress, contractAddress)` binding — or grant to the signed `sender` rather than `msg.sender`, whichever matches the intended ownership model; the grantee must be cryptographically bound.
- Add a per-`(ctHash, sender)` nonce and/or an expiry to `EncryptedInput`.
- As an interim mitigation, enabling the access list restricts `verifyInput` to allowlisted contracts and materially reduces exposure, but does not fix the root cause.

The same pattern exists in `detereministic-tm/DeterministicTM.sol` and warrants the same fix.

---

## M-1 — `handleDecryptResult` bypasses signatures and the kill switch, and overwrites signed results

**Severity:** Low (revised down from Medium — see note)
**Location:** `TaskManager.sol` `handleDecryptResult` (~605-610) vs `publishDecryptResult` (~617-625); `PlaintextsStorage.storeResult` (24-31).
**Status:** Confirmed at the contract level.

> **Severity note (revised).** The on-chain result path is being sunset. `handleDecryptResult` is called from a single site — `src/services/result-processor/app.ts:139` (`sendDecryptResult`) — and is fully gated by `enableTxSender`: when `ENABLE_TX_SENDER=false` the TaskManager contract and wallet are never initialized (`app.ts:340,365`), so the path is unreachable. testnet-v2 already runs with it off, and decrypt-result consumers have moved to the Dispatcher gRPC (PRO-301). Real-world exposure is therefore limited to environments still running the legacy TxSender (e.g. devnet). The function remains on the deployed contract, so the finding stands at contract level; the recommendation shifts to **removing** `handleDecryptResult` once TxSender is fully retired (or gating + signing it if it must remain). Downgraded to Low.

### Description

`handleDecryptResult` is `onlyAggregator` and performs **no** signature verification (unlike `publishDecryptResult`), is **not** gated by `onlyIfEnabled`, and does not require `allowedForDecryption`. `storeResult` overwrites unconditionally.

### Impact

A single compromised or malicious aggregator (owner-granted via `addAggregator`) can write an arbitrary plaintext for **any** `ctHash` — forging or revealing the "decrypted" value of any ciphertext — including overwriting a previously published, signature-verified result, and can do so **even while the coprocessor is disabled** by the owner's kill switch during an incident. This defeats the threshold-signature verification that `publishDecryptResult` was built to enforce.

### Recommendation

Add `onlyIfEnabled`. If this path is still required alongside `publishDecryptResult`, route it through `_verifyDecryptResult` so results are signature-checked; otherwise remove it. At minimum, do not allow it to overwrite an already-stored signed result.

---

## M-2 — Hardcoded `TASK_MANAGER_ADDRESS` with a "CHANGE ME" banner

**Severity:** Informational (revised down from Medium — see note)
**Location:** `FHE.sol:25-31` (used at ~60 call sites), mirrored by `internal/host-chain/contracts/addresses/TaskManagerAddress.sol`.

> **Severity note (revised).** This is largely by-design. `internal/host-chain/utils/updateTaskManagerAddress.ts` rewrites the constant in both `FHE.sol` and `addresses/TaskManagerAddress.sol` during dev deploys and states "Only needed for development purposes, in production the address is constant." Combined with the deterministic CREATE2 proxy address (identical on every chain), the "CHANGE ME" banner is the dev-deploy hook, not a latent misconfiguration. The residual is cosmetic/process only: a stale TODO comment shipping in the published library, and the absence of a CI assertion that the constant equals the deterministic address. Downgraded to Informational.

### Description

`FHE.sol` hardcodes the coprocessor address under a `// TODO : CHANGE ME AFTER DEPLOYING` banner. The library is inlined into every consumer, so the address is frozen into dApp bytecode at compile time with no override (no immutable, no registry).

- **No contract at the address on a chain:** every FHE op reverts (loud — good).
- **Stale address (an outdated TaskManager at that address):** ops silently target the outdated contract — behavior drift with no on-chain error. This is the genuinely silent, dangerous case.
- **Impersonation on a new chain:** infeasible if deployment is deterministic CREATE2 (the address commits to proxy init code) — residual risk is process, not cryptography.

### Recommendation

Remove the TODO banner before publishing; document per-chain address guarantees; add a CI check that the constant matches the deterministic deployment address; consider an `isInitialized()`/version handshake helper integrators can call in their constructor to fail fast on a mis-targeted deployment.

---

## Low-severity findings

**L-1 — Signed messages omit `address(this)`; no nonce/expiry.** `TaskManager` `_computeDecryptResultHash` (729-757) and `extractSigner` (826-843) include `block.chainid` (cross-chain replay prevented) but not the contract address. Two deployments on the same chain sharing a signer would accept each other's signatures. This missing binding is also the enabling weakness behind H-1. *Fix:* include `address(this)` (or use EIP-712 domain separation as `Permissioned` already does) in both signed messages.

**L-2 — Security-zone signed/unsigned inconsistency.** `verifyInput` (777) validates `input.securityZone` as a non-negative `int32` (0-255), but zones are stored/read as a signed byte everywhere else (`TMCommon.appendMetadata`/`getSecurityZoneFromHash`). For zones ≤127 they agree; 128-255 diverge, and negative zones cannot be expressed via `verifyInput`. Self-inflicted inconsistency for deployments using zones outside 0-127; no cross-user impact. *Fix:* use one consistent signed interpretation.

**L-3 — `CommitmentRegistry.getCommitment` ignores version status.** Status (`Active`/`Deprecated`/`Revoked`) is enforced on write (97, 135) but `getCommitment` (196-198) returns the stored hash unconditionally, including for revoked versions; the README's documented consumer flow calls only `getCommitment`. A consumer following the README would trust emergency-revoked commitments. Rated Low because the on-chain threshold-network reader that would rely on this does not exist in the repo yet — it rises to Medium the moment such a consumer ships. *Fix:* enforce status in the read path (or add a `getCommitmentChecked`/return-status variant) and correct the README.

**L-4 — `postCommitmentsSafe` silently skips a differing stored hash.** The skip condition is only `versionMap[handle] == bytes32(0)` (146-152); a handle already committed with a *different* hash is skipped and the event emits counts only, so a benign redelivery and a real conflict are indistinguishable. This is the function the production poster uses, and the registry is write-once (no correction path). Impact is capped by the trusted-poster role, deterministic FHE outputs, and downstream self-detection (`keccak256(ct) != commitHash`) — worst case is a permanent per-handle decrypt DoS, not acceptance of bad data. *Fix:* on a mismatched existing hash, revert (or emit a distinct conflict event) instead of collapsing it into the skip count.

**L-5 — `renounceOwnership()` can permanently brick the registry.** `Ownable2StepUpgradeable` protects `transferOwnership` but not `renounceOwnership`; one call permanently disables upgrades, poster management, and version revocation. *Fix:* override `renounceOwnership()` to revert.

**L-6 — `getHandles` reverts on `offset + limit` overflow.** Line 217 does checked `offset + limit`; a common `limit = type(uint256).max` "fetch everything" idiom panics for any `offset > 0`. View-only. *Fix:* clamp before adding: `end = limit > total - offset ? total : offset + limit`.

**L-7 — Uninitialized `ebool` operands fail open to `true`.** In `and`/`or`/`xor`/`eq`/`ne` (FHE.sol ~972, ~1069, ~1166, ~1263, ~1376) a zero-handle `ebool` is substituted with `asEbool(true)`, while `select`'s control and `not` (~2121, ~2259) default to `false`. `FHE.and(missingConsent, other)` collapses to `other` — the gate silently vanishes. Requires a consumer-side bug to bite. *Fix:* default uninitialized `ebool` to `false` everywhere, or revert on uninitialized operands.

**L-8 — Silent trivial-encrypt substitution for uninitialized handles.** Every op replaces a zero handle with `asEuintX(0)`/`asEaddress(0)`/`asEbool(...)`, so e.g. `div(x, uninitialized)` becomes an encrypted division by zero and `sub(uninitialized, x)` wraps — plus an unrequested `trivialEncrypt` cost. The "Verifies that inputs are initialized" natspec is misleading. *Fix:* revert on uninitialized operands or clearly document the substitution semantics.

**L-9 — `BindingsE*` omit ops that `library FHE` exposes.** `div`/`rem` bindings exist for euint8/16/32 only; `mul`/`square` for euint8/16/32/64 but not euint128 — yet `FHE.div/rem(euint64/128)` and `FHE.mul/square(euint128)` compile and `createTask` performs no per-width support check. If these are engine-unsupported, the library functions are the bug (they succeed on-chain but never materialize a result, stranding dependent ops); if it's a generator oversight, method-syntax users get spurious compile errors. *Fix:* make the two surfaces agree.

**L-10 — `wrapE*` re-tagging is unchecked.** `FHE.wrapEuintN(bytes32)` performs no validation, and TaskManager never compares an operand's embedded type byte against the caller-supplied `returnType` (nor validates unary-op operand types), so a consumer can mint a mislabeled result handle. Constrained by the ACL (you can only do this to handles you already control), so impact is self-inflicted breakage. *Fix:* document `wrapE*`/`unwrap` as unsafe reinterpretation; consider TaskManager-side type validation.

**L-11 — `ICofhe.isAllowed` declared non-`view`.** The implementation (`TaskManager.sol:818`) is `view`, but the interface (`ICofhe.sol:104`) is not, so `FHE.isAllowed` cannot be called from a consumer's `view`/`staticcall` function; `isPubliclyAllowed` is correctly `view`, so this looks accidental. ABI-compatible fix: add `view` to `isAllowed` in `ICofhe.sol`.

---

## Informational

**TaskManager / ACL / host-chain**
- **Owner centralization.** `setVerifierSigner(0)` / `setDecryptResultSigner(0)` switch the contract into a "debug mode" where signature verification is skipped entirely; the owner can also repoint `acl`/`plaintextsStorage`, upgrade, and add aggregators. Standard trusted-owner assumptions, worth documenting. Initial signer values are `address(1)` (fail-closed) — good.
- **Dead delegation code.** `ACL.delegateAccount`/`allowedOnBehalf`/`cleanTransientStorage` require the caller to be the TaskManager, but TaskManager exposes no wrapper forwarding to them — the delegation feature is inert (and, if wired, would record the delegator as the TaskManager, a logic bug). Either wire them through or remove them.
- **Minor robustness:** `uint8` loop counters can wrap for >255 elements (only the aggregator-controlled `handleDecryptResult` requestors loop is uncapped → self-revert); `setSecurityZones` lacks a `min <= max` check; the `TMCommon` metadata-mask comment says 29 hash bytes but the mask keeps 30; `PlaintextsStorage` uses single-step `Ownable`; `_generateSeed` is on-chain-predictable (true randomness enforced off-chain — worth a comment); `returnType` is caller-supplied and only range-checked.

**CommitmentRegistry**
- **README stale/inconsistent** (confirmed): documents a single-poster `setPoster`/`getPoster` model though the contract implements a poster set (`addPoster`/`removePoster`/`isPoster`); `postCommitmentsSafe` (the function the production poster uses) is undocumented; version-derivation description doesn't match `scripts/deploy.ts`; a line is duplicated; SPDX says `BSD-3-Clause-Clear` while `package.json` says `MIT`. Given L-3, the stale flow is the spec a future reader will build from. Rewrite from the actual ABI and add the mandatory status check.
- `handle == bytes32(0)` is accepted as a valid handle (zero *hashes* are rejected, zero *handles* are not) — a poster bug worth rejecting symmetrically.
- Events carry counts only, not handles/hashes — on-chain state is not reconstructible from logs (forensics gap; deliberate gas tradeoff).
- A live QuickNode RPC URL with an embedded API key is committed in `registry-chain/hardhat.config.ts` (and host-chain) — move to `.env` and rotate.
- `__Ownable2Step_init()` is not called in `initialize` (harmless no-op in OZ 5.2.0, but the documented convention).

**FHE.sol / ICofhe.sol**
- Comparison ops pass the operand type (not `EBOOL`) as `returnType`; correctness relies on `TMCommon.getReturnType` overriding it to ebool. Passing `EBOOL_TFHE` from the library would be strictly more robust and self-documenting.
- Security-zone validation is inconsistent (trivial-encrypt path rejects negative zones; random path forwards them).
- Typed batch overloads panic (array OOB) on a length mismatch instead of surfacing `LengthMismatch`.
- Dead code: unused `Strings` import, unthrown `Common.InvalidHexCharacter`, unread `Common.DEFAULT_VALUE`, and the orphaned `Utils.EUINT256_TFHE = 8` (no `euint256` type exists) which invites misuse.
- `randomEuintX` natspec claims the value "cannot be predicted by any party," but the seed is public and block-derived; unpredictability rests entirely on off-chain engine entropy. State the actual trust assumption.
- Integrator-surprise items worth documenting: no decryption-request API (`getDecryptResult` reverts until an off-chain publish); input proofs bind to the immediate `msg.sender` (routers/multicall break valid proofs); result handles are only transiently allowed (persist requires `allowThis`); plaintext range checks are runtime-only; `FHE.sol` pragma floor is misleading (`>=0.8.19` but imports `>=0.8.25`); `allowPublic` is a pure alias of `allowGlobal`.

---

## Audited and found safe (selected)

- **ECDSA:** OZ v5.1 `recover`/`tryRecover` reject malleable upper-half `s` and enforce `v ∈ {27,28}`; both signed paths also explicitly reject `address(0)` recovery. No malleability/zero-address issue.
- **EIP-712 (Permissioned):** domain binds `chainId` and `verifyingContract`; `expiration` enforced; shared-permit recipient signature binds the sealing key — cross-chain/cross-contract permission replay prevented.
- **Handle packing (`TMCommon`):** metadata occupies exactly the low 2 bytes with no overlap with the retained hash bytes; distinct `(type, trivial, zone)` cannot collide; cross-op collisions require a keccak256 collision.
- **Upgradeability:** all upgradeable contracts call `_disableInitializers()` in the constructor, guard `initialize` with `initializer`, and gate `_authorizeUpgrade` with `onlyOwner`; proxies initialize atomically in the constructor (no init front-run). `ERC1967Proxy.sol` is an unmodified OZ v5.2 copy.
- **CommitmentRegistry:** ERC-7201 slot recomputed and correct; write-once mapping and `handlesByVersion` array are written together and cannot desync; version transition whitelist matches spec (no resurrection); pagination clamps and cannot DoS writes; no external calls (no reentrancy).
- **FHE typed API:** UDVTs prevent implicit conversion; every `FHE.*` overload pairs the operand UDVT with the matching type constant; encrypted-input paths force the correct `utype` and the verifier signature binds `ctHash‖utype‖zone‖sender‖chainid`; `BindingsE*` are pure one-line delegations with correct arguments (only the L-9 omissions deviate).
- **ACL direct-call guards:** all `allow*`/delegation entrypoints require the caller to be the TaskManager, and `allow*` additionally require the requester already be allowed — callers cannot grant handles they don't control (the H-1 break is that `verifyInput` grants the *initial* transient allowance to an unauthenticated caller, upstream of these guards).

---

## Follow-up

Per the engagement, this PR records findings only and does not modify the contracts. Recommended follow-up (track in Jira, linked from PRO-425):

- **H-1** — urgent; a confidentiality break on deployed TaskManager instances. Prioritize the caller-binding + anti-replay fix. (Already tracked as an in-progress ticket in the team's backlog.)
- **M-1** (Low) — remove the legacy `handleDecryptResult` path once TxSender is fully retired.
- **M-2** (Informational) — clear the stale TODO banner; optionally add a CI assertion that the constant matches the deterministic address.
- Low/Informational — batch into contract-hardening and a CommitmentRegistry README rewrite.
