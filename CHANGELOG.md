# Changelog

## [Unreleased]

### Added
- **`sharedEuint*` — typed, single-use, transaction-scoped hand-off of an encrypted handle between contracts.** Seven new value types (`sharedEbool`, `sharedEuint8`–`sharedEuint128`, `sharedEaddress`) plus `FHE.shareX(handle, receiver)` and two claim functions per type: `receiveXParam(shared)` when the handle arrived as a function argument (sharer must be `msg.sender`) and `receiveXFromCall(shared, callee)` when it arrived as the return value of a call this contract made (`callee` MUST be the address called in the same expression). This replaces the hand-rolled `allowTransient` + bare `bytes32` pattern with something that carries the type distinction and proves *who* handed the value over. Backed by a directed share slot `(handle, receiver) -> sharer` built entirely from EIP-1153 transient storage: `ACL.shareCtHash` grants the receiver a transient allowance and records the sharer; `ACL.receiveCtHash` reads the slot, clears it, and requires the recorded sharer to match the one the receiver named (a closing custody re-check on the sharer is kept as defense-in-depth, though it is unreachable today). Share slots ride the same tracked-write path as transient allowances, so `cleanTransientStorage()` clears both together — which is what lets `receiveCtHash` skip re-checking the receiver's own grant. Directed (nobody else can claim), single-use (cleared on claim; a reverting claim rolls the clear back), and transaction-scoped (no cross-transaction replay). `TaskManager.shareCtHash` / `receiveCtHash` are thin passthroughs that inject `msg.sender` as sharer and receiver respectively, and — like `allow`/`allowGlobal`/`allowTransient` — are deliberately not gated by the task-intake access list. **No persistent storage changes in either contract**, so the ACL/TaskManager upgrade needs no storage gap; deploying requires upgrading both, since `TaskManager` calls the new ACL functions.
- **`InputVerified` event** — `TaskManager.batchVerifyInputs` emits `InputVerified(uint256 indexed ctHash, bytes32 commitment)` once per verified input, in input order: the appended handle plus the raw verifier-signature-checked `ctHash` (`keccak256` of the ciphertext bytes) as the commitment; the security zone is bound by the handle's last byte, not the value. Off-chain services relay the commitment verbatim to the CommitmentRegistry so the TEE decryptor can verify user inputs before decrypting. Emitted in debug mode (`verifierSigner == address(0)`) too, so local stacks exercise the flow. Adds ~1.5k gas per input (event emission only). The event's shape is deliberately unchanged from the single-input flow rather than becoming an array-valued batch event, so consumers that hard-code `InputVerified(uint256,bytes32)` read a batch as N independent verified inputs and need no batch-aware decoding.
- **TaskManager access list** — optional, owner-controlled allowlist that gates task intake (`createTask`, `createRandomTask`, `verifyInput`) to approved callers. Off by default, so behavior is unchanged on upgrade; the owner turns it on with `enableAccessList()` / off with `disableAccessList()`, and manages members via batch `addToAccessList` / `removeFromAccessList`. Intended for controlled early-mainnet rollout. ACL `allow*` and decrypt-result publishing are intentionally not gated (ACL is reachable only through gated intake, and decrypt publishing is signature-gated). New storage is appended (the toggle packs into an existing slot, the mapping takes the next), keeping UUPS upgrades storage-layout-compatible.
- **Batch input verification** — `FHE.asEbools`, `asEuint8s`/`16s`/`32s`/`64s`/`128s`, and `asEaddresses` verify a batch of encrypted inputs with a single verifier signature (over the concatenated per-input hashes) and return the verified encrypted values in input order. Each takes an array of `external*` ciphertext handles (e.g. `externalEuint8[]`) plus one `signature`; a `bytes[]` overload accepts ABI-encoded `(ctHash, securityZone, utype)` inputs. `securityZone` is `0` and the per-input type is implied by the function, matching the single-input `external*` overloads. `verifyInput`'s ABI is unchanged, so existing integrations keep working. Deploying this requires upgrading **both** TaskManager and ACL, since `TaskManager.batchVerifyInputs` calls the new `ACL.batchAllowTransient` (batch form of `allowTransient`, one call per batch instead of one per handle); no new storage in either contract.

