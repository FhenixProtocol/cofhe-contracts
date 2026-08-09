# Contract verification

How to verify the deployed CoFHE contracts on a block explorer (source + ABI upload).

## Prerequisites

Both projects use [Etherscan V2](https://docs.etherscan.io/etherscan-v2), so a single
multichain API key from [etherscan.io](https://etherscan.io/myapikey) covers every supported
chain. Set it in each project's `.env`:

```
ETHERSCAN_API_KEY="<your etherscan v2 key>"
```

Verification matches the deployed runtime bytecode, so the checked-out source must be the
**exact release that was deployed** (same solc `0.8.25`, `viaIR`, optimizer `runs: 800`,
`evmVersion: cancun`, `metadata.bytecodeHash: none`). If a contract was deployed from an
older commit, check out that release tag before verifying.

## host-chain

Verifies the TaskManager, ACL and PlaintextsStorage proxies (implementation + proxy link)
in one pass. Run from `contracts/internal/host-chain`:

```
pnpm task:verifyDeployment --network arbitrumSepolia
```

Supported networks: `sepolia`, `arbitrumSepolia`, `baseSepolia`.

The TaskManager proxy is the local `ERC1967Proxy.sol` deployed via CreateX; its constructor
args are reconstructed from the initialize-time owner (`TaskManager.owner()` by default). If
ownership was transferred after deployment, pass the original owner:

```
pnpm task:verifyDeployment --network arbitrumSepolia --admin 0x<initialize-time owner>
```

## registry-chain

Verifies the CommitmentRegistry proxy (implementation + proxy link). The deployed address is
published to `commitment-registry-address.txt` at deploy time; pass it via env. Run from
`contracts/internal/registry-chain`:

```
COMMITMENT_REGISTRY_ADDRESS=0x<address> pnpm task:verify --network arbitrumSepolia
```

## Notes

- The tasks are idempotent — already-verified contracts are skipped.
- Right after a deploy the explorer may not have indexed the creation transactions yet; if
  proxy linking fails, rerun after a few blocks.
