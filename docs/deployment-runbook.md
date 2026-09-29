# Deployment runbook

Parameters to set and commands to run, per environment. Every command runs from `contracts/internal/host-chain` (registry chain: `contracts/internal/registry-chain`) and reads that directory's `.env`.

## Testnet

Set in `contracts/internal/host-chain/.env`:

| Variable | Value |
| --- | --- |
| `DEPLOYER_PRIVATE_KEY` | Deployer private key. On a first deploy its address must be the bootstrap owner in `deterministic/addresses.json`. |
| `TM_ADMIN_ADDRESS` | The deployer's address |
| `TM_ADMIN_DELAY` | Admin-transfer timelock in seconds (e.g. `600`) |
| `VERIFIER_ADDRESS` | zk-verifier signing address (non-zero) |
| `DECRYPT_RESULT_SIGNER` | Dispatcher signing address (non-zero) |
| `REGISTER_TASK_MANAGER` | `1` on the first deploy only |
| `SAFE_ADMIN_ADDRESS` | Optional. Address that takes over every role and the address book (a Safe or an EOA). Unset keeps the deployer as admin. |
| `SAFE_OWNER_KEY` | With `SAFE_ADMIN_ADDRESS`: the EOA's own private key (accepts directly), or a threshold-1 Safe owner key (accepts through the Safe). |
| `SEPOLIA_RPC_URL` / `ARBITRUM_SEPOLIA_RPC_URL` / `BASE_SEPOLIA_RPC_URL` | Keyed RPC (optional) |
| `ETHERSCAN_API_KEY` | For `hardhat verify` (optional) |

Run with `<net>` = `sepolia`, `arbitrumSepolia` or `baseSepolia`:

1. `pnpm install && pnpm compile` — installs and compiles.
2. `npx hardhat task:deployAddressBook --network <net>` — deploys CoFHEAddressBook (implementation + proxy) at the canonical address via CreateX and verifies it.
3. `REGISTER_TASK_MANAGER=1 npx hardhat deploy --network <net>` — deploys and configures the TaskManager (intake enabled), deploys ACL, ACPShareRegistry and PlaintextsStorage, registers the TaskManager in the book, prints all addresses. With `SAFE_ADMIN_ADDRESS` set it also grants that address every role, starts the admin transfers and nominates it as book owner.
4. `npx hardhat verify --network <net> <address>` — verifies sources (optional).

Only when `SAFE_ADMIN_ADDRESS` was set:

5. `npx hardhat task:acceptAdminAsSafe --network <net>` — accepts the admin transfers and the book ownership as that address: directly when `SAFE_OWNER_KEY` is its own key, through the Safe when it is a Safe owner key, otherwise writes a Safe batch file. Run after `TM_ADMIN_DELAY`; re-run to verify.
6. `npx hardhat task:renounceDeployerRoles --network <net>` — strips every role from the deployer.

Final state after step 3 (deployer keeps everything):

| Contract | Final state |
| --- | --- |
| CoFHEAddressBook | Implementation v1; owner = deployer; `getTm(1)` = TaskManager; no other ids |
| TaskManager | `defaultAdmin` = deployer, holding all seven roles (UPGRADER, PAUSER, SECURITY_ZONE_MANAGER, ACCESS_LIST_MANAGER, VERIFIER_SIGNER_MANAGER, DECRYPT_SIGNER_MANAGER, CONFIG_MANAGER); `isEnabled` = true; access list disabled and empty; security zones 0..0; `verifierSigner` = `VERIFIER_ADDRESS`; `decryptResultSigner` = `DECRYPT_RESULT_SIGNER`; `acl` and `plaintextsStorage` set; `getVersion()` = 1 |
| ACL | `defaultAdmin` = deployer (+ UPGRADER); `taskManager` = TaskManager; `defaultRevokerContract` = ACPTimestampRevoker; `shareRegistry` = ACPShareRegistry; no permissions yet |
| PlaintextsStorage | `defaultAdmin` = deployer (+ UPGRADER); `taskManager` = TaskManager; empty |
| ACPShareRegistry | deployer holds DEFAULT_ADMIN_ROLE and UPGRADER_ROLE; empty |
| ACPTimestampRevoker | No owner or configuration; per-issuer revocation state only |

With `SAFE_ADMIN_ADDRESS` set and steps 5 and 6 done: that address owns the book, is `defaultAdmin` with every role on TaskManager, ACL and PlaintextsStorage (transfer delay `TM_ADMIN_DELAY`), and holds DEFAULT_ADMIN_ROLE and UPGRADER_ROLE on ACPShareRegistry; the deployer holds nothing.

## Mainnet

Set in `contracts/internal/host-chain/.env`:

