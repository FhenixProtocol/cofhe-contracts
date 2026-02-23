# Changelog

## [Unreleased]

### Added
- `isPubliclyAllowed(uint256 ctHash)` and `isGloballyAllowed(uint256 ctHash)` view functions on `ITaskManager` / `TaskManager` to query whether a ciphertext handle has been globally allowed (via `allowGlobal` / `allowPublic`). Both are aliases that delegate to `acl.globalAllowed()`.

## v0.1.0

### Breaking Changes
- All ciphertext handles are now represented as `bytes32` instead of `uint256`. This doesn't affect contracts that operate on ciphertexts via `FHE.op` functions, since those functions return the wrapped types. It does affect contracts that for some reason do `euintx.unwrap`. The `FHE.op` functions still receive `euintx` inputs, but their underlying types have changed.

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
