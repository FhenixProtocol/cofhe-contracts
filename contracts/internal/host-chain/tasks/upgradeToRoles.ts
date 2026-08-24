import chalk from "chalk";
import { task, types } from "hardhat/config";
import type { TaskArguments, HardhatRuntimeEnvironment } from "hardhat/types";
import { Wallet } from "ethers";
import fs from "fs";
import { join } from "path";

import {
  getDefaultAdmin,
  grantAllRoles,
  requireDefaultAdminIsSignerOrUnset,
  resolveAdminDelay,
} from "../utils/roles";

/**
 * Migrates a host-chain deployment from the pre-roles (Ownable) contracts to the role-based ones,
 * and brings up the ACP infrastructure that never existed on such a chain.
 *
 * Five steps, in this order:
 *
 *   1. upgrade ACL                       (Ownable2Step -> AccessControlDefaultAdminRules)
 *   2. deploy ACPTimestampRevoker + ACPShareRegistry
 *   3. wire both into the ACL
 *   4. upgrade PlaintextsStorage         (Ownable -> AccessControlDefaultAdminRules)
 *   5. upgrade TaskManager               (Ownable2Step -> AccessControlDefaultAdminRules)
 *
 * The ACL upgrade has to come before the ACP wiring: `setDefaultRevokerContract` and
 * `setShareRegistry` are `onlyRole(DEFAULT_ADMIN_ROLE)` on the new implementation, and that role
 * does not exist until `initializeV2` has run. Deploying the ACP contracts after the upgrade
 * rather than before also makes a re-run idempotent - the ACL itself is then the record of what
 * is already wired, so a resumed run reuses the existing contracts instead of orphaning them.
 *
 * TaskManager goes last. Every ACL function the pre-roles TaskManager calls is unchanged in the
 * new ACL, so the window between steps 1 and 5 runs old TaskManager against new ACL safely; the
 * reverse (new TaskManager against old ACL) would not be.
 *
 * Each upgrade is a single `upgradeToAndCall(newImpl, initializeV2(...))`, so no proxy is ever
 * observable in a half-migrated state. `initializeV2` is gated on the owner left behind in the
 * abandoned `openzeppelin.storage.Ownable` namespace - see {LegacyOwnable} - which is why this
 * task must be signed by that account and checks for it up front.
 */

/// ERC-1967 implementation slot.
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/// `openzeppelin.storage.Ownable` ERC-7201 namespace. Mirrors `LegacyOwnable.OWNABLE_STORAGE_SLOT`
/// in contracts/LegacyOwnable.sol - this is the authority `initializeV2` checks against.
const OWNABLE_STORAGE_SLOT =
  "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300";

/// Mirrors `taskManagerAddress` in contracts/addresses/TaskManagerAddress.sol. The ACL compiles
/// that constant in as `TASK_MANAGER_ADDRESS`, so it is fixed for a given ACL build; `--taskmanager`
/// overrides it only for tests against throwaway proxies.
const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

/** Reads a 20-byte address out of a raw storage slot. */
async function readAddressSlot(ethers: any, address: string, slot: string): Promise<string> {
  const raw = await ethers.provider.getStorage(address, slot);
  return ethers.getAddress("0x" + raw.slice(-40));
}

export interface ProxyState {
  /** Human-readable name used in logs. */
  label: string;
  /** Contract factory for the *new* implementation. */
  factoryName: string;
  address: string;
  implementation: string;
  /** Owner left behind in the Ownable namespace; zero once a proxy was never Ownable. */
  legacyOwner: string;
  /** Null while the proxy still runs a pre-roles implementation - see {getDefaultAdmin}. */
  defaultAdmin: string | null;
}

async function inspectProxy(
  hre: HardhatRuntimeEnvironment,
  label: string,
  factoryName: string,
  address: string,
): Promise<ProxyState> {
  const { ethers } = hre;
  if ((await ethers.provider.getCode(address)) === "0x") {
    throw new Error(`${label} at ${address} has no code on network "${hre.network.name}".`);
  }
  const contract = (await ethers.getContractFactory(factoryName)).attach(address);
  return {
    label,
    factoryName,
    address,
    implementation: await readAddressSlot(ethers, address, IMPLEMENTATION_SLOT),
    legacyOwner: await readAddressSlot(ethers, address, OWNABLE_STORAGE_SLOT),
    defaultAdmin: await getDefaultAdmin(contract, ethers.ZeroAddress),
  };
}

