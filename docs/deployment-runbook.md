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

| Contract | State | Value |
| --- | --- | --- |
| CoFHEAddressBook | implementation (ERC-1967 slot) | v1 implementation from `deterministic/addresses.json` |
| CoFHEAddressBook | `owner()` | deployer |
| CoFHEAddressBook | `pendingOwner()` | none |
| CoFHEAddressBook | `getTm(1)` | TaskManager proxy |
| CoFHEAddressBook | `getTm(any other id)` | reverts `TaskManagerNotSet` |
| TaskManager | `defaultAdmin()` | deployer |
| TaskManager | `defaultAdminDelay()` | `TM_ADMIN_DELAY` |
| TaskManager | `pendingDefaultAdmin()` | none |
| TaskManager | PAUSER_ROLE, SECURITY_ZONE_MANAGER_ROLE | deployer only |
| TaskManager | UPGRADER_ROLE, ACCESS_LIST_MANAGER_ROLE, VERIFIER_SIGNER_MANAGER_ROLE, DECRYPT_SIGNER_MANAGER_ROLE, CONFIG_MANAGER_ROLE | deployer only |
| TaskManager | `isEnabled()` | true |
| TaskManager | `accessListEnabled()` | false |
| TaskManager | `accessList(account)` | false for every account |
| TaskManager | security zones min / max (no getter; set by `setSecurityZones`) | 0 / 0 |
| TaskManager | `verifierSigner()` | `VERIFIER_ADDRESS` |
| TaskManager | `decryptResultSigner()` | `DECRYPT_RESULT_SIGNER` |
| TaskManager | `acl()` | ACL proxy |
| TaskManager | `plaintextsStorage()` | PlaintextsStorage proxy |
| TaskManager | `getVersion()` | 1 |
| TaskManager | `isInitialized()` | true |
| TaskManager | `_aggregators(account)` (legacy) | false for every account |
| ACL | `defaultAdmin()` | deployer |
| ACL | `defaultAdminDelay()` | `TM_ADMIN_DELAY` |
| ACL | `pendingDefaultAdmin()` | none |
| ACL | UPGRADER_ROLE | deployer only |
| ACL | `getTaskManagerAddress()` | TaskManager proxy |
| ACL | `defaultRevokerContract()` | ACPTimestampRevoker |
| ACL | `shareRegistry()` | ACPShareRegistry proxy |
| ACL | permissions (`isAllowed`, `persistAllowed`, `globalAllowed`, `isAllowedForDecryption`, delegations) | none granted |
| PlaintextsStorage | `defaultAdmin()` | deployer |
| PlaintextsStorage | `defaultAdminDelay()` | `TM_ADMIN_DELAY` |
| PlaintextsStorage | `pendingDefaultAdmin()` | none |
| PlaintextsStorage | UPGRADER_ROLE | deployer only |
| PlaintextsStorage | `getTaskManagerAddress()` | TaskManager proxy |
| PlaintextsStorage | `getResult(ctHash)` | (0, false) for every handle |
| ACPShareRegistry | DEFAULT_ADMIN_ROLE | deployer only |
| ACPShareRegistry | UPGRADER_ROLE | deployer only |
| ACPShareRegistry | shares (`sharesFor`, `getShare`) | none |
| ACPTimestampRevoker | owner / roles | none (not upgradeable, no admin) |
| ACPTimestampRevoker | `revokeAllAt(issuer)` | 0 for every issuer |
| ACPTimestampRevoker | `revokedSingle(issuer, id)` | false for every pair |

With `SAFE_ADMIN_ADDRESS` set and steps 5 and 6 done, every `deployer` above reads that address instead, and the deployer holds nothing.

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
7. Go-live: an `ACCESS_LIST_MANAGER_ROLE` holder calls `addToAccessList(accounts)` with the contracts allowed to create tasks, then a `PAUSER_ROLE` holder calls `enable()` on the TaskManager — opens intake to those accounts.

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

Final state after step 5, before go-live (the deployer holds nothing anywhere):

