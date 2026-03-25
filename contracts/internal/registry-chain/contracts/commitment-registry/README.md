# CommitmentRegistry

UUPS-upgradeable contract for storing on-chain FHE computation commitments. Deployed on Arbitrum One.

## Purpose

After CoFHE computes an FHE operation, it posts a commitment (`handle → hash(ciphertext)`) on-chain. The Threshold Network (TN) uses these commitments to verify ciphertext integrity before decrypting:

1. TN receives a decrypt request for handle `X`
2. TN calls `getCommitment(version, X)` → gets the committed `commitHash`
3. TN fetches the actual ciphertext from the DB
4. TN checks `keccak256(ciphertext) == commitHash` → proceeds with decrypt

## Data Model

```
mapping(bytes32 version => mapping(bytes32 handle => bytes32 commitHash))  // O(1) lookup
mapping(bytes32 version => bytes32[])  // enumerable handle list per version
```

- **version**: Opaque `bytes32` from the FHE engine — `keccak256(publicKey[securityZone], library_id, library_version, params)`. Scoped per security zone.
- **handle**: The ciphertext identifier.
- **commitHash**: `keccak256` of the actual computed ciphertext bytes.

Each commitment is stored in both the mapping (for lookup) and the array (for enumeration/migration).

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
postCommitments(bytes32 version, bytes32[] handles, bytes32[] commitHashes)
```

Posts a batch of commitments. Reverts if:
- Version is not Active
- Any handle already has a commitment (write-once)
- Any commitHash is zero
- Arrays have different lengths or are empty

### Admin (owner only)

```solidity
setPoster(address newPoster)          // Change the authorized poster
setVersionStatus(bytes32, VersionStatus) // Manage version lifecycle
```

### Views

```solidity
getCommitment(bytes32 version, bytes32 handle) → bytes32 commitHash
getVersionStatus(bytes32 version) → VersionStatus
getSize(bytes32 version) → uint256            // Number of commitments under a version
getHandleByIndex(bytes32 version, uint256 index) → bytes32  // Enumerate by index
getHandles(bytes32 version, uint256 offset, uint256 limit) → bytes32[]  // Paginated cursor
getPoster() → address
```

## Gas Costs

Measured on Hardhat (L2 execution only, includes mapping + array storage):

| Batch Size | Total Gas | Per Commitment |
|---|---|---|
| 1 | 102,222 | 102,222 |
| 10 | 517,726 | 51,773 |
| 25 | 1,210,188 | 48,408 |
| 50 | 2,364,306 | 47,286 |
| 100 | 4,672,513 | 46,725 |

Per-commitment cost converges to ~47K gas at scale. The fixed overhead per batch is ~55K gas (tx base + access control + version check + event).

Estimated Arbitrum One cost at 0.03 gwei effective gas price, ETH ~$2,140:
- Single post: ~$0.007/CT
- Batch of 10: ~$0.003/CT
- Batch of 50: ~$0.003/CT

Monthly projections (100K CTs/day): $9K-20K/mo depending on batch efficiency.

## Testing

```bash
cd contracts/internal/registry-chain

# Install dependencies
pnpm install

# Run tests
pnpm test

# Run with gas report
pnpm test:gas

# Estimate gas on Arbitrum Sepolia (needs KEY in .env)
npx hardhat run scripts/estimateGasArbitrum.ts --network arbitrumSepolia
```

## Upgradeability

Uses UUPS proxy pattern with ERC-7201 namespaced storage. Future upgrades can add:
- Merkle root storage for cheaper batch posting (~10-20x cost reduction)
- Additional access control roles
- Additional access control roles