### Changed
- **BREAKING — `TaskManager.verifyInput` is removed; `batchVerifyInputs` is the only input-verification entry point.** The verifier no longer issues per-input signatures (its `POST /verify` endpoint is gone), so the single-input endpoint had no way to be satisfied. The `bytes` and `external*` overloads of `FHE.asEbool`/`asEuint*`/`asEaddress` still exist and keep their signatures — internally each now submits a batch of one, so the proof they take must be the batch digest `keccak256(h_0)` rather than `h_0` itself. `EncryptedInput` and the `Utils.inputFromBytes` / `inputFromHashAndProof` helpers are unchanged. `verifyInput` is also dropped from the `ITaskManager` interface, so any contract calling `TaskManager.verifyInput` directly must move to `batchVerifyInputs`. `DeterministicTM` still exposes only the old `verifyInput` and has no `batchVerifyInputs`, so it can no longer back input verification through `FHE.sol`.
- **BREAKING — the `InEbool` / `InEuint8`–`InEuint128` / `InEaddress` structs are removed**, along with the `FHE.asEbool(InEbool)`, `asEuint*(InEuint*)` and `asEaddress(InEaddress)` overloads and the `Utils.inputFromEbool` / `inputFromEuint*` / `inputFromEaddress` helpers that only existed to convert them. They were a third spelling of the same `(ctHash, securityZone, utype, signature)` tuple already covered by the `bytes` overload (`Utils.inputFromBytes`) and the `external*` handle + proof overload. Contracts taking an `InEuint64 memory` parameter must switch to `externalEuint64` + a `bytes` proof (preferred) or to the ABI-encoded `bytes` overload; note that `external*` overloads pin `securityZone` to `0`, so a non-zero zone needs the `bytes` form or `Utils.inputFromHashAndProof(hash, proof, utype, securityZone)`. `EncryptedInput` and `UnsignedEncryptedInput` are unaffected.
- **BREAKING — input verification now binds the consuming contract.** `TaskManager.extractBatchSigner` folds the calling contract (`msg.sender`) into the verifier-signed message, so an encrypted input is only accepted by the contract it was signed for. Previously the signature covered only `(ctHash, utype, securityZone, sender, chainId)`, so a signed input observed on-chain could be replayed into any other contract, which then obtained an ACL allowance over the ciphertext. The signed message is now `keccak256(abi.encodePacked(ctHash, utype, securityZone, sender, chainId, contractAddress))`. Requires a lock-step verifier upgrade that appends the contract address to the signed message in the same byte order; inputs signed by an old verifier will no longer verify. Debug mode (`verifierSigner == address(0)`) is unaffected.

