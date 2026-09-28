# Mainnet Deployment — Environment and Commands

Operator sheet for deploying the host-chain contracts to **Ethereum** (`--network ethereum`) and
**Arbitrum One** (`--network arbitrumOne`). Run everything from `contracts/internal/host-chain`,
once per network.

For the reasoning behind each step — why the address book is deployed the way it is, the CREATE2
address derivation, the squat check — see [`mainnet-deployment.md`](./mainnet-deployment.md).

End state: the Gnosis Safe holds `DEFAULT_ADMIN_ROLE` and every operational role on all four
contracts and owns the address book; the deployer holds nothing; task intake is closed until you deliberately open it.

## Environment variables

All in `contracts/internal/host-chain/.env`. Every entry point resolves to that one file
(`DOTENV_CONFIG_PATH` overrides it).

### Required

The last two are enforced only on chain IDs 1 and 42161; everywhere else they are optional.

| Variable | Value |
|---|---|
| `KEY` | Private key of the deployer. Pays for the whole deployment and is the temporary admin. |
| `TM_ADMIN_ADDRESS` | **Must be exactly `KEY`'s address, and the address book's bootstrap owner on a chain not yet handed over.** It registers the TaskManager in the book and signs as the default admin. |
| `TM_ADMIN_DELAY` | Default-admin transfer timelock, in seconds. Must be a positive integer off a local network; a zero delay removes the timelock entirely. |
| `VERIFIER_ADDRESS` | zk-verifier's production signing address. Must be non-zero — zero is the verification-*disabled* sentinel and is refused off local. |
| `DECRYPT_RESULT_SIGNER` | Dispatcher's production signing address. Same non-zero rule. |
| `SAFE_ADMIN_ADDRESS` | The Gnosis Safe that takes over. **Mandatory on chain IDs 1 and 42161** — the deploy refuses to leave an EOA as `DEFAULT_ADMIN` of mainnet proxies. |
| `MAINTENANCE_ADDRESS` | A wallet (e.g. a Ledger) granted **only** `PAUSER_ROLE` and `SECURITY_ZONE_MANAGER_ROLE` on the TaskManager, so pausing and security-zone changes don't need a multisig round trip. Never granted the admin-equivalent roles. **Mandatory on chain IDs 1 and 42161**, optional elsewhere so the local stack still runs. Note `PAUSER_ROLE` can halt all intake — treat it as availability-critical. |

### Optional

| Variable | Effect when set |
|---|---|
| `SAFE_OWNER_KEY` | Lets step 3 execute **through** the Safe directly. Only works on threshold-1 Safes; the helper refuses anything higher. Unset (a real multisig, or a hardware-held owner key) makes step 3 write a Safe Transaction Builder batch instead. |
| `SAFE_BATCH_OUT` | Overrides where that batch file is written. Default: `safe-batches/<network>-<slug>-<unix>.json`. |
| `ETHEREUM_RPC_URL`, `ARBITRUM_ONE_RPC_URL` | Keyed RPC endpoints. Keyless public defaults are used when unset. |
| `ETHERSCAN_API_KEY` | Etherscan API v2 — one key serves both chains, for `hardhat verify`. |
| `REGISTER_TASK_MANAGER` | Must be `1` for the first `hardhat deploy` on a chain, when the address book has no TaskManager registered. Leave unset for re-runs and upgrades. |

`AGGREGATOR_KEY` and `KEY2` are **local-stack only** and are ignored by a mainnet deployment.

## The four commands

```bash
cd contracts/internal/host-chain
pnpm install && pnpm compile
```

### 1. Deploy the address book

```bash
npx hardhat task:deployAddressBook --network <net>
```

Sends the committed creation bytecode of the `CoFHEAddressBook` v1 implementation and its proxy through CreateX, so both land at the addresses in `deterministic/addresses.json`. Idempotent. Verifies the implementation slot and the owner afterwards and aborts loudly on any mismatch - a book at the canonical address with a different implementation or owner means it was upgraded or changed hands since the freeze; investigate, do not proceed.

Ends with `... owner verified.`

### 2. Deploy and configure everything

```bash
REGISTER_TASK_MANAGER=1 npx hardhat deploy --network <net>
```