export interface ProxyAddresses {
  taskManager: string;
  acl: string;
  plaintextsStorage: string;
}

/**
 * Discovers the ACL and PlaintextsStorage proxies from the TaskManager.
 *
 * Both are public state variables on the pre-roles TaskManager too, so this works before any
 * upgrade has run and cannot point at a proxy the TaskManager is not actually using.
 */
export async function resolveProxies(
  hre: HardhatRuntimeEnvironment,
  taskManagerAddress: string,
): Promise<ProxyAddresses> {
  const { ethers } = hre;
  if ((await ethers.provider.getCode(taskManagerAddress)) === "0x") {
    throw new Error(
      `No TaskManager at ${taskManagerAddress} on network "${hre.network.name}". Pass ` +
        `--taskmanager if this deployment does not use the compiled-in address.`,
    );
  }
  const taskManager = (await ethers.getContractFactory("TaskManager")).attach(
    taskManagerAddress,
  ) as any;

  const acl = await taskManager.acl();
  const plaintextsStorage = await taskManager.plaintextsStorage();

  for (const [name, address] of [["ACL", acl], ["PlaintextsStorage", plaintextsStorage]]) {
    if (address === ethers.ZeroAddress) {
      throw new Error(
        `TaskManager at ${taskManagerAddress} reports a zero ${name} address. This deployment is ` +
          `not wired up; there is nothing to upgrade.`,
      );
    }
  }
  return { taskManager: taskManagerAddress, acl, plaintextsStorage };
}

/**
 * Reports what the migration will do, and refuses up front if the signer cannot complete it.
 *
 * The legacy-owner check matters most: `initializeV2` reverts for anyone but the owner recorded in
 * the abandoned Ownable namespace, and that revert would otherwise land mid-migration, after some
 * proxies had already moved. Checking all three before sending a transaction means a wrong key
 * costs nothing.
 */
export async function preflight(
  states: ProxyState[],
  signer: { address: string },
  adminDelay: number,
) {
  console.log(chalk.bold.blue("-----------------------Preflight----------------------------"));
  console.log(chalk.green("Signer:", signer.address));
  console.log(chalk.green("Default-admin delay to seed:", adminDelay));
  console.log("");

  for (const state of states) {
    console.log(chalk.bold(`${state.label} @ ${state.address}`));
    console.log(`  implementation : ${state.implementation}`);
    console.log(`  legacy owner   : ${state.legacyOwner}`);
    console.log(
      `  default admin  : ${state.defaultAdmin ?? chalk.yellow("none (pre-roles implementation)")}`,
    );
    console.log(
      `  action         : ${
        state.defaultAdmin === null
          ? chalk.green("upgrade + initializeV2")
          : chalk.yellow("already role-based, upgrade skipped")
      }`,
    );
  }
  console.log("");

  const pending = states.filter((state) => state.defaultAdmin === null);
  const wrongOwner = pending.filter(
    (state) => state.legacyOwner.toLowerCase() !== signer.address.toLowerCase(),
  );
  if (wrongOwner.length > 0) {
    throw new Error(
      `Refusing to migrate: initializeV2 is gated on the legacy Ownable owner, and the signer ` +
        `${signer.address} is not it for ` +
        wrongOwner.map((state) => `${state.label} (owner ${state.legacyOwner})`).join(", ") +
        `. Run this from the legacy owner key.`,
    );
  }

  // An already-migrated proxy still needs DEFAULT_ADMIN_ROLE for the follow-up grants and, on the
  // ACL, for the ACP setters. Fail here rather than after the remaining upgrades have landed.
  for (const state of states.filter((s) => s.defaultAdmin !== null)) {
    requireDefaultAdminIsSignerOrUnset(state.defaultAdmin, signer);
  }
}

