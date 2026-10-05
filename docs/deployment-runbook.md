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

### Step 1 — Install and compile

```bash
pnpm install && pnpm compile
```

Check: `pnpm compile` exits without errors.

### Step 2 — Deploy the address book

```bash
npx hardhat task:deployAddressBook --network <net>
```

Deploys CoFHEAddressBook (implementation + proxy) at the canonical address via CreateX and verifies it.

Check: the printed address matches `addressBook` in `deterministic/addresses.json`.

### Step 3 — Deploy and register the TaskManager

```bash
REGISTER_TASK_MANAGER=1 npx hardhat deploy --network <net>
```

Deploys and configures the TaskManager (intake enabled), deploys ACL, ACPShareRegistry and PlaintextsStorage, registers the TaskManager in the book, prints all addresses. With `SAFE_ADMIN_ADDRESS` set it also grants that address every role, starts the admin transfers and nominates it as book owner.

Output: `ignition/deployments/chain-<chainId>/artifacts/TaskManager#TaskManager.json` (ABI + `address`); copy it to the services' `CONFIG_PATH/deployments/<chainId>/TaskManager.json` (slim-listener, result-processor) and put its `address` in the dispatcher's `tm_contract_address` and fheos's `PERMIT_CHAINS_JSON`.

Check: the log says `Registered TaskManager <address> as id 1 in the address book` and the artifact's `address` is that address.

### Step 4 — Verify sources (optional)

```bash
npx hardhat verify --network <net> <address>
```

Check: the explorer shows the contract as verified.

### Chain that already has a TaskManager

For example the legacy one: run step 2, then instead of step 3:

```bash
npx hardhat task:registerTaskManager --address <existing TaskManager> --network <net>
```

Points id 1 at it and writes the same artifact as step 3 (`--force true` to repoint an id that is already set). With `SAFE_ADMIN_ADDRESS` set it also nominates that address as book owner (accepted in step 5). The existing TaskManager, ACL and PlaintextsStorage stay as they are, so the final-state table below does not apply.

Check: the log says `TaskManager id 1 now points at <existing TaskManager>`.

Only when `SAFE_ADMIN_ADDRESS` was set:

### Step 5 — Accept the admin transfers

```bash
npx hardhat task:acceptAdminAsSafe --network <net>
```

Accepts the admin transfers and the book ownership as that address: directly when `SAFE_OWNER_KEY` is its own key, through the Safe when it is a Safe owner key, otherwise writes a Safe batch file. Run after `TM_ADMIN_DELAY`.

Check: re-run the task; every contract reports `already the owner` or `already the default admin`.

### Step 6 — Renounce the deployer's roles

```bash
npx hardhat task:renounceDeployerRoles --network <net>
```

Strips every role from the deployer.

Check: the task ends with `Done - the Safe is the default admin and sole role holder.`

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

### Step 1 — Install and compile

```bash
pnpm install && pnpm compile
```

Check: `pnpm compile` exits without errors.

### Step 2 — Deploy the address book

```bash
npx hardhat task:deployAddressBook --network <net>
```

Deploys CoFHEAddressBook at the canonical address via CreateX and verifies it.

Check: the printed address matches `addressBook` in `deterministic/addresses.json`.

### Step 3 — Deploy and register the TaskManager

```bash
REGISTER_TASK_MANAGER=1 npx hardhat deploy --network <net>
```

Deploys and configures the TaskManager (intake stays disabled), deploys ACL, ACPShareRegistry and PlaintextsStorage, registers the TaskManager in the book, grants the maintenance roles, grants the Safe every role and starts the admin transfers, nominates the Safe as book owner, prints all addresses.

Output: `ignition/deployments/chain-<chainId>/artifacts/TaskManager#TaskManager.json` (ABI + `address`); copy it to the services' `CONFIG_PATH/deployments/<chainId>/TaskManager.json` (slim-listener, result-processor) and put its `address` in the dispatcher's `tm_contract_address` and fheos's `PERMIT_CHAINS_JSON`.

Check: the log says `Registered TaskManager <address> as id 1 in the address book` and the artifact's `address` is that address.

If the run fails after that line, rerun the same command: it upgrades the registered TaskManager and finishes the maintenance grant and the admin handover.

### Step 4 — Accept the admin transfers as the Safe

```bash
npx hardhat task:acceptAdminAsSafe --network <net>
```

Accepts the admin transfers and the book ownership as the Safe: through the Safe with `SAFE_OWNER_KEY`, otherwise writes `safe-batches/<net>-accept-admin-<unix>.json` to import in the Safe app. Execute after `TM_ADMIN_DELAY`.

Check: re-run the task; every contract reports `already the owner` or `already the default admin`.

### Step 5 — Renounce the deployer's roles

```bash
npx hardhat task:renounceDeployerRoles --network <net>
```

Strips every role from the deployer (refuses until the Safe is admin everywhere).

Check: the task ends with `Done - the Safe is the default admin and sole role holder.`

