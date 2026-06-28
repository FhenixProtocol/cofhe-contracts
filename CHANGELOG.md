# Changelog

## [Unreleased]

### Added
- **TaskManager access list** — optional, owner-controlled allowlist that gates task intake (`createTask`, `createRandomTask`, `verifyInput`) to approved callers. Off by default, so behavior is unchanged on upgrade; the owner turns it on with `enableAccessList()` / off with `disableAccessList()`, and manages members via batch `addToAccessList` / `removeFromAccessList`. Intended for controlled early-mainnet rollout. ACL `allow*` and decrypt-result publishing are intentionally not gated (ACL is reachable only through gated intake, and decrypt publishing is signature-gated). New storage is appended (the toggle packs into an existing slot, the mapping takes the next), keeping UUPS upgrades storage-layout-compatible.

### Fixed
- `Utils.inputFromHashAndProof` no longer hardcodes `securityZone: 0`. A new 4-argument overload accepts an explicit `securityZone`, bringing it in line with the other `inputFrom*` helpers. The original 3-argument signature is kept as a backward-compatible wrapper defaulting to zone `0`. Fixes `verifyInput` failures when building an `EncryptedInput` from a hash and proof for a ciphertext on a non-zero security zone.

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
