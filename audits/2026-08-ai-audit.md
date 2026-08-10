# CoFHE Contracts — AI Security Audit

**Date:** 2026-08
**Commit:** cofhe-contracts `master` (see PR)
**Compiler:** solc 0.8.25, `viaIR`, optimizer 800, `cancun`, `bytecodeHash: none`
**Method:** AI-driven manual review. Every finding was independently re-checked before it was reported.

---

## Scope

In scope:

- `host-chain/contracts/TaskManager.sol` (+ `library TMCommon`) — core coprocessor entrypoint
- `host-chain/contracts/ACL.sol` — per-handle access control
- `host-chain/contracts/Permissioned.sol` — EIP-712 read permissions
- `host-chain/contracts/PlaintextsStorage.sol` — decrypt-result store
- `host-chain/contracts/ERC1967Proxy.sol` — local OZ proxy copy
- `registry-chain/contracts/commitment-registry/CommitmentRegistry.sol`
- `contracts/FHE.sol`, `contracts/ICofhe.sol` — dApp-facing library + interface

Out of scope: `detereministic-tm/` (frozen bootstrap copies — but findings apply to their live twins), `tests/`, and vendored/generated code.

Static-analysis baseline: CI already runs Slither on host-chain (`fail_on: medium`). registry-chain has none. This review sits on top of that.

---

## Summary

| ID | Severity | Contract | Title |
|---|---|---|---|
| H-1 | **High** | TaskManager | `verifyInput` signature is replayable and not bound to the caller |
| L-1 | Low | TaskManager | `handleDecryptResult` skips signatures and the kill switch |
| L-2 | Low | TaskManager | Signed messages omit `address(this)`; no nonce/expiry |
| L-3 | Low | TaskManager | Security-zone signed/unsigned mismatch in `verifyInput` |
| L-4 | Low | CommitmentRegistry | `getCommitment` ignores version status |
| L-5 | Low | CommitmentRegistry | `postCommitmentsSafe` silently skips a differing hash |
| L-6 | Low | CommitmentRegistry | `renounceOwnership()` can brick the registry |
| L-7 | Low | CommitmentRegistry | `getHandles` overflows on `offset + limit` |
| L-8 | Low | FHE.sol | Uninitialized `ebool` fails open to `true` |
| L-9 | Low | FHE.sol | Uninitialized handles are silently replaced with 0 |
| L-10 | Low | FHE.sol | `BindingsE*` miss ops that `FHE` exposes |
| L-11 | Low | FHE.sol | `wrapE*` re-tagging is unchecked |
| L-12 | Low | ICofhe.sol | `isAllowed` not `view` |

**Totals: 1 High, 12 Low, plus Informational.**

The one to prioritize is **H-1** — it can expose other users' encrypted inputs. Everything else is Low or informational.

This report documents findings only; it does not change the contracts.

---

## H-1 — `verifyInput` replay / caller not bound