/**
 * Upgrades one proxy off its pre-roles implementation, seeding AccessControl in the same
 * transaction, then grants every role the new implementation declares.
 *
 * Idempotent: a proxy that already reports a default admin has been migrated by an earlier run, so
 * only the grants are re-checked. That keeps a run resumable after a mid-migration failure.
 */
async function migrateProxy(
  hre: HardhatRuntimeEnvironment,
  state: ProxyState,
  signer: any,
  adminDelay: number,
) {
  const { ethers, upgrades } = hre as any;
  console.log(chalk.bold.blue(`-----------------------${state.label}-------------------------`));

  const factory = await ethers.getContractFactory(state.factoryName, signer);
  const proxy = factory.attach(state.address).connect(signer) as any;

  if (state.defaultAdmin !== null) {
    console.log(
      chalk.yellow(`Already role-based (default admin ${state.defaultAdmin}) - skipping upgrade`),
    );
  } else {
    const implementation = await factory.deploy();
    await implementation.waitForDeployment();
    const implementationAddress = await implementation.getAddress();
    console.log(chalk.green("New implementation deployed to:", implementationAddress));

    // Atomic: the proxy is never observable running the new implementation with an empty
    // AccessControl namespace, which is the window in which DEFAULT_ADMIN_ROLE is free for the
    // taking (the inherited _grantRole guard does not fire while defaultAdmin() is zero).
    const migrationData = factory.interface.encodeFunctionData("initializeV2", [
      signer.address,
      adminDelay,
    ]);
    const tx = await proxy.upgradeToAndCall(implementationAddress, migrationData);
    await tx.wait();

    const observed = await readAddressSlot(ethers, state.address, IMPLEMENTATION_SLOT);
    if (observed.toLowerCase() !== implementationAddress.toLowerCase()) {
      throw new Error(
        `${state.label}: upgrade reported success but the implementation slot reads ${observed}, ` +
          `expected ${implementationAddress}.`,
      );
    }
    const admin = await getDefaultAdmin(proxy, ethers.ZeroAddress);
    if (admin?.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(
        `${state.label}: upgrade landed but the default admin reads ${admin ?? "none"}, expected ` +
          `${signer.address}. initializeV2 did not run.`,
      );
    }
    console.log(chalk.green(`Upgraded ${state.label}; default admin is now ${admin}`));

    // Raw deploy + upgradeToAndCall leaves the proxy unknown to the OpenZeppelin manifest, so a
    // later `upgrades.*` call on it has nothing to diff against. Register it now that the new
    // implementation is confirmed behind the proxy - same forceImport that task:upgradeTM does
    // before validating. Only on this path: on the skip path below, the implementation was put
    // there by something else and need not match this factory, and forceImport does not check.
    //
    // Non-fatal. The migration has already landed on-chain at this point, so failing here would
    // report a successful upgrade as a failure. Note the manifest is local and gitignored - the
    // durable layout baseline is the committed storage-layout-snapshot.json.
    try {
      await upgrades.forceImport(state.address, factory, { kind: "uups" });
      console.log(chalk.dim(`Registered ${state.label} in the OpenZeppelin manifest`));
    } catch (error: any) {
      console.log(
        chalk.yellow(
          `Could not register ${state.label} in the OpenZeppelin manifest: ${error?.message ?? error}`,
        ),
      );
    }
  }

  // initializeV2 already grants the roles each implementation declares today, so this is normally
  // a no-op. It is kept so that a role added to a contract later is granted without touching this
  // task, and so a hand-run migration that skipped the grants is repaired by a re-run.
  await grantAllRoles(proxy, signer);
  console.log("");
  return proxy;
}

/**
 * Deploys the ACP infrastructure and registers it in the ACL, skipping whatever is already wired.
 *
 * Note the ACPShareRegistry initializer takes the admin only: it extends AccessControlUpgradeable,
 * not AccessControlDefaultAdminRulesUpgradeable, so there is no transfer delay to seed. Passing one
 * reverts, which is what used to break the equivalent bringup in deploy/deploy.ts.
 */