### Fixed
- **`createRandomTask` now derives the handle with `TMCommon.calcPlaceholderKey`** instead of using the caller-supplied seed directly, so random matches every other task path. The preimage is `[seed, msg.sender]`; the sender is included so the same seed from different callers yields different handles, while a repeated `(seed, caller)` pair still yields the same handle. `TaskCreated.input3`, previously always `0` for random, now carries the caller. `seed == 0` is unchanged and still routes through `_generateSeed`, so `FHE.randomEuintNN()` behaves as before. No storage layout change. **Breaking:** the handle no longer equals the emitted seed, so fheos must be deployed in the same window and there is no partial rollback. **Deployment Requirement:** UUPS upgrade of TaskManager in every environment.
- `createRandomTask` now respects the `isEnabled` kill-switch (`onlyIfEnabled`). Previously it emitted `TaskCreated` and granted ACL access even while the TaskManager was disabled, so the coprocessor still received random-generation intake during a halt. It now reverts with `CofheIsUnavailable` when disabled, consistent with `createTask` and decrypt-result publishing. Also corrected the `isEnabled` comment, which claimed all operations revert when disabled.
- `Utils.inputFromHashAndProof` no longer hardcodes `securityZone: 0`. A new 4-argument overload accepts an explicit `securityZone`, bringing it in line with the other `inputFrom*` helpers. The original 3-argument signature is kept as a backward-compatible wrapper defaulting to zone `0`. Fixes `verifyInput` failures when building an `EncryptedInput` from a hash and proof for a ciphertext on a non-zero security zone.
- **TaskManager** — `createTask` now rejects `FunctionId.decrypt` with `DecryptFunctionNotSupported`. On-chain decrypt was removed (#63), but the generic `createTask` still accepted `funcId == decrypt` and emitted decrypt tasks with a derived (never-stored) ctHash that the coprocessor could not resolve, stranding them. Decryption is off-chain; the signed result is published via `publishDecryptResult`.

## v0.1.4 - 2026-06-01

### Added
- **CommitmentRegistry** — UUPS-upgradeable contract for on-chain FHE computation commitments (`handle → commitHash`) grouped by state version. Threshold Network uses these to verify ciphertext integrity before decrypting. Includes version lifecycle state machine, write-once enforcement, batch posting, array-based enumeration with paginated cursor, and Arbitrum gas estimation script.

### Changed
- **External Inputs API** - External inputs are represented with named types

## v0.1.3 - 2026-03-25

### Changed
- Rename `FHE.asEbool(bytes32)`, `FHE.asEuint*(bytes32)`, `FHE.asEaddress(bytes32)` to `FHE.wrapEbool(bytes32)`, `FHE.wrapEuint*(bytes32)`, `FHE.wrapEaddress(bytes32)` to avoid overload ambiguity with `asEuintX(0)` calls and clarify intent

### Fixed
- CI now compiles against local `cofhe-contracts` source instead of stale npm version, closing a gap where FHE.sol compilation errors were not caught
- Update internal test contracts to match current FHE.sol API (remove `euint256`, `FHE.decrypt`, fix `bytes32` return types)

## v0.1.2 - 2026-03-25 - DEPRECATED

### Added
- `FHE.isInitialized()` overloads for all encrypted types (`ebool`, `euint8`, `euint16`, `euint32`, `euint64`, `euint128`, `eaddress`) to check whether a ciphertext handle is initialized
- `FHE.unwrap()` overloads for all encrypted types to extract the underlying `bytes32` handle
- `FHE.asEbool(bytes32)`, `FHE.asEuint*(bytes32)`, `FHE.asEaddress(bytes32)` to wrap a raw `bytes32` handle into the corresponding encrypted type
- Bindings for `isInitialized()` and `unwrap()` on all encrypted types, enabling instance-style calls (e.g. `myEuint32.isInitialized()`, `myEuint32.unwrap()`)
- Add `verifyDecryptResultBatch` and `verifyDecryptResultBatchSafe` to TaskManager (view functions for batch signature verification)
- Add typed overloads for `publishDecryptResultBatch`, `verifyDecryptResultBatch`, and `verifyDecryptResultBatchSafe` in FHE.sol (per encrypted type: ebool, euint8-128, eaddress)
- Update ITaskManager interface with new batch verify functions

## v0.1.1 - 2026-03-16

- Remove decryption endpoints 

## v0.1.0 - 2026-02-25

### Breaking Changes
- **Ciphertext handle type change (`uint256` → `bytes32`)**: All encrypted types (`ebool`, `euint8`, `euint16`, `euint32`, `euint64`, `euint128`, `eaddress`) now use `bytes32` as their underlying type instead of `uint256`. This changes the ABI encoding of any function that accepts or returns encrypted types.

### Migration Guide

The `uint256` → `bytes32` type change affects the **compiled ABI** of any contract that exposes encrypted types in its public/external interface. Even if your Solidity code compiles without errors (because the wrapped `euintX` types hide the change), **any off-chain code that interacts with these contracts will break** if it uses stale ABIs or generated types.

#### What breaks

| Scenario | Symptom | Fix |
|----------|---------|-----|
| Contract returns `euint64` (e.g. a getter) | ABI now encodes the return as `bytes32` instead of `uint256`. Off-chain calls decode the wrong type and return garbage or revert. | Regenerate ABIs and types (see below) |
| Contract uses `.unwrap()` on encrypted types | `euint64.unwrap(x)` now returns `bytes32` instead of `uint256`. Solidity compilation fails. | Change `uint256 raw = euint64.unwrap(x)` → `bytes32 raw = euint64.unwrap(x)`. Cast explicitly if you need a `uint256`: `uint256(euint64.unwrap(x))`. |
| Stored/cached ABI JSON files | Stale ABIs still list `uint256` for encrypted type parameters and return values. Calls will silently encode/decode incorrectly. | Re-compile contracts and re-export ABIs. |

### Added
- Support for converting a byte array into a ciphertext. The byte array must be formatted as follows:

  ```solidity
  uint256 ctHash = 123456;
  uint8 securityZone = 0;
  uint8 utype = 4; // euint32
  bytes memory signature = hex"deadbeefcafebabe";

  // --- encode into bytes ---
  bytes memory encoded_lhs = abi.encode(
      ctHash,
      securityZone,
      utype,
      signature
  );
  ```
- `isPubliclyAllowed(uint256 ctHash)` view function on `TaskManager` to query whether a ciphertext handle has been publicly allowed (via `allowGlobal` / `allowPublic`). Delegates to `acl.globalAllowed()`.
- `FHE.isPubliclyAllowed()` typed overloads for all encrypted types (`ebool`, `euint8`, ..., `eaddress`) so contracts can query public-allow status directly via the FHE library.
- `publishDecryptResult()` and `publishDecryptResultBatch()` on TaskManager for publishing signed decrypt results on-chain
- `verifyDecryptResult()` (reverts on invalid) and `verifyDecryptResultSafe()` (returns false) for signature verification without publishing
- `decryptResultSigner` state variable and `setDecryptResultSigner()` admin function
- Typed overloads in `FHE.sol` for all encrypted types (`ebool`, `euint8`, ..., `eaddress`)
- `onlyIfEnabled` modifier on publish functions
- `LengthMismatch` custom error replacing require string in batch publish