| Variable | Value |
| --- | --- |
| `DEPLOYER_PRIVATE_KEY` | Deployer private key. On a first deploy its address must be the bootstrap owner in `deterministic/addresses.json`. |
| `TM_ADMIN_ADDRESS` | The deployer's address |
| `TM_ADMIN_DELAY` | Admin-transfer timelock in seconds |
| `VERIFIER_ADDRESS` | zk-verifier production signing address |
| `DECRYPT_RESULT_SIGNER` | Dispatcher production signing address |
| `SAFE_ADMIN_ADDRESS` | The Gnosis Safe (final admin and book owner) |
| `MAINTENANCE_ADDRESS` | Wallet that gets `PAUSER_ROLE` and `SECURITY_ZONE_MANAGER_ROLE` |
| `REGISTER_TASK_MANAGER` | `1` on the first deploy only |
| `ETHEREUM_RPC_URL` / `ARBITRUM_ONE_RPC_URL` | Keyed RPC (optional) |
| `ETHERSCAN_API_KEY` | For `hardhat verify` (optional) |
| `SAFE_OWNER_KEY` | Threshold-1 Safes only: executes the accept step through the Safe (optional) |

Run once per `<net>` = `ethereum` and `arbitrumOne`:

1. `pnpm install && pnpm compile` — installs and compiles.
2. `npx hardhat task:deployAddressBook --network <net>` — deploys CoFHEAddressBook at the canonical address via CreateX and verifies it.
3. `REGISTER_TASK_MANAGER=1 npx hardhat deploy --network <net>` — deploys and configures the TaskManager (intake stays disabled), deploys ACL, ACPShareRegistry and PlaintextsStorage, registers the TaskManager in the book, grants the maintenance roles, grants the Safe every role and starts the admin transfers, nominates the Safe as book owner, prints all addresses.
4. `npx hardhat task:acceptAdminAsSafe --network <net>` — accepts the admin transfers and the book ownership as the Safe: through the Safe with `SAFE_OWNER_KEY`, otherwise writes `safe-batches/<net>-accept-admin-<unix>.json` to import in the Safe app. Execute after `TM_ADMIN_DELAY`; re-run to verify.
5. `npx hardhat task:renounceDeployerRoles --network <net>` — strips every role from the deployer (refuses until the Safe is admin everywhere).
6. `npx hardhat verify --network <net> <address>` — verifies sources.
7. Go-live: a `PAUSER_ROLE` holder calls `enable()` on the TaskManager — opens intake.

Registry chain, set in `contracts/internal/registry-chain/.env`:

| Variable | Value |
| --- | --- |
| `DEPLOYER_PRIVATE_KEY` | Deployer private key |
| `POSTER_ADDRESS` | blockchain-poster wallet address |
| `REGISTRY_ADMIN_DELAY` | Admin-transfer timelock in seconds |
| `SAFE_ADMIN_ADDRESS` | The Gnosis Safe |
| `COMMITMENT_REGISTRY_ADDRESS` | Printed by step 8; set it before steps 9 and 10 |
| `ARBITRUM_ONE_RPC_URL` / `ETHERSCAN_API_KEY` / `SAFE_OWNER_KEY` | Optional, as above |

Run from `contracts/internal/registry-chain`:

8. `pnpm install && pnpm compile && pnpm deploy:arbitrumOne` — deploys CommitmentRegistry, grants posting rights to `POSTER_ADDRESS`, activates the initial commitment version, grants the Safe every role and starts the admin transfer; prints `COMMITMENT_REGISTRY_ADDRESS`.
9. `pnpm acceptAdminAsSafe:arbitrumOne` — accepts as the Safe (through it, or via a batch file).
10. `pnpm renounceDeployerRoles:arbitrumOne` — strips the deployer.

Final state after step 5, before go-live:

| Contract | Final state |
| --- | --- |
| CoFHEAddressBook | Implementation v1; owner = Safe; `getTm(1)` = TaskManager; no other ids |
| TaskManager | `defaultAdmin` = Safe (transfer delay `TM_ADMIN_DELAY`), holding all seven roles; `MAINTENANCE_ADDRESS` holds PAUSER_ROLE and SECURITY_ZONE_MANAGER_ROLE only; deployer holds nothing; `isEnabled` = false until step 7, then true; access list disabled and empty; security zones 0..0; `verifierSigner` and `decryptResultSigner` = the production signers; `acl` and `plaintextsStorage` set; `getVersion()` = 1 |
| ACL | `defaultAdmin` = Safe (+ UPGRADER); `taskManager` = TaskManager; `defaultRevokerContract` = ACPTimestampRevoker; `shareRegistry` = ACPShareRegistry; no permissions yet |
| PlaintextsStorage | `defaultAdmin` = Safe (+ UPGRADER); `taskManager` = TaskManager; empty |
| ACPShareRegistry | Safe holds DEFAULT_ADMIN_ROLE and UPGRADER_ROLE; deployer holds nothing; empty |
| ACPTimestampRevoker | No owner or configuration; per-issuer revocation state only |
| CommitmentRegistry (Arbitrum One) | `defaultAdmin` = Safe (transfer delay `REGISTRY_ADMIN_DELAY`), holding UPGRADER, POSTER_MANAGER and VERSION_MANAGER; poster = `POSTER_ADDRESS`; commitment version 2 active; deployer holds nothing |

## Upgrades

- `npx hardhat task:upgradeTM --network <net> --key <admin key>` — upgrades the TaskManager in place after validating the storage layout (`--onlyvalidate true` checks only).
- `hardhat deploy` again — upgrades the TaskManager and deploys fresh ACL, ACPShareRegistry and PlaintextsStorage; existing ACL permissions are not carried over.
