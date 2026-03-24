# CommitmentRegistry

UUPS-upgradeable contract for storing on-chain FHE computation commitments. Deployed on Arbitrum One.

## Purpose

After CoFHE computes an FHE operation, it posts a commitment (`handle → hash(ciphertext)`) on-chain. The Threshold Network (TN) uses these commitments to verify ciphertext integrity before decrypting:

1. TN receives a decrypt request for handle `X`
2. TN calls `getCommitment(version, X)` → gets the committed `ctHash`
3. TN fetches the actual ciphertext from the DB
4. TN checks `keccak256(ciphertext) == ctHash` → proceeds with decrypt

## Data Model

```
mapping(bytes32 version => mapping(bytes32 handle => bytes32 ctHash))
```

- **version**: Opaque `bytes32` from the FHE engine — `keccak256(publicKey[securityZone], library_id, library_version, params)`. Scoped per security zone.
- **handle**: The ciphertext identifier (same as `ctHash` in TaskManager).
- **ctHash**: `keccak256` of the actual computed ciphertext bytes.

## Version Lifecycle

```
Unset → Active → Deprecated → Revoked
                → Revoked
```

- **Active**: Accepts new commitments, TN trusts them
- **Deprecated**: No new writes, existing commitments still valid
- **Revoked**: No new writes, existing commitments should not be trusted

No resurrection — once Deprecated or Revoked, cannot go back to Active.

## API

### Write (poster only)

```solidity
postCommitments(bytes32 version, bytes32[] handles, bytes32[] ctHashes)
```

Posts a batch of commitments. Reverts if:
- Version is not Active
- Any handle already has a commitment (write-once)
- Any ctHash is zero
- Arrays have different lengths or are empty

### Admin (owner only)

```solidity
setPoster(address newPoster)          // Change the authorized poster
setVersionStatus(bytes32, VersionStatus) // Manage version lifecycle
```

### Views

```solidity
getCommitment(bytes32 version, bytes32 handle) → bytes32 ctHash
getVersionStatus(bytes32 version) → VersionStatus
getSize(bytes32 version) → uint256   // Number of commitments under a version
getPoster() → address
```

## Gas Costs

Measured on Hardhat (L2 execution only):

| Batch Size | Total Gas | Per Commitment |
|---|---|---|
| 10 | 291,238 | 29,124 |
| 50 | 1,230,990 | 24,620 |
| 100 | 2,405,779 | 24,058 |

Estimated Arbitrum One cost: ~$0.002/commitment at 0.03 gwei effective gas price.

## Testing

```bash
# Run tests
pnpm test:commitment-registry

# Run with gas report
pnpm test:commitment-registry:gas

# Estimate gas on Arbitrum Sepolia
npx hardhat run scripts/estimateGasArbitrum.ts --network arbitrumSepolia
```

## Upgradeability

Uses UUPS proxy pattern with ERC-7201 namespaced storage. Future upgrades can add:
- Array-based iteration over commitments per version
- Merkle root storage for cheaper batch posting
- Additional access control roles
