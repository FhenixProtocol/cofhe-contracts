# Changelog

## [Unreleased]

### Added
- **TaskManager access list** — optional allowlist that gates task intake (`createTask`, `createRandomTask`, `verifyInput`) to approved callers. Off by default, so behavior is unchanged on upgrade; a holder of `ACCESS_LIST_MANAGER_ROLE` turns it on with `enableAccessList()` / off with `disableAccessList()`, and manages members via batch `addToAccessList` / `removeFromAccessList`. Intended for controlled early-mainnet rollout. ACL `allow*` and decrypt-result publishing are intentionally not gated (ACL is reachable only through gated intake, and decrypt publishing is signature-gated). New storage is appended (the toggle packs into an existing slot, the mapping takes the next), keeping UUPS upgrades storage-layout-compatible.

### Changed
- **Role-based access control** (BREAKING) — `TaskManager`, `ACL`, `PlaintextsStorage`, and `CommitmentRegistry` move from `Ownable`/`Ownable2Step` to `AccessControlDefaultAdminRules`. Each previously `onlyOwner` entry point is now bound to a capability role: TaskManager splits into `UPGRADER_ROLE`, `PAUSER_ROLE`, `SECURITY_ZONE_MANAGER_ROLE`, `ACCESS_LIST_MANAGER_ROLE`, `VERIFIER_SIGNER_MANAGER_ROLE`, `DECRYPT_SIGNER_MANAGER_ROLE`, and `CONFIG_MANAGER_ROLE`; ACL and PlaintextsStorage expose `UPGRADER_ROLE`; CommitmentRegistry exposes `UPGRADER_ROLE`, `POSTER_MANAGER_ROLE`, and `VERSION_MANAGER_ROLE`.

  Blast radius: splitting `onlyOwner` limits who has to hold each key, not what each key can do. Four TaskManager roles are admin-equivalent and must sit on the same governance as `DEFAULT_ADMIN_ROLE`, never on an operational hot key: `UPGRADER_ROLE` (arbitrary implementation), `CONFIG_MANAGER_ROLE` (repoints `acl` for unrestricted ciphertext access, or `plaintextsStorage` for arbitrary plaintext — no upgrade needed), `VERIFIER_SIGNER_MANAGER_ROLE` (forges encrypted inputs) and `DECRYPT_SIGNER_MANAGER_ROLE` (forges decrypt results). Only `PAUSER_ROLE`, `SECURITY_ZONE_MANAGER_ROLE` and `ACCESS_LIST_MANAGER_ROLE` are genuinely narrow — their worst case is availability, not disclosure.

  Deployment notes: `initialize` signatures changed — `TaskManager`/`ACL`/`PlaintextsStorage` take `(address initialAdmin, uint48 initialDelay)` and `CommitmentRegistry` takes `(address initialAdmin, uint48 initialDelay, address initialPoster)`. `initialize` grants only `DEFAULT_ADMIN_ROLE`, so deployments must explicitly grant the operational roles — including `UPGRADER_ROLE`, without which the proxy cannot be upgraded again. `owner()` is retained for ABI compatibility: `AccessControlDefaultAdminRules` implements ERC-5313, so `owner()` now returns `defaultAdmin()`. `transferOwnership`/`acceptOwnership` are replaced by `beginDefaultAdminTransfer`/`acceptDefaultAdminTransfer`. The host-chain deploy script requires `TM_ADMIN_ADDRESS` and `TM_ADMIN_DELAY` on any non-local network, and the registry-chain script requires `POSTER_ADDRESS`, rather than falling back to keys committed to this repository.

  Migration: proxies already deployed on the `Ownable` implementation have no AccessControl storage. `initializeV2(address initialAdmin, uint48 initialDelay)` seeds it — argument order matches `initialize`, and it also grants the operational roles to `initialAdmin` (not just `DEFAULT_ADMIN_ROLE`), so a migration driven by a Safe or a manual `cast send` with no follow-up script cannot leave the proxy without an `UPGRADER_ROLE` holder and therefore permanently un-upgradeable; revoke afterwards to re-establish separation. It cannot be `onlyRole`-gated — it runs precisely when no role holder exists yet — so it is gated on the owner recorded in the abandoned `openzeppelin.storage.Ownable` namespace, which is the same account the old `_authorizeUpgrade` required. Passing it as the `data` argument of `upgradeToAndCall` is still recommended so the proxy is never observable half-migrated, but the safety no longer depends on it: a bare `upgradeTo` from a Safe or `cast send` leaves a window in which `reinitializer(2)` passes and `defaultAdmin()` is zero, and only the legacy owner can close it. `TaskManager`, `ACL`, `PlaintextsStorage` and `CommitmentRegistry` all retain the `openzeppelin.storage.Ownable` (and, where they inherited `Ownable2Step`, `Ownable2Step`) ERC-7201 namespaces as struct declarations, so the orphaned owner data stays reserved and cannot be reused by a later upgrade.
