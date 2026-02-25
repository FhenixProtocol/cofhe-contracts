# Changelog

## [Unreleased]

- Placeholder for future updates

## v0.1.0 - 2025-02-25

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
