# FactoryRegistry Runbook

The FactoryRegistry lets an approved factory put the contracts it deploys on the TaskManager access list. Fhenix approves the factory once. After that, the factory registers its own contracts. Partner contracts call `IFactoryRegistry` (`contracts/IFactoryRegistry.sol`). Ops use the Hardhat tasks below.

Run every command from `contracts/internal/host-chain`. Replace `<network>` with the Hardhat network name, for example `arbitrumSepolia` or `arbitrumOne`.

## Keys and settings

| Setting | What it is | Needed for |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | The signer: the first Hardhat account of `--network`. After the admin handover it holds no roles. | Paying for contract deploys (`deployFactoryRegistry`, `upgradeFactoryRegistry`) |
| `SAFE_ADMIN_ADDRESS` | The Fhenix Safe. It becomes the registry admin and holds every registry role. | The admin at deploy, the expected admin in `grantRegistryRole`, the Safe's roles in `inspectFactoryRegistry`, and every call that the signer cannot send |
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

1. **Deploy the registry.** Commit `factory-registry.json`. Then verify the source with the command that the task prints.

   ```bash
   npx hardhat task:deployFactoryRegistry --network <network>
   npx hardhat verify --network <network> <registry address>
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

5. **Approve each partner factory.** For a factory that ops already added to the list by hand, use the migration steps below instead.

   ```bash
   npx hardhat task:approveFactory --network <network> --factory <factory>
   ```

   If another tree registered the factory's address first, `approveFactory` takes it back only as one Safe batch: set `SAFE_ADMIN_ADDRESS` and leave `SAFE_OWNER_KEY` unset. Without a Safe, run `task:revokeAccess`, then `task:approveFactory`.

6. **Check the result.** Run step 2 again. `holds TM list role` must be `true`.

## Give a partner access

Send the partner:

- the registry address for each chain, from `factory-registry.json`;
- the `IFactoryRegistry` interface, from the `@fhenixprotocol/cofhe-contracts` package.

Tell the partner:

- A factory calls `register` for every contract it deploys.
- A contract that uses FHE in its constructor must be registered first, at its predicted CREATE2 address.
- Every registered contract can register contracts of its own. Do not register a contract that makes arbitrary calls for its users, such as a multicall or a router.

## Move a partner off its own role

Use this when a partner contract holds `ACCESS_LIST_MANAGER_ROLE` on the TaskManager and listed its contracts itself.

1. **List the partner's entries.** Read the TaskManager's `AccessGranted` and `AccessRevoked` logs since the partner got the role. Keep the addresses that `accessList` still returns `true` for.

   ```bash
   cast logs --from-block <block of the role grant> --address <TaskManager> 'AccessGranted(address)' --rpc-url <rpc>
   ```

2. **Check each address before adoption.** After adoption, an address can register contracts. Refuse any contract that makes arbitrary calls for its users, and confirm with the partner that every address is theirs.
3. **Adopt the partner contract as an approved factory.**

   ```bash
   npx hardhat task:adoptIntoRegistry --network <network> --accounts <partner contract>
   ```

4. **Adopt its contracts below it.**

   ```bash
   npx hardhat task:adoptIntoRegistry --network <network> --parent <partner contract> --accounts <a,b,...>
   ```

5. **The partner upgrades its contract** to call `register` instead of the TaskManager.
6. **Revoke the partner's role.** In the Safe app, Transaction Builder, call `revokeRole(ACCESS_LIST_MANAGER_ROLE, <partner contract>)` on the TaskManager.
7. **Adopt late additions.** Read the logs again from step 1 and adopt any new partner entry with step 4. The task skips addresses that it already adopted.
8. **Check who holds the role.** Read the TaskManager's `RoleGranted` and `RoleRevoked` logs for `ACCESS_LIST_MANAGER_ROLE`. Only the Safe, the registry and known ops keys may hold it.

## Remove access

```bash
npx hardhat task:revokeAccess --network <network> --accounts <a,b>
```

- The task shows what it removes, and asks to confirm.
- Unregistering a factory removes every contract below it.
- While the access list is disabled, the TaskManager checks only the deny list, so a removal blocks nothing yet. To block an address then, use `task:addToDenyList`.

## Stop the registry in an emergency

1. In the Safe app, call `revokeRole(ACCESS_LIST_MANAGER_ROLE, <registry>)` on the TaskManager. The registry can then add and remove nothing.
2. The entries that the registry added stay on the list. Remove the ones that must lose access with `task:revokeAccess`. Without the role, the registry is not in control, so the task removes each named account by hand. Name every account: the contracts below a factory are not removed with it.

## Change the TaskManager

`setTaskManager(id)` is admin only, and no task calls it. The entries that the registry wrote stay on the old TaskManager. In order:

1. Remove every tree with `task:revokeAccess`, while the registry still controls the old TaskManager.
2. Revoke the registry's role on the old TaskManager.
3. Call `setTaskManager(id)` from the Safe.
4. Run `task:grantRegistryRole` for the new TaskManager, then approve the factories again.

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
4. After the last chain runs the new build, refresh the registry's snapshot entry and commit `storage-layout-snapshot.json`. The next upgrade then checks against the deployed layout. Do not refresh it while some chains still run the old build.

   ```bash
   npx hardhat task:storage-layout --contract FactoryRegistry --network hardhat
   ```