- **Aggregator allowlist removed** — `addAggregator`, `removeAggregator`, `handleDecryptResult` and `handleError` are gone, along with `AGGREGATOR_MANAGER_ROLE` and the `onlyAggregator` modifier. `handleDecryptResult` wrote plaintext for any `ctHash` with no signature check at all, so an aggregator entry (or the role that could add one) was arbitrary-plaintext-for-any-handle. Decrypt results are now published only through the signature-checked `publishDecryptResult` / `publishDecryptResultBatch`, which need no allowlist. The mapping itself is kept as deprecated storage so its slot stays reserved, renamed to `_aggregators` — same slot, same type, so the layout is still upgrade-compatible, but the public getter is now `_aggregators(address)` instead of `aggregators(address)`. `storage-layout-snapshot.json` is re-baselined in this PR to record the rename (and, separately, to start tracking the new `AccessControl` / `AccessControlDefaultAdminRules` namespaces).
- **`InputVerified` event** — `TaskManager.verifyInput` now emits `InputVerified(uint256 indexed ctHash, bytes32 commitment)`: the appended handle plus the raw verifier-signature-checked `ctHash` (`keccak256` of the ciphertext bytes) as the commitment; the security zone is bound by the handle's last byte, not the value. Off-chain services relay the commitment verbatim to the CommitmentRegistry so the TEE decryptor can verify user inputs before decrypting. Emitted in debug mode (`verifierSigner == address(0)`) too, so local stacks exercise the flow. Adds ~1.5k gas to `verifyInput` (event emission only).
- **`verifyInput` is now behind the `isEnabled` kill-switch** (BREAKING) — it was the only intake path not gated by `onlyIfEnabled`, so a disabled TaskManager still verified inputs and still emitted `InputVerified`, which off-chain services relay to the CommitmentRegistry. It now reverts with `CofheIsUnavailable` while disabled, consistent with `createTask`, `createRandomTask` and decrypt-result publishing. **Deployment Requirement:** a proxy migrated via `initializeV2` starts disabled, so `enable()` must be called before input verification works.

### Fixed
- **`initializeV2` seeds fail-closed signers on the bootstrap migration path** — the deterministic bootstrap stub's storage stops at slot 3, so TaskManager's `verifierSigner` (slot 4) and `decryptResultSigner` (slot 7) read storage it never wrote, i.e. zero — which is the verification-*disabled* sentinel, not a safe default. `initializeV2` now sets each to `address(1)` **only when it reads zero**, so a proxy migrating from the pre-roles TaskManager (where both hold real, live values) is left untouched rather than having its signers clobbered. `isEnabled`, `acl` and `plaintextsStorage` are deliberately not seeded — the first must not be flipped on a live proxy, the latter two have no safe default. The resulting end state is asserted in `test/roles/Roles.ts`, so a future layout shift fails CI rather than a testnet.
- **`task:upgradeTM` no longer aborts on the bootstrap migration** — the storage-layout validation runs before the `onlyvalidate` check, so making it throw (correctly) also killed the `DeterministicTM` → `TaskManager` upgrade, which is knowingly layout-incompatible. Validation is now skipped for that one path with an explicit warning, and stays strict everywhere else. The current implementation is also detected by probing for `DeterministicTM.aggregator()` instead of inferring it from `defaultAdmin() == null` — the pre-roles Ownable TaskManager also has no `defaultAdmin()`, so the old heuristic force-imported the stub's layout and rejected the one migration that is actually safe.
- **Deploy scripts reject blank admin delays** — `TM_ADMIN_DELAY=""` (and `REGISTRY_ADMIN_DELAY=""`) previously passed the `undefined` check and then became `0` via `Number("")`, handing a production deploy the zero delay the guard exists to prevent. Blank and whitespace-only now count as unset, and an explicit `0` is refused off local networks. `registry-chain` gained the same delay guard host-chain has, replacing its hardcoded `DEFAULT_ADMIN_DELAY = 0`.
- **`grantAllRoles` fails loudly when it finds no roles** — discovering roles from the ABI meant a stale typechain build or the wrong factory granted nothing and returned success, leaving the proxy with no `UPGRADER_ROLE` holder and a clean deploy log. Both copies now throw. The test-side equivalent (`declaredRoleNames`) asserts non-empty too, so an ABI regression can no longer turn those loops into zero-assertion passes.
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
