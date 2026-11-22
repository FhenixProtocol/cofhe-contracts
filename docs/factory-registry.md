# FactoryRegistry Runbook

The FactoryRegistry lets an approved factory put the contracts it deploys on the TaskManager access list. Fhenix approves the factory once. After that, the factory registers its own contracts. Partner contracts call `IFactoryRegistry` (`contracts/IFactoryRegistry.sol`). Ops use the Hardhat tasks below.

Run every command from `contracts/internal/host-chain`. Replace `<network>` with the Hardhat network name, for example `arbitrumSepolia` or `arbitrumOne`.

## Keys and settings

| Setting | What it is | Needed for |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | The signer: the first Hardhat account of `--network`. After the admin handover it holds no roles. | Paying for contract deploys (`deployFactoryRegistry`, `upgradeFactoryRegistry`) |
| `SAFE_ADMIN_ADDRESS` | The Fhenix Safe. It becomes the registry admin and holds every registry role. | Every task that the signer cannot send |
| `SAFE_OWNER_KEY` | Optional. A Safe owner key, for a Safe with threshold 1. | Executing through the Safe directly, instead of writing a batch file |

`factory-registry.json` records the registry address for each chain. `task:deployFactoryRegistry` writes it. Commit it.

## Who sends

Each task sends its calls in the first way that applies:

1. **The signer**, when it holds every role the calls need.
2. **The Safe, with `SAFE_OWNER_KEY` set:** each call is executed through the Safe. On testnets the admin can be a plain wallet; then that wallet sends directly.
3. **A Safe batch file:** the task writes all calls into one file. Import it in the Safe app (Apps, Transaction Builder), then sign and execute it. Run the same task again: it verifies the result.

A batch file runs as one transaction, so its calls succeed or fail together.

## Tasks

| Task | Purpose | Command |
|---|---|---|
| `task:deployFactoryRegistry` | Deploy the registry once per chain. The admin is `SAFE_ADMIN_ADDRESS` (or the signer), with the TaskManager's admin delay. | `npx hardhat task:deployFactoryRegistry --network <network>` |
| `task:storage-layout --contract` | Write the registry's storage-layout snapshot entry. Keep the other entries. | `npx hardhat task:storage-layout --contract FactoryRegistry --network hardhat` |
| `task:grantRegistryRole` | Give the registry `ACCESS_LIST_MANAGER_ROLE` on the TaskManager. It first checks the proxy code, the build, the TaskManager pointer, the admin and the admin delay. | `npx hardhat task:grantRegistryRole --network <network>` |
| `task:setRegistryRevoker` | Give an ops key `REVOKER_ROLE`, or take it back. The role can only remove access. | `npx hardhat task:setRegistryRevoker --network <network> --account <address> [--revoke true]` |
| `task:approveFactory` | Approve a factory, so it can register contracts. | `npx hardhat task:approveFactory --network <network> --factory <address>` |
| `task:adoptIntoRegistry` | Move entries that ops added to the list by hand into a tree. They keep access, with no gap. Without `--parent`, they become approved factories. | `npx hardhat task:adoptIntoRegistry --network <network> --accounts <a,b> [--parent <address>]` |
| `task:revokeAccess` | Take access away. A tree node is unregistered with everything below it; any other account is removed from the list by hand. | `npx hardhat task:revokeAccess --network <network> --accounts <a,b>` |
| `task:upgradeFactoryRegistry` | Upgrade the registry in place, after the storage-layout check. `--onlyvalidate true` stops after the check. | `npx hardhat task:upgradeFactoryRegistry --network <network> [--onlyvalidate true]` |
| `task:inspectFactoryRegistry` | Print the registry's state: build, admin, delay, TaskManager, role, and the Safe's roles. Sends nothing. | `npx hardhat task:inspectFactoryRegistry --network <network>` |

Common options:

- `--yes`: skip the confirmation question (deploy, grant, revoke, upgrade).
- `--out <path>`: where to write the Safe batch file.

`npx hardhat help <task>` prints every option of a task.

## Roll out on one chain

Do these steps on each testnet first, then on each mainnet.

1. **Deploy the registry.** Commit `factory-registry.json`.

   ```bash
   npx hardhat task:deployFactoryRegistry --network <network>
   ```

2. **Check the state.** The build must be this build, and the admin must be the Safe.

   ```bash
   npx hardhat task:inspectFactoryRegistry --network <network>
   ```

3. **Give the registry its TaskManager role.** The TaskManager admin (the Safe) signs this.

   ```bash
   npx hardhat task:grantRegistryRole --network <network>
   ```

4. **Optional: give an ops key the revoker role.**

   ```bash
   npx hardhat task:setRegistryRevoker --network <network> --account <ops key address>
   ```

5. **Approve each partner factory**, or adopt it when ops already added it to the list by hand.

   ```bash
   npx hardhat task:approveFactory --network <network> --factory <factory>
   npx hardhat task:adoptIntoRegistry --network <network> --accounts <factory>
   ```

6. **Check the result.** Run step 2 again. `holds TM list role` must be `true`.

## Remove access

```bash
npx hardhat task:revokeAccess --network <network> --accounts <a,b>
```

- The task shows what it removes, and asks to confirm.
- Unregistering a factory removes every contract below it.
- While the access list is disabled, the TaskManager checks only the deny list, so a removal blocks nothing yet. To block an address then, use `task:addToDenyList`.

## Upgrade the registry

1. Check the new build against the storage-layout snapshot:

   ```bash
   npx hardhat task:upgradeFactoryRegistry --network <network> --onlyvalidate true
   ```

2. Upgrade. The signer deploys the new implementation. The `UPGRADER_ROLE` holder (the Safe) sends the upgrade.

   ```bash
   npx hardhat task:upgradeFactoryRegistry --network <network>
   ```

3. With a batch file, run step 2 again only after the Safe executes the batch. An earlier run deploys a second implementation.