**Severity:** High (impact: any user's encrypted input can be exposed)

**Where:** `TaskManager.sol` — `verifyInput` (~776), `extractSigner` (~826), grant at ~796; then `ACL.allowTransient` / `allowForDecryption`.

**The problem**

The verifier signature covers `(ctHash, utype, securityZone, sender, chainid)`.

It does **not** cover `msg.sender` (the calling contract). There is no nonce and no expiry.

But the ACL grant goes to `msg.sender`:

```solidity
acl.allowTransient(appendedHash, msg.sender, address(this)); // grantee = msg.sender
```

`verifyInput` is open to any caller by default (`accessListEnabled` defaults to false).

The victim's input blob and `sender` are public in calldata. The handle is derived deterministically from them.

**The attack**

1. Victim submits an encrypted input to some dApp.
2. Attacker replays the same `(input, sender)` from their own contract → gets the transient allowance on the identical handle.
3. Attacker calls `allowForDecryption(handle)` (persistent) → the decrypt network publishes the plaintext, readable by anyone.

No race needed — the tuple can be replayed later from historical calldata.

**Fix**

- Bind `msg.sender` into the signed message (or grant to the signed `sender`, not `msg.sender`).
- Add a per-`(ctHash, sender)` nonce and/or expiry.
- Interim: enabling the access list limits who can call `verifyInput`.

Same pattern exists in `detereministic-tm/DeterministicTM.sol`.

---

## Low findings

**L-1 — `handleDecryptResult` skips signatures and the kill switch**
Where: `TaskManager.sol:605-610`.
It is `onlyAggregator` but has no signature check, is not `onlyIfEnabled`, and overwrites results unconditionally — unlike `publishDecryptResult` (617-625).
So a bad aggregator can write/overwrite any plaintext, even while disabled.
Limited: only reached via result-processor (`app.ts:139`) when `ENABLE_TX_SENDER=true`; this path is being retired (Dispatcher gRPC).
Fix: remove it when TxSender is retired, or add `onlyIfEnabled` + signature.

**L-2 — Signed messages omit `address(this)`**
Where: `_computeDecryptResultHash` (729), `extractSigner` (826).
They include `chainid` but not the contract address, and have no nonce/expiry.
Two deployments sharing a signer would accept each other's signatures. Also the root enabler of H-1.
Fix: include `address(this)` (or use EIP-712, like `Permissioned`).

**L-3 — Security-zone signed/unsigned mismatch**
Where: `verifyInput` (777) vs `TMCommon`.
`verifyInput` treats the zone as 0-255; everywhere else it is a signed byte. Zones 128-255 diverge; negative zones can't be set via `verifyInput`.
Only affects deployments using zones outside 0-127. No cross-user impact.
Fix: use one signed interpretation.

**L-4 — `getCommitment` ignores version status**
Where: `CommitmentRegistry.sol:196-198`.
Status is checked on write but not on read, so a `Revoked` version's commitments are still returned. The README's flow reads without checking status.
The on-chain consumer doesn't exist yet, so impact is latent — but it grows once one ships.
Fix: check status on read (or add a checked variant) and fix the README.

**L-5 — `postCommitmentsSafe` silently skips a differing hash**
Where: `CommitmentRegistry.sol:146-152`.
It skips when a handle already has *any* value, not only an equal one. A conflicting hash is skipped silently (event shows counts only). Registry is write-once, so a wrong first write is permanent.
Capped by the trusted poster + deterministic outputs; worst case is a per-handle decrypt DoS.
Fix: on a mismatch, revert or emit a distinct conflict event.

**L-6 — `renounceOwnership()` can brick the registry**
Where: inherited (not overridden).
One call permanently disables upgrades, poster management, and revocation.
Fix: override `renounceOwnership()` to revert.

**L-7 — `getHandles` overflows on `offset + limit`**
Where: `CommitmentRegistry.sol:217`.
`limit = max uint` with any `offset > 0` panics instead of clamping. View-only.
Fix: `end = limit > total - offset ? total : offset + limit`.

**L-8 — Uninitialized `ebool` fails open to `true`**
Where: `and/or/xor/eq/ne` (FHE.sol ~972, ~1069, ~1166, ~1263, ~1376).
A zero-handle `ebool` becomes `true`, while `select`/`not` use `false`.
So `FHE.and(missingFlag, x)` collapses to `x` — the gate disappears. Needs a consumer bug to trigger.
Fix: default to `false` everywhere, or revert on uninitialized input.

**L-9 — Uninitialized handles silently replaced with 0**
Where: pattern across `library FHE` (e.g. `div` 646, `sub` 403).
A zero handle is swapped for `asEuintX(0)`, so `div(x, uninitialized)` is divide-by-zero, `sub(uninitialized, x)` wraps — plus a wasted encrypt. The "verifies inputs are initialized" comment is wrong.
Fix: revert on uninitialized input, or document the behavior.

**L-10 — `BindingsE*` miss ops that `FHE` exposes**
Where: bindings vs `library FHE`.
`div`/`rem` exist only for euint8/16/32; `mul`/`square` miss euint128 — yet the `FHE.*` versions compile and pass no support check.
If the engine can't do them, the `FHE.*` functions strand results; if it can, method syntax fails to compile.
Fix: make the two surfaces match.

**L-11 — `wrapE*` re-tagging is unchecked**
Where: `FHE.wrapEuintN` + TaskManager type checks.
A handle can be relabeled to another type; the return type isn't checked against the operand's type byte. Bounded by the ACL (only your own handles), so it's self-inflicted.
Fix: document `wrapE*` as unsafe; consider type validation in TaskManager.

**L-12 — `isAllowed` not `view`**
Where: `ICofhe.sol:104` (impl is `view` at `TaskManager.sol:818`).
`FHE.isAllowed` can't be used inside a consumer `view` function. Looks accidental.
Fix: add `view` in `ICofhe.sol` (ABI-compatible).

---

## Informational

**TaskManager / ACL**

- Owner is trusted and powerful: setting a signer to 0 disables signature checks ("debug mode"); the owner can also repoint ACL/storage, upgrade, and add aggregators. Worth documenting. Initial signers are `address(1)` (fail-closed) — good.
- Dead code: `ACL.delegateAccount` / `allowedOnBehalf` / `cleanTransientStorage` have no TaskManager caller — the delegation feature is inert. Wire it up or remove it.
- Small items: `uint8` loop counters can wrap; `setSecurityZones` misses a `min <= max` check; a `TMCommon` mask comment is off by one byte; `PlaintextsStorage` uses single-step `Ownable`; `_generateSeed` is on-chain-predictable (real randomness is off-chain).

**CommitmentRegistry**

- README is stale: documents `setPoster`/`getPoster` (the contract has a poster *set*), omits `postCommitmentsSafe`, and its version note doesn't match `deploy.ts`. Rewrite from the actual ABI (see L-4).
- `handle == 0` is accepted (zero *hashes* are rejected, zero *handles* are not).
- Events carry counts only — state can't be rebuilt from logs.
- A live QuickNode URL with an API key is committed in both `hardhat.config.ts` files — move to `.env` and rotate.
- `__Ownable2Step_init()` isn't called in `initialize` (harmless, but the convention).

**FHE.sol / ICofhe.sol**

- `TASK_MANAGER_ADDRESS` has a "CHANGE ME" TODO. This is by-design: the address is the deterministic CREATE2 proxy (same on every chain), and `updateTaskManagerAddress.ts` rewrites it on dev deploys ("in production the address is constant"). Residual is cosmetic — the stale TODO ships in the published package, and there's no CI check that the constant matches. Reword before the next publish; optional CI assert.
- Comparison ops pass the operand type (not `EBOOL`) as `returnType`; correct only because TaskManager overrides it. Passing `EBOOL` would be safer.
- Zone validation differs between the trivial-encrypt path and the random path.
- Batch overloads panic on length mismatch instead of a clean error.
- Dead code: unused `Strings` import, unused `InvalidHexCharacter`/`DEFAULT_VALUE`, orphaned `EUINT256_TFHE = 8`.
- `randomEuintX` natspec overstates unpredictability — the seed is public; entropy is off-chain.
- Worth documenting for integrators: no decrypt-request API; input proofs bind to `msg.sender` (routers break them); result handles are only transient (need `allowThis`); range checks are runtime-only; pragma floor is misleading; `allowPublic` == `allowGlobal`.

---

## Checked and found safe

- **ECDSA:** malleable `s` and `v` rejected; `address(0)` recovery rejected.
- **EIP-712 (Permissioned):** binds `chainId` + `verifyingContract`; expiry enforced; sealing key bound. No replay.
- **Handle packing (TMCommon):** metadata sits in the low 2 bytes; no overlap; no collisions without a keccak256 collision.
- **Upgrades:** `_disableInitializers()` in constructors, `initializer`-guarded init, `onlyOwner` `_authorizeUpgrade`, atomic proxy init. `ERC1967Proxy.sol` is a clean OZ v5.2 copy.
- **CommitmentRegistry:** ERC-7201 slot correct; mapping + array stay in sync; version transitions match spec; pagination clamps; no external calls.
- **FHE typed API:** UDVTs block implicit casts; each op pairs the right type constant; inputs bind `ctHash‖utype‖zone‖sender‖chainid`; bindings delegate correctly (except L-10).
- **ACL guards:** every `allow*` requires the TaskManager as caller and an already-allowed requester — you can't grant handles you don't control. (H-1 is upstream of this: it hands out the *first* transient allowance to an unauthenticated caller.)

---

## Follow-up

Track in Jira, linked from PRO-425:

- **H-1** — urgent. Bind the caller + add anti-replay. (Already tracked and in review.)
- **L-1** — remove the legacy `handleDecryptResult` path (`TaskManager.sol:605-610` + `result-processor/app.ts:139`) when TxSender is retired.
- Remaining Low / informational — batch into a hardening pass and a CommitmentRegistry README rewrite.