| Contract | State | Value |
| --- | --- | --- |
| CoFHEAddressBook | implementation (ERC-1967 slot) | v1 implementation from `deterministic/addresses.json` |
| CoFHEAddressBook | `owner()` | Safe |
| CoFHEAddressBook | `pendingOwner()` | none |
| CoFHEAddressBook | `getTm(1)` | TaskManager proxy |
| CoFHEAddressBook | `getTm(any other id)` | reverts `TaskManagerNotSet` |
| TaskManager | `defaultAdmin()` | Safe |
| TaskManager | `defaultAdminDelay()` | `TM_ADMIN_DELAY` |
| TaskManager | `pendingDefaultAdmin()` | none |
| TaskManager | PAUSER_ROLE, SECURITY_ZONE_MANAGER_ROLE | Safe and `MAINTENANCE_ADDRESS` |
| TaskManager | UPGRADER_ROLE, ACCESS_LIST_MANAGER_ROLE, VERIFIER_SIGNER_MANAGER_ROLE, DECRYPT_SIGNER_MANAGER_ROLE, CONFIG_MANAGER_ROLE | Safe only |
| TaskManager | `isEnabled()` | false until step 7, then true |
| TaskManager | `accessListEnabled()` | true |
| TaskManager | `accessList(account)` | false for every account until an ACCESS_LIST_MANAGER_ROLE holder adds it with `addToAccessList` |
| TaskManager | security zones min / max (no getter; set by `setSecurityZones`) | 0 / 0 |
| TaskManager | `verifierSigner()` | `VERIFIER_ADDRESS` (production signer) |
| TaskManager | `decryptResultSigner()` | `DECRYPT_RESULT_SIGNER` (production signer) |
| TaskManager | `acl()` | ACL proxy |
| TaskManager | `plaintextsStorage()` | PlaintextsStorage proxy |
| TaskManager | `getVersion()` | 1 |
| TaskManager | `isInitialized()` | true |
| TaskManager | `_aggregators(account)` (legacy) | false for every account |
| ACL | `defaultAdmin()` | Safe |
| ACL | `defaultAdminDelay()` | `TM_ADMIN_DELAY` |
| ACL | `pendingDefaultAdmin()` | none |
| ACL | UPGRADER_ROLE | Safe only |
| ACL | `getTaskManagerAddress()` | TaskManager proxy |
| ACL | `defaultRevokerContract()` | ACPTimestampRevoker |
| ACL | `shareRegistry()` | ACPShareRegistry proxy |
| ACL | permissions (`isAllowed`, `persistAllowed`, `globalAllowed`, `isAllowedForDecryption`, delegations) | none granted |
| PlaintextsStorage | `defaultAdmin()` | Safe |
| PlaintextsStorage | `defaultAdminDelay()` | `TM_ADMIN_DELAY` |
| PlaintextsStorage | `pendingDefaultAdmin()` | none |
| PlaintextsStorage | UPGRADER_ROLE | Safe only |
| PlaintextsStorage | `getTaskManagerAddress()` | TaskManager proxy |
| PlaintextsStorage | `getResult(ctHash)` | (0, false) for every handle |
| ACPShareRegistry | DEFAULT_ADMIN_ROLE | Safe only |
| ACPShareRegistry | UPGRADER_ROLE | Safe only |
| ACPShareRegistry | shares (`sharesFor`, `getShare`) | none |
| ACPTimestampRevoker | owner / roles | none (not upgradeable, no admin) |
| ACPTimestampRevoker | `revokeAllAt(issuer)` | 0 for every issuer |
| ACPTimestampRevoker | `revokedSingle(issuer, id)` | false for every pair |
| CommitmentRegistry (Arbitrum One) | `defaultAdmin()` | Safe |
| CommitmentRegistry (Arbitrum One) | `defaultAdminDelay()` | `REGISTRY_ADMIN_DELAY` |
| CommitmentRegistry (Arbitrum One) | `pendingDefaultAdmin()` | none |
| CommitmentRegistry (Arbitrum One) | UPGRADER_ROLE, POSTER_MANAGER_ROLE, VERSION_MANAGER_ROLE | Safe only |
| CommitmentRegistry (Arbitrum One) | `isPoster(POSTER_ADDRESS)` | true; no other poster |
| CommitmentRegistry (Arbitrum One) | `getVersionStatus(0x…02)` | Active |
| CommitmentRegistry (Arbitrum One) | `getVersionStatus(any other version)` | not active |
| CommitmentRegistry (Arbitrum One) | `getSize(0x…02)` / commitments | 0 / none |

## Upgrades

- `npx hardhat task:upgradeTM --network <net> --key <admin key>` — upgrades the TaskManager in place after validating the storage layout (`--onlyvalidate true` checks only).
- `hardhat deploy` again — upgrades the TaskManager and deploys fresh ACL, ACPShareRegistry and PlaintextsStorage; existing ACL permissions are not carried over.