async function setupACP(hre: HardhatRuntimeEnvironment, aclProxy: any, signer: any) {
  const { ethers, upgrades } = hre as any;
  console.log(chalk.bold.blue("----------------------ACP infrastructure--------------------"));

  let revoker = await aclProxy.defaultRevokerContract();
  if (revoker === ethers.ZeroAddress) {
    const revokerFactory = await ethers.getContractFactory("ACPTimestampRevoker", signer);
    const deployed = await revokerFactory.deploy();
    await deployed.waitForDeployment();
    revoker = await deployed.getAddress();
    console.log(chalk.green("Deployed ACPTimestampRevoker to:", revoker));

    const tx = await aclProxy.connect(signer).setDefaultRevokerContract(revoker);
    await tx.wait();
    console.log(chalk.green("Set default revoker contract in ACL"));
  } else {
    console.log(chalk.yellow("ACL already has a default revoker contract:", revoker));
  }

  let shareRegistry = await aclProxy.shareRegistry();
  if (shareRegistry === ethers.ZeroAddress) {
    const registryFactory = await ethers.getContractFactory("ACPShareRegistry", signer);
    const registryProxy = await upgrades.deployProxy(registryFactory, [signer.address], {
      kind: "uups",
      initializer: "initialize",
    });
    await registryProxy.waitForDeployment();
    shareRegistry = await registryProxy.getAddress();
    console.log(chalk.green("Deployed ACPShareRegistry proxy to:", shareRegistry));
    await grantAllRoles(registryProxy, signer);

    const tx = await aclProxy.connect(signer).setShareRegistry(shareRegistry);
    await tx.wait();
    console.log(chalk.green("Set share registry in ACL"));
  } else {
    console.log(chalk.yellow("ACL already has a share registry:", shareRegistry));

    // Re-check the grants, for the same reason migrateProxy does on its own skip path: a run that
    // died between deployProxy and grantAllRoles leaves a registry with no UPGRADER_ROLE holder,
    // and skipping straight past it on the strength of the ACL pointer would report "already
    // wired" over a registry that can never be upgraded again.
    const registry = (
      await ethers.getContractFactory("ACPShareRegistry", signer)
    ).attach(shareRegistry) as any;
    if (await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), signer.address)) {
      await grantAllRoles(registry, signer);
    } else {
      // A registry wired by a different admin is not this run's to repair, and grantRole would
      // revert. Say so instead - the ACP wiring itself is present either way.
      console.log(
        chalk.yellow(
          `Signer ${signer.address} is not the share registry's admin - leaving its grants alone`,
        ),
      );
    }
  }

  console.log("");
  return { revoker, shareRegistry };
}

/**
 * Prints the resulting on-chain state, and warns about the one thing the migration can silently
 * change: `TaskManager.initializeV2` rewrites a zero `verifierSigner` / `decryptResultSigner` to
 * `address(1)`, because zero is the verification-*disabled* sentinel rather than a safe default. A
 * chain deliberately running that debug bypass comes out of the migration fail-closed and has to
 * re-set both before intake works again.
 */
async function report(hre: HardhatRuntimeEnvironment, taskManager: any, acl: any, plaintexts: any) {
  const { ethers } = hre;
  console.log(chalk.bold.blue("-----------------------Result-------------------------------"));

  for (const [label, proxy] of [
    ["TaskManager", taskManager],
    ["ACL", acl],
    ["PlaintextsStorage", plaintexts],
  ] as const) {
    const address = await proxy.getAddress();
    console.log(chalk.bold(`${label} @ ${address}`));
    console.log(`  implementation : ${await readAddressSlot(ethers, address, IMPLEMENTATION_SLOT)}`);
    console.log(`  default admin  : ${await proxy.defaultAdmin()}`);
  }

  console.log(chalk.bold("ACP"));
  console.log(`  revoker        : ${await acl.defaultRevokerContract()}`);
  console.log(`  share registry : ${await acl.shareRegistry()}`);

  console.log(chalk.bold("TaskManager configuration"));
  const verifierSigner = await taskManager.verifierSigner();
  const decryptResultSigner = await taskManager.decryptResultSigner();
  console.log(`  version        : ${await taskManager.getVersion()}`);
  console.log(`  enabled        : ${await taskManager.isEnabled()}`);
  console.log(`  verifier signer: ${verifierSigner}`);
  console.log(`  decrypt signer : ${decryptResultSigner}`);

  const sentinel = "0x0000000000000000000000000000000000000001";
  const flipped = [
    verifierSigner === sentinel ? "verifierSigner" : null,
    decryptResultSigner === sentinel ? "decryptResultSigner" : null,
  ].filter(Boolean);
  if (flipped.length > 0) {
    console.log("");
    console.log(
      chalk.bold.yellow(
        `WARNING: ${flipped.join(" and ")} now read address(1). initializeV2 found them zero - the ` +
          `verification-disabled debug sentinel - and reseeded them fail-closed. Intake will ` +
          `reject until they are set to the real signers via setVerifierSigner / ` +
          `setDecryptResultSigner.`,
      ),
    );
  }
  console.log("");
}