The variable is only needed the first time, when no TaskManager is registered yet; re-runs upgrade the registered one in place and refuse to register a new one without it.

Deploys the `TaskManager` and registers it in the address book under the id FHE.sol pins (or upgrades the registered one in place), configures it, then deploys
ACL, ACPTimestampRevoker, ACPShareRegistry and PlaintextsStorage and wires them together. Finally
grants `MAINTENANCE_ADDRESS` its two roles, grants the Safe every role, begins the
two-step default-admin transfer on each contract, and nominates the Safe as owner of the address book.

**The TaskManager is left DISABLED.** On mainnet chain IDs the deploy deliberately skips
`enable()` — intake stays closed until you open it (see Go-live below). Look for:

```
Mainnet deployment - leaving TaskManager DISABLED. ...
```

Record the printed addresses. The deployer keeps its own roles at this point, on purpose.

### 3. Accept the transfers as the Safe

```bash
npx hardhat task:acceptAdminAsSafe --network <net>
```

Rediscovers every contract from the address book and accepts the pending transfers, including the book's own `acceptOwnership()`.

- **With `SAFE_OWNER_KEY`** (threshold-1): executes through the Safe and verifies `defaultAdmin()`
  after each. Fails if the admin delay has not passed.
- **Without it**: writes `safe-batches/<network>-accept-admin-<unix>.json` and prints the same
  calls for review. Import it in the Safe app under **Apps → Transaction Builder**, review, sign,
  execute. Signing can start before the delay expires; only execution must wait. The batch runs as
  a single `MultiSendCallOnly` delegatecall, so each inner call still has the Safe as `msg.sender`,
  and it is atomic — executing too early reverts the whole file rather than applying half of it.

ACPShareRegistry is plain `AccessControl` with no two-step transfer; its `DEFAULT_ADMIN_ROLE` was
granted directly in step 2, so it is reported as already done.

Re-run after execution to verify — accepted contracts are reported as done.

### 4. Strip the deployer

```bash
npx hardhat task:renounceDeployerRoles --network <net>
```

Renounces every role the deployer still holds. Refuses to run unless the Safe genuinely holds
admin on each contract, so a failed acceptance can never leave a contract unmanageable.

## Go-live

Step 2 leaves intake closed. Once you have verified the configuration, a `PAUSER_ROLE` holder —
the Safe, or `MAINTENANCE_ADDRESS` — calls:

```
enable()      // selector 0xa3907d71
```

Verify the following before flipping it: `verifierSigner` and `decryptResultSigner` are the real
production addresses (not `address(1)`, the fail-closed sentinel), `acl()` and
`plaintextsStorage()` are set, and `ACL.shareRegistry()` is set.

## Verify sources

```bash
npx hardhat verify --network <net> <address>
```

## Registry chain

The CommitmentRegistry deploys to Arbitrum One only, from `contracts/internal/registry-chain`,
with the same Safe-handover shape as steps 2–4:

```bash
pnpm deploy:arbitrumOne
pnpm acceptAdminAsSafe:arbitrumOne
pnpm renounceDeployerRoles:arbitrumOne
```

It needs `POSTER_ADDRESS`, `REGISTRY_ADMIN_DELAY`, `SAFE_ADMIN_ADDRESS`, and
`COMMITMENT_REGISTRY_ADDRESS` (printed by the deploy) in that project's own `.env`.

## Final checklist

- [ ] `owner()` on CoFHEAddressBook is the Safe
- [ ] `defaultAdmin()` is the Safe on TaskManager, ACL and PlaintextsStorage; the Safe holds
      `DEFAULT_ADMIN_ROLE` on ACPShareRegistry
- [ ] The deployer holds **no** role on any contract
- [ ] `MAINTENANCE_ADDRESS` holds exactly `PAUSER_ROLE` and `SECURITY_ZONE_MANAGER_ROLE` and
      nothing else
- [ ] `isEnabled()` is `false` until go-live, then `true`
- [ ] `verifierSigner()` / `decryptResultSigner()` are the production addresses
- [ ] `acl()`, `plaintextsStorage()` and `ACL.shareRegistry()` are all set
- [ ] Sources verified on Etherscan / Arbiscan
