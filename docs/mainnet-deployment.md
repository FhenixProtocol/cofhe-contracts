# Mainnet Deployment Runbook

Deploys the CoFHE contracts to production chains:

- **Host chains** (`contracts/internal/host-chain`): Ethereum (`--network ethereum`) and Arbitrum One (`--network arbitrumOne`) — CoFHEAddressBook (at the canonical address in `contracts/internal/host-chain/deterministic/addresses.json`, which FHE.sol compiles in), TaskManager, ACL, ACPShareRegistry, PlaintextsStorage.
- **Registry chain** (`contracts/internal/registry-chain`): Arbitrum One — CommitmentRegistry.

End state on every contract: the Gnosis Safe holds `DEFAULT_ADMIN_ROLE` and every operational role, and owns the address book; the deployer EOAs hold nothing.

## Actors and keys

| Role | Address | Env var(s) | Needs gas? |
|---|---|---|---|
| Deployer / temporary admin | `0xf514Ad1dc08781639177ffc09c959689d40dADd1` (the address book's bootstrap owner - it registers the TaskManager in the book, so no other key can complete a fresh deployment) | `DEPLOYER_PRIVATE_KEY` (its private key), `TM_ADMIN_ADDRESS` (its address) | Yes — pays for the whole deployment on each chain |
| Final admin | The Gnosis Safe (deployed at the same address on both chains) | `SAFE_ADMIN_ADDRESS`; optionally `SAFE_OWNER_KEY` (threshold-1 Safes only — lets the accept task execute through the Safe; leave unset for a multisig and it prints the transactions for the Safe app) | Whoever executes the Safe transactions pays for them |
| Maintenance wallet (hardware) | a wallet that gets only `PAUSER_ROLE` and `SECURITY_ZONE_MANAGER_ROLE` on the TaskManager | `MAINTENANCE_ADDRESS` | Yes — for pause/enable and security-zone changes |
| Verifier signer | zk-verifier's production signing address | `VERIFIER_ADDRESS` | No — address only |
| Decrypt-result signer | dispatcher's production signing address | `DECRYPT_RESULT_SIGNER` | No — address only |
| Poster | blockchain-poster's production wallet address (registry chain) | `POSTER_ADDRESS` | No — address only |

Also set: `TM_ADMIN_DELAY` / `REGISTRY_ADMIN_DELAY` (default-admin transfer timelock, seconds), `ETHEREUM_RPC_URL` / `ARBITRUM_ONE_RPC_URL` (keyed endpoints; keyless public defaults are used when unset), `ETHERSCAN_API_KEY` (Etherscan API v2 — one key serves both chains).

## Why the address book is special

FHE.sol compiles in one address: the `CoFHEAddressBook` proxy, created through CreateX from committed creation bytecode (`deterministic/`). Its init code embeds the deployer as first owner, so the address is the same on every chain and anyone who deploys it just hands Fhenix a book owned by Fhenix. `task:deployAddressBook` is idempotent and aborts if the book at the canonical address runs a different implementation or has an unexpected owner.

The TaskManager itself is an ordinary UUPS proxy at whatever address it lands on. `hardhat deploy` registers it under the id FHE.sol pins (`setTm`), or upgrades the registered one in place. `unsetTm` retires an id; every FHE.sol build pinned to it reverts from then on. Both are owner-only, and the owner ends up being the Safe.

### The bootstrap owner key

`deterministic/addresses.json` names the bootstrap owner: the deployer key whose address is baked into the canonical book address. Keep that key in hardware. On every new chain it owns the book until `hardhat deploy` nominates the Safe, so:

- **Rotating the deployer key** still needs the old key to sign one `transferOwnership` per new chain - the book's first owner is fixed by the address.
- **Losing it** means no new chain can be bootstrapped at the canonical address: run `FREEZE_FORCE=1 pnpm freeze:addressBook` with a new owner and ship a new FHE.sol release.
- **A future book upgrade** changes the implementation `task:deployAddressBook` expects. On a chain where the book was already deployed and upgraded the task aborts by design; skip it there.

### Upgrading an existing ACL or PlaintextsStorage in place

A proxy upgraded to this implementation has no TaskManager recorded and rejects every TaskManager call until `setTaskManager` runs. Upgrade atomically: `upgradeToAndCall(impl, setTaskManager(tm))`. A pre-roles proxy needs `initializeV2` first, then `setTaskManager`.

## Host chain deployment (run once per network)

From `contracts/internal/host-chain`, with `.env` filled in per the table above (`<net>` = `ethereum` or `arbitrumOne`):

```bash
pnpm install && pnpm compile

# 1. Deploy the address book at its canonical address
npx hardhat task:deployAddressBook --network <net>

# 2. Full deployment (REGISTER_TASK_MANAGER=1 the first time on a chain, when no TaskManager is registered yet):
#    deploys ACL, ACPShareRegistry, PlaintextsStorage, runs setup, grants every role to the
#    Safe and begins the default-admin transfers. Record the printed addresses.
#    On chain IDs 1 / 42161 the fresh TaskManager is left disabled with the access list on (see Go-live).
REGISTER_TASK_MANAGER=1 npx hardhat deploy --network <net>

# 3. Accept the transfers and the address-book ownership as the Safe. With SAFE_OWNER_KEY set (threshold-1 Safe) this executes
#    through the Safe directly, after TM_ADMIN_DELAY has passed. Without it, it prints the
#    transactions (to / value / data) to create in the Safe app - Transaction Builder can batch
#    them into one; signing can start immediately, execution works once the delay passes.
#    Re-run afterwards to verify: accepted contracts are reported as done.
npx hardhat task:acceptAdminAsSafe --network <net>

# 4. Strip the deployer of its roles (refuses to run until the Safe is the admin)
npx hardhat task:renounceDeployerRoles --network <net>
```

Step 2 refuses to run on chain IDs 1 / 42161 unless `SAFE_ADMIN_ADDRESS`, `TM_ADMIN_ADDRESS`, `TM_ADMIN_DELAY`, `VERIFIER_ADDRESS`, `DECRYPT_RESULT_SIGNER` and `MAINTENANCE_ADDRESS` are all set. Steps 3–4 are idempotent and can be re-run.

- The signer, Safe and maintenance addresses are validated before any contract deploys, so a bad value fails the run while it is still a no-op.
- A `DEPLOYER_PRIVATE_KEY` equal to the public example key in `.env.example` is refused on those chains.
- `SAFE_ADMIN_ADDRESS` must already have code on the chain — deploy the Safe there first.

Verify sources (proxy + implementation are linked automatically):

```bash
npx hardhat verify --network <net> <address>
```

## Commitment registry deployment (Arbitrum One)

From `contracts/internal/registry-chain`, with `.env` filled in (`DEPLOYER_PRIVATE_KEY` here can be any funded deployer key):

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

- `owner()` on CoFHEAddressBook is the Safe.
- `defaultAdmin()` is the Safe on TaskManager, ACL, PlaintextsStorage (and CommitmentRegistry); the Safe holds `DEFAULT_ADMIN_ROLE` on ACPShareRegistry (plain AccessControl — no two-step transfer there).
- The deployer (`TM_ADMIN_ADDRESS` / registry deployer) holds **no** role on any contract (`task:renounceDeployerRoles` output confirms).
- TaskManager: `isEnabled() == false`, `accessListEnabled() == true`, `verifierSigner()` / `decryptResultSigner()` are the production addresses, `acl()` / `plaintextsStorage()` set, ACL's `shareRegistry()` set.
- CommitmentRegistry: poster is `POSTER_ADDRESS`, initial version Active.
- Sources verified on Etherscan / Arbiscan.

## Go-live (per host chain)

Intake stays closed until this runs; do it only once the checklist above passes.

1. If the deploy ran with placeholder signers, set the production ones first: a `VERIFIER_SIGNER_MANAGER_ROLE` holder calls `setVerifierSigner(<zk-verifier signer>)` and a `DECRYPT_SIGNER_MANAGER_ROLE` holder calls `setDecryptResultSigner(<teecryptor signer>)`. Before `renounceDeployerRoles` the deployer can do this directly; afterwards use `npx hardhat task:setSignersAsSafe --verifier <zk-verifier signer> --decrypt <teecryptor signer> --network <net>` (or `task:setVerifierSignerAsSafe` / `task:setDecryptResultSignerAsSafe` for one of them): with `SAFE_OWNER_KEY` it executes through the Safe, otherwise it writes a Transaction Builder batch; re-run to verify.
2. An `ACCESS_LIST_MANAGER_ROLE` holder (the Safe) calls `addToAccessList(accounts)` with the contracts allowed to create tasks.
3. A `PAUSER_ROLE` holder (the Safe or the maintenance wallet) calls `enable()`.

Then check: `verifierSigner()` and `decryptResultSigner()` are the production signers and not an admin wallet, `isEnabled() == true`, and `accessList(<account>) == true` for each listed account.