interface WalletFile {
  resultProcessorWallets: { privateKey: string; address: string }[];
}

/** Aggregator keys from the committed wallets.json, as candidate signers on a local stack. */
function aggregatorWallets(ethers: any): any[] {
  const path = join(__dirname, "../wallets.json");
  if (!fs.existsSync(path)) {
    return [];
  }
  const wallets = JSON.parse(fs.readFileSync(path, "utf8")) as WalletFile;
  return wallets.resultProcessorWallets.map((w) => new ethers.Wallet(w.privateKey, ethers.provider));
}

/**
 * Picks the signer to migrate with.
 *
 * `--key` is taken as given. Otherwise the legacy owner recorded on the TaskManager proxy is
 * matched against the configured signers and the committed aggregator wallets, because which
 * account deployed a given chain is not something this task can assume - deploy/deploy.ts picks
 * between the two sets at deploy time via TM_ADMIN_ADDRESS.
 *
 * `allowUnmatched` backs `--onlyvalidate`: a dry run should not need the production key in hand
 * just to check that the new implementations are upgrade-safe. With no match it falls back to the
 * legacy owner as an address-only stand-in, which is all preflight reads and all a run that sends
 * no transactions can use.
 */
async function resolveLegacySigner(
  hre: HardhatRuntimeEnvironment,
  key: string,
  taskManagerAddress: string,
  allowUnmatched = false,
) {
  const { ethers } = hre;
  if (key !== "") {
    return new Wallet(key, ethers.provider);
  }

  const legacyOwner = await readAddressSlot(ethers, taskManagerAddress, OWNABLE_STORAGE_SLOT);
  const candidates = [...(await ethers.getSigners()), ...aggregatorWallets(ethers)];
  const match = candidates.find(
    (candidate: any) => candidate.address.toLowerCase() === legacyOwner.toLowerCase(),
  );
  if (!match) {
    if (allowUnmatched) {
      console.log(
        chalk.yellow(
          `No configured signer matches the legacy owner ${legacyOwner}. Continuing read-only - ` +
            `this is enough to validate, but a real run needs --key.`,
        ),
      );
      return { address: legacyOwner };
    }
    throw new Error(
      `The TaskManager's legacy owner is ${legacyOwner}, and no configured signer matches it. ` +
        `Available: ${candidates.map((c: any) => c.address).join(", ")}. Pass --key with the ` +
        `legacy owner's private key.`,
    );
  }
  console.log(chalk.dim(`Matched legacy owner ${legacyOwner} to a configured signer`));
  return match;
}

/**
 * Runs the whole migration. Split from the task so tests can drive it against throwaway proxies.
 */