### Step 6 — Verify sources

```bash
npx hardhat verify --network <net> <address>
```

Check: the explorer shows the contract as verified.

### Step 7 — Go-live

```bash
npx hardhat task:setSignersAsSafe --verifier <zk-verifier signer> --decrypt <teecryptor signer> --network <net>
```

```text
TaskManager.addToAccessList(accounts)   # an ACCESS_LIST_MANAGER_ROLE holder
TaskManager.enable()                    # a PAUSER_ROLE holder
```

If the deploy ran with placeholder signers, set the production ones first: the task executes through the Safe with `SAFE_OWNER_KEY`, otherwise it writes a Transaction Builder batch (`task:setVerifierSignerAsSafe` / `task:setDecryptResultSignerAsSafe` set one at a time; full procedure in [set-signers-as-safe.md](set-signers-as-safe.md)). Then an `ACCESS_LIST_MANAGER_ROLE` holder calls `addToAccessList(accounts)` with the contracts allowed to create tasks, and a `PAUSER_ROLE` holder calls `enable()` on the TaskManager. Opens intake to those accounts.

Check: `verifierSigner()` and `decryptResultSigner()` are the production signers, `isEnabled()` is true and `accessList(account)` is true for each added account.

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

### Step 8 — Deploy the CommitmentRegistry

```bash
pnpm install && pnpm compile && pnpm deploy:arbitrumOne
```

Deploys CommitmentRegistry, grants posting rights to `POSTER_ADDRESS`, activates the initial commitment version, grants the Safe every role and starts the admin transfer; prints `COMMITMENT_REGISTRY_ADDRESS`.

Check: the last line is `COMMITMENT_REGISTRY_ADDRESS=<address>`; set it in `.env` before step 9.

### Step 9 — Accept the admin transfer as the Safe

```bash
pnpm acceptAdminAsSafe:arbitrumOne
```

Accepts as the Safe (through it, or via a batch file). Execute after `REGISTRY_ADMIN_DELAY`.

Check: re-run the script; it reports `Safe is already the default admin`.

### Step 10 — Renounce the deployer

```bash
pnpm renounceDeployerRoles:arbitrumOne
```

Strips the deployer.

Check: the script ends with `Done - the Safe is the default admin and sole role holder.`

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
- `npx hardhat task:upgradeACL --network <net> --key <admin key>` / `task:upgradePlaintextsStorage` — upgrade the registered TaskManager's ACL or PlaintextsStorage, setting the TaskManager in the same `upgradeToAndCall` after validating the storage layout (`--onlyvalidate true` checks only).
- `hardhat deploy` again — upgrades the registered TaskManager in place and keeps its ACL and PlaintextsStorage; the setup (signers, intake) is not rerun. It also finishes a maintenance grant or admin handover that an earlier run did not complete. `FULL_REDEPLOY=1 npx hardhat deploy --network <net>` also deploys fresh ACL, ACPShareRegistry and PlaintextsStorage and reruns the setup: ACL permissions and stored plaintexts are not carried over, and the signers and intake state are overwritten from the environment.

After the handover only the Safe holds `UPGRADER_ROLE`, so `task:upgradeTM`, `task:upgradeACL` and `task:upgradePlaintextsStorage` deploy the implementation with any funded key and hand the upgrade itself to the Safe:

### Step 1 — Validate the storage layout

```bash
npx hardhat task:upgradeTM --network <net> --key <any funded key> --onlyvalidate true
```

Check: the task prints `Storage layout is compatible with the previous implementation`.

### Step 2 — Upgrade through the Safe

```bash
npx hardhat task:upgradeTM --network <net> --key <any funded key>
```

With `SAFE_ADMIN_ADDRESS` set: with `SAFE_OWNER_KEY` it executes `upgradeToAndCall` and `incVersion` through the Safe; otherwise it writes `safe-batches/<net>-upgrade-tm-<unix>.json` to import under Apps -> Transaction Builder in the Safe app, then sign and execute.

Check: `getVersion()` went up by one and the implementation slot points at the printed new address.

### Step 3 — Upgrade the ACL or PlaintextsStorage (when they changed)

```bash
npx hardhat task:upgradeACL --network <net> --key <any funded key> --onlyvalidate true
npx hardhat task:upgradeACL --network <net> --key <any funded key>
npx hardhat task:upgradePlaintextsStorage --network <net> --key <any funded key> --onlyvalidate true
npx hardhat task:upgradePlaintextsStorage --network <net> --key <any funded key>
```

Same Safe flow as step 2: one `upgradeToAndCall(impl, setTaskManager(tm))`, executed through the Safe with `SAFE_OWNER_KEY`, otherwise written to `safe-batches/<net>-upgrade-acl-<unix>.json` / `safe-batches/<net>-upgrade-plaintexts-storage-<unix>.json`.

Check: `getTaskManagerAddress()` is the registered TaskManager and the implementation slot points at the printed new address.
