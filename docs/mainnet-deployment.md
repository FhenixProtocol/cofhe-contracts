# Mainnet Deployment Runbook

Deploys the CoFHE contracts to production chains:

- **Host chains** (`contracts/internal/host-chain`): Ethereum (`--network ethereum`) and Arbitrum One (`--network arbitrumOne`) — TaskManager (at the canonical `0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9`), ACL, ACPShareRegistry, PlaintextsStorage.
- **Registry chain** (`contracts/internal/registry-chain`): Arbitrum One — CommitmentRegistry.

End state on every contract: the Gnosis Safe holds `DEFAULT_ADMIN_ROLE` and every operational role; the deployer EOAs hold nothing.

## Actors and keys

| Role | Address | Env var(s) | Needs gas? |
|---|---|---|---|
| Deployer / temporary admin | `0x6578D0E3A6d902896415c51cf4188fFBEBE753DB` (the legacy deterministic-TM owner — `initializeV2` is gated on it, so no other key can run the migration) | `KEY` (its private key), `TM_ADMIN_ADDRESS` (its address) | Yes — pays for the whole deployment on each chain |
| Bootstrap owner | `0x55A07F9f…F4E2` — the **intentionally public** dev key. Its address is baked into the canonical TaskManager CREATE2 address | `BOOTSTRAP_OWNER_KEY` | A small amount on each host chain, for exactly two transactions. Never fund it beyond that; sweep leftovers out afterwards |
| Final admin | The Gnosis Safe (deployed at the same address on both chains) | `SAFE_ADMIN_ADDRESS`; optionally `SAFE_OWNER_KEY` (threshold-1 Safes only — lets the accept task execute through the Safe; leave unset for a multisig and it prints the transactions for the Safe app) | Whoever executes the Safe transactions pays for them |
| Verifier signer | zk-verifier's production signing address | `VERIFIER_ADDRESS` | No — address only |
| Decrypt-result signer | dispatcher's production signing address | `DECRYPT_RESULT_SIGNER` | No — address only |
| Poster | blockchain-poster's production wallet address (registry chain) | `POSTER_ADDRESS` | No — address only |

Also set: `TM_ADMIN_DELAY` / `REGISTRY_ADMIN_DELAY` (default-admin transfer timelock, seconds), `ETHEREUM_RPC_URL` / `ARBITRUM_ONE_RPC_URL` (keyed endpoints; keyless public defaults are used when unset), `ETHERSCAN_API_KEY` (Etherscan API v2 — one key serves both chains).

## Why the TaskManager bootstrap is special

The canonical TaskManager address is a CreateX CREATE2 address derived from init code that embeds `DeterministicTM.initialize(0x55A07F9f…)` — the public dev key's address. Two consequences:

1. **Anyone can deploy the proxy on any chain** (CreateX CREATE2 is deployer-agnostic) and, holding the public key, upgrade it — permanently burning the canonical address on that chain. Deploy to a new chain as early as possible.
2. **The proxy is born owned by a public key.** `task:deployDeterministicTM` therefore signs the creation *and* an immediate `transferOwnership(TM_ADMIN_ADDRESS)` with the bootstrap key, using consecutive nonces broadcast back-to-back, so nothing from that account can execute in between and both usually land in the same block. It verifies the final owner and aborts loudly on any mismatch, including code already at the address with an unexpected owner (a possible takeover — investigate, don't proceed).

**On Ethereum, point `ETHEREUM_RPC_URL` at a private-mempool endpoint (e.g. Flashbots Protect, `https://rpc.flashbots.net`) for this step**, so neither transaction is visible before inclusion. Arbitrum One has no public mempool; the plain keyed RPC is fine.

## Host chain deployment (run once per network)

From `contracts/internal/host-chain`, with `.env` filled in per the table above (`<net>` = `ethereum` or `arbitrumOne`):

```bash
pnpm install && pnpm compile

# 1. Bootstrap the deterministic TaskManager proxy and secure its ownership
npx hardhat task:deployDeterministicTM --network <net>

# 2. Full deployment: migrates the TM proxy to the role-based TaskManager (initializeV2),
#    deploys ACL, ACPShareRegistry, PlaintextsStorage, runs setup, grants every role to the
#    Safe and begins the default-admin transfers. Record the printed addresses.
npx hardhat deploy --network <net>

# 3. Accept the transfers as the Safe. With SAFE_OWNER_KEY set (threshold-1 Safe) this executes
#    through the Safe directly, after TM_ADMIN_DELAY has passed. Without it, it prints the
#    transactions (to / value / data) to create in the Safe app - Transaction Builder can batch
#    them into one; signing can start immediately, execution works once the delay passes.
#    Re-run afterwards to verify: accepted contracts are reported as done.
npx hardhat task:acceptAdminAsSafe --network <net>

# 4. Strip the deployer of its roles (refuses to run until the Safe is the admin)
npx hardhat task:renounceDeployerRoles --network <net>
```

Step 2 refuses to run on chain IDs 1 / 42161 unless `SAFE_ADMIN_ADDRESS`, `TM_ADMIN_ADDRESS`, `TM_ADMIN_DELAY`, `VERIFIER_ADDRESS` and `DECRYPT_RESULT_SIGNER` are all set. Steps 3–4 are idempotent and can be re-run.

Verify sources (proxy + implementation are linked automatically):

```bash
npx hardhat verify --network <net> <address>
```

## Commitment registry deployment (Arbitrum One)

From `contracts/internal/registry-chain`, with `.env` filled in (`KEY` here can be any funded deployer key):

```bash
pnpm install && pnpm compile
pnpm deploy:arbitrumOne          # prints COMMITMENT_REGISTRY_ADDRESS — put it in .env

# Accept as the Safe: executes through the Safe with SAFE_OWNER_KEY (threshold-1, after the
# delay), or prints the Safe-app transaction without it. Re-run afterwards to verify.
pnpm acceptAdminAsSafe:arbitrumOne
pnpm renounceDeployerRoles:arbitrumOne
```

The deploy activates the initial commitment version (must match `COMMITMENT_VERSION` in fhe-engine), grants the Safe every role and begins the default-admin transfer.

## Post-deployment checklist (per chain)

- `defaultAdmin()` is the Safe on TaskManager, ACL, PlaintextsStorage (and CommitmentRegistry); the Safe holds `DEFAULT_ADMIN_ROLE` on ACPShareRegistry (plain AccessControl — no two-step transfer there).
- The deployer (`TM_ADMIN_ADDRESS` / registry deployer) holds **no** role on any contract (`task:renounceDeployerRoles` output confirms).
- TaskManager: `isEnabled() == true`, `verifierSigner()` / `decryptResultSigner()` are the production addresses, `acl()` / `plaintextsStorage()` set, ACL's `shareRegistry()` set.
- CommitmentRegistry: poster is `POSTER_ADDRESS`, initial version Active.
- The bootstrap wallet `0x55A07F9f…` has been swept and holds nothing.
- Sources verified on Etherscan / Arbiscan.