export async function migrateToRoles(
  hre: HardhatRuntimeEnvironment,
  addresses: ProxyAddresses,
  signer: any,
  adminDelay: number,
  onlyValidate = false,
) {
  const { ethers, upgrades } = hre as any;

  const states = [
    await inspectProxy(hre, "ACL", "ACL", addresses.acl),
    await inspectProxy(hre, "PlaintextsStorage", "PlaintextsStorage", addresses.plaintextsStorage),
    await inspectProxy(hre, "TaskManager", "TaskManager", addresses.taskManager),
  ];
  await preflight(states, signer, adminDelay);

  console.log(chalk.bold.blue("-----------------------Validation---------------------------"));
  for (const factoryName of ["ACL", "PlaintextsStorage", "TaskManager", "ACPShareRegistry"]) {
    await upgrades.validateImplementation(await ethers.getContractFactory(factoryName), {
      kind: "uups",
    });
    console.log(chalk.green(`${factoryName} implementation is upgrade-safe`));
  }
  // An old-vs-new storage layout diff is not available here: the deployed pre-roles artifacts are
  // no longer in the tree, and storage-layout-snapshot.json was regenerated at the role-based
  // commit, so it holds the new layout on both sides. Say so rather than imply a check that did
  // not run. The migration is layout-safe by construction - OZ 5.x puts AccessControl in its own
  // ERC-7201 namespace, and each new contract reserves the abandoned Ownable namespace explicitly.
  console.log(
    chalk.yellow(
      "Note: no old-vs-new storage layout diff was run - the deployed pre-roles artifacts are not " +
        "in this tree. The new contracts reserve the abandoned Ownable namespaces explicitly.",
    ),
  );
  console.log("");

  if (onlyValidate) {
    console.log(chalk.bold.yellow("--onlyvalidate set: no transactions sent."));
    return;
  }

  const [aclState, plaintextsState, taskManagerState] = states;

  // migrateProxy upgrades exactly when the proxy has no default admin yet, so this is also the
  // answer to "will the TaskManager implementation change in this run".
  const taskManagerWasPreRoles = taskManagerState.defaultAdmin === null;

  const acl = await migrateProxy(hre, aclState, signer, adminDelay);
  await setupACP(hre, acl, signer);
  const plaintexts = await migrateProxy(hre, plaintextsState, signer, adminDelay);
  const taskManager = await migrateProxy(hre, taskManagerState, signer, adminDelay);

  // Guarded, unlike task:upgradeTM's unconditional bump - that task always upgrades, this one is
  // resumable. `version` is a uint8 tracking the implementation generation, so bumping it on a
  // resume or repair run that upgraded nothing decouples it from the deployed implementation for
  // every off-chain consumer reading it, and walks a checked counter toward its revert ceiling.
  if (taskManagerWasPreRoles) {
    const incTx = await taskManager.incVersion();
    await incTx.wait();
    console.log(chalk.green("Bumped TaskManager version"));
  } else {
    console.log(chalk.yellow("TaskManager was already role-based - leaving its version alone"));
  }
  console.log("");

  await report(hre, taskManager, acl, plaintexts);
  return { taskManager, acl, plaintexts };
}

task("task:upgradeToRoles")
  .addParam("key", "Legacy owner private key; empty to match a configured signer", "")
  .addParam("taskmanager", "TaskManager proxy address", TASK_MANAGER_ADDRESS)
  .addParam("onlyvalidate", "Run the checks and send no transactions", false, types.boolean)
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers } = hre;

    console.log(chalk.bold.blue("-----------------------Network------------------------------"));
    console.log(chalk.green("Network name:", hre.network.name));

    // Resolve the proxies first: it verifies there is a TaskManager at this address at all, which
    // otherwise surfaces as the far more confusing "legacy owner is 0x0 and no signer matches it".
    const addresses = await resolveProxies(hre, taskArguments.taskmanager);
    const signer = await resolveLegacySigner(
      hre,
      taskArguments.key,
      taskArguments.taskmanager,
      taskArguments.onlyvalidate,
    );

    // Skipped under --onlyvalidate: funding sends a transaction, which that flag promises not to
    // do, and the stand-in signer it may have returned is an address with no key behind it anyway.
    if (hre.network.name.includes("localfhenix") && !taskArguments.onlyvalidate) {
      if ((await ethers.provider.getBalance(signer.address)).toString() === "0") {
        console.log(chalk.green("Funding account:", signer.address));
        await (hre as any).fhenixjs.getFunds(signer.address);
      }
    }
    console.log(
      chalk.green(`Balance of ${signer.address}:`, await ethers.provider.getBalance(signer.address)),
    );
    console.log("");

    await migrateToRoles(
      hre,
      addresses,
      signer,
      resolveAdminDelay(hre),
      taskArguments.onlyvalidate,
    );
  });
