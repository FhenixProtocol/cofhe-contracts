import chalk from "chalk";
import { task, types } from "hardhat/config";
import type { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";
import { Contract, Wallet } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { resolveTaskManager } from "../utils/addressBook";
import { execTransactionThroughSafe, writeSafeBatch } from "../utils/safe";

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** The first version's `Shared` event: the recipient is its first indexed topic. */
const V1_SHARED = "event Shared(address indexed recipient, address indexed issuer, bytes32 shareId)";

type Call = { to: string; data: string; label: string };

async function implementationOf(ethers: any, proxy: string): Promise<string> {
  return ethers.getAddress("0x" + (await ethers.provider.getStorage(proxy, IMPLEMENTATION_SLOT)).slice(-40));
}

/**
 * Whether the proxy already runs the pointer-based implementation (a resumed run: only migration
 * pages remain), told by `migrateV1Shares` in its function dispatcher (`PUSH4 <selector>`). The
 * code itself never equals the artifact: UUPSUpgradeable keeps the implementation's own address
 * as an immutable.
 */
async function runsPointerImplementation(ethers: any, proxy: string, Factory: any): Promise<boolean> {
  const selector: string = Factory.interface.getFunction("migrateV1Shares").selector;
  const code: string = await ethers.provider.getCode(await implementationOf(ethers, proxy));
  return code.toLowerCase().includes("63" + selector.slice(2).toLowerCase());
}

/** The first block with code at `address`: a binary search, about 30 calls. */
async function deployBlockOf(ethers: any, address: string): Promise<number> {
  let lo = 0;
  let hi = await ethers.provider.getBlockNumber();
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await ethers.provider.getCode(address, mid);
    if (code !== "0x") hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The recipients of first-version shares, from its `Shared` events. Pages the log query, halving
 * the range whenever the node refuses one.
 */
async function v1Recipients(ethers: any, registry: string, fromBlock: number): Promise<string[]> {
  const iface = new ethers.Interface([V1_SHARED]);
  const topic = iface.getEvent("Shared").topicHash;
  const latest = await ethers.provider.getBlockNumber();
  const recipients = new Set<string>();
  let step = 50_000;
  for (let from = fromBlock; from <= latest; ) {
    const to = Math.min(from + step - 1, latest);
    try {
      const logs = await ethers.provider.getLogs({ address: registry, topics: [topic], fromBlock: from, toBlock: to });
      for (const log of logs) recipients.add(ethers.getAddress(ethers.dataSlice(log.topics[1], 12)));
      from = to + 1;
    } catch (error) {
      if (step <= 100) throw error;
      step = Math.floor(step / 2);
    }
  }
  return [...recipients];
}

/** Of `recipients`, those the first version still lists live shares for (`sharesFor` filters expiry and revocation). */
async function withLiveV1Shares(ethers: any, registry: string, recipients: string[]): Promise<string[]> {
  const V1 = await ethers.getContractFactory("ACPShareRegistryV1");
  const v1 = V1.attach(registry);
  const live: string[] = [];
  for (const recipient of recipients) {
    const shares = await v1.sharesFor(recipient);
    if (shares.length > 0) {
      live.push(recipient);
      console.log(chalk.dim(`  ${recipient}: ${shares.length} live v1 share(s)`));
    }
  }
  return live;
}

function pages<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The calls of the upgrade: `upgradeToAndCall(impl, migrateV1Shares(first page))` (or with no call
 * when nothing needs migrating), then one `migrateV1Shares(page)` per further page. On a resumed
 * run (the proxy already on this implementation) only the migration calls.
 */
function upgradeCalls(
  Factory: any,
  proxy: string,
  newImplementation: string | null,
  recipientPages: string[][],
): Call[] {
  const migrate = (page: string[]) => Factory.interface.encodeFunctionData("migrateV1Shares", [page]);
  const calls: Call[] = [];
  let rest = recipientPages;
  if (newImplementation !== null) {
    const [first, ...others] = recipientPages;
    calls.push({
      to: proxy,
      data: Factory.interface.encodeFunctionData("upgradeToAndCall", [newImplementation, first ? migrate(first) : "0x"]),
      label: first
        ? `upgradeToAndCall(${newImplementation}, migrateV1Shares(${first.length} recipients))`
        : `upgradeToAndCall(${newImplementation}, 0x)`,
    });
    rest = others;
  }
  for (const page of rest) {
    calls.push({ to: proxy, data: migrate(page), label: `migrateV1Shares(${page.length} recipients)` });
  }
  return calls;
}

/**
 * Who sends the calls: the signer when it holds UPGRADER_ROLE, otherwise the Safe at
 * SAFE_ADMIN_ADDRESS, which must hold it (the post-handover flow, as in task:upgradeACL).
 */
async function resolveSender(ethers: any, registry: any, signer: any): Promise<{ safe: string | null }> {
  const upgraderRole = await registry.UPGRADER_ROLE();
  if (await registry.hasRole(upgraderRole, signer.address)) return { safe: null };
  const rawSafe = process.env.SAFE_ADMIN_ADDRESS?.trim();
  if (!rawSafe) {
    throw new Error(
      `Refusing to upgrade ACPShareRegistry: the signer ${signer.address} lacks UPGRADER_ROLE and ` +
        `SAFE_ADMIN_ADDRESS is unset. Run as the upgrader, or set SAFE_ADMIN_ADDRESS to the Safe holding the role.`,
    );
  }
  const safe = ethers.getAddress(rawSafe);
  if (!(await registry.hasRole(upgraderRole, safe))) {
    throw new Error(`Refusing to upgrade ACPShareRegistry: ${safe} does not hold UPGRADER_ROLE.`);
  }
  return { safe };
}

async function sendCalls(hre: HardhatRuntimeEnvironment, calls: Call[], signer: any, safe: string | null, proxy: string) {
  const { ethers } = hre;
  if (safe === null) {
    for (const call of calls) {
      await (await signer.sendTransaction({ to: call.to, data: call.data })).wait();
      console.log(chalk.green(`Sent ${call.label}`));
    }
    return;
  }

  const ownerKey = process.env.SAFE_OWNER_KEY?.trim();
  if (ownerKey) {
    const ownerSigner = new Wallet(ownerKey, ethers.provider);
    // An EOA final admin (testnets) sends directly: SAFE_OWNER_KEY is then its own key.
    const sendsDirectly = ownerSigner.address.toLowerCase() === safe.toLowerCase();
    for (const call of calls) {
      if (sendsDirectly) {
        await (await ownerSigner.sendTransaction({ to: call.to, data: call.data })).wait();
      } else {
        await execTransactionThroughSafe(hre, safe, ownerSigner, call.to, call.data);
      }
      console.log(chalk.green(`Sent ${call.label} as ${safe}`));
    }
    return;
  }

  const path = writeSafeBatch(hre, {
    safeAddress: safe,
    slug: "upgrade-share-registry",
    name: "CoFHE - upgrade ACPShareRegistry",
    description:
      `Upgrade the ACPShareRegistry proxy ${proxy} in place and migrate its first-version shares ` +
      `(${calls.length} transaction(s)). Generated by task:upgradeShareRegistry.`,
    transactions: calls.map(({ to, data }) => ({ to, data })),
  });
  console.log(chalk.bold.blue("\nWrote a Safe Transaction Builder batch:"));
  console.log(`  ${path}`);
  console.log(chalk.dim("Import it under Apps -> Transaction Builder in the Safe app, review, sign, execute."));
  for (const call of calls) console.log(`  ${call.label}\n    to: ${call.to}\n    data: ${call.data}`);
}

task("task:upgradeShareRegistry", "Upgrade the ACL's ACPShareRegistry in place and migrate its first-version shares")
  .addParam("key", "Signer key (default: the third configured account, as the other upgrade tasks)", "")
  .addParam("onlyvalidate", "Only validate the storage layout", false, types.boolean)
  .addParam("recipients", "Comma-separated recipients to migrate, instead of collecting them from v1 Shared events", "")
  .addParam("fromblock", "First block to scan for v1 Shared events (default: the registry's deploy block)", -1, types.int)
  .addParam("pagesize", "Recipients per migrateV1Shares call", 10, types.int)
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, upgrades } = hre;
    const signer: HardhatEthersSigner =
      taskArguments.key === ""
        ? (await ethers.getSigners())[2]
        : (new Wallet(taskArguments.key).connect(ethers.provider) as unknown as HardhatEthersSigner);
    console.log(chalk.green("Network:", hre.network.name, "signer:", signer.address));

    const taskManagerAddress = await resolveTaskManager(hre);
    const taskManager: any = await ethers.getContractAt("TaskManager", taskManagerAddress);
    const acl: any = await ethers.getContractAt("ACL", await taskManager.acl());
    const proxy: string = await acl.shareRegistry();
    if (proxy === ethers.ZeroAddress) {
      throw new Error(`ACL ${await acl.getAddress()} serves no share registry (shareRegistry() is zero).`);
    }
    console.log(chalk.green("TaskManager:", taskManagerAddress));
    console.log(chalk.green("ACPShareRegistry proxy:", proxy));
    console.log(chalk.green("Current implementation:", await implementationOf(ethers, proxy)));

    const Factory = await ethers.getContractFactory("ACPShareRegistry");
    const registry = Factory.attach(proxy) as Contract;
    const alreadyUpgraded = await runsPointerImplementation(ethers, proxy, Factory);

    if (alreadyUpgraded) {
      console.log(chalk.yellow("The proxy already runs this implementation: only migration calls will be sent."));
    } else {
      // Import the layout the proxy runs now (the first version), then check this one against it.
      const V1 = await ethers.getContractFactory("ACPShareRegistryV1");
      await upgrades.forceImport(proxy, V1, { kind: "uups" });
      await upgrades.validateUpgrade(proxy, Factory, { kind: "uups" });
      console.log(chalk.green("✅ Storage layout is compatible with the first version"));
    }
    if (taskArguments.onlyvalidate) return;

    let recipients: string[];
    if (taskArguments.recipients !== "") {
      recipients = String(taskArguments.recipients)
        .split(",")
        .map((r) => ethers.getAddress(r.trim()));
    } else {
      const fromBlock =
        taskArguments.fromblock >= 0 ? Number(taskArguments.fromblock) : await deployBlockOf(ethers, proxy);
      console.log(chalk.green(`Collecting v1 recipients from block ${fromBlock}...`));
      recipients = await v1Recipients(ethers, proxy, fromBlock);
      console.log(chalk.green(`${recipients.length} recipient(s) of v1 shares`));
    }
    // Before the upgrade the first version can say who still has live shares; after it, migrate
    // every candidate (a recipient without v1 shares costs one empty iteration).
    if (!alreadyUpgraded) recipients = await withLiveV1Shares(ethers, proxy, recipients);
    console.log(chalk.green(`${recipients.length} recipient(s) to migrate`));

    const { safe } = await resolveSender(ethers, registry, signer);
    let newImplementation: string | null = null;
    if (!alreadyUpgraded) {
      const implementation = await Factory.connect(signer).deploy();
      await implementation.waitForDeployment();
      newImplementation = await implementation.getAddress();
      console.log(chalk.green("New implementation:", newImplementation));
    }

    const calls = upgradeCalls(Factory, proxy, newImplementation, pages(recipients, taskArguments.pagesize));
    if (calls.length === 0) {
      console.log(chalk.green("Nothing to do."));
      return;
    }
    await sendCalls(hre, calls, signer, safe, proxy);

    if (safe === null || process.env.SAFE_OWNER_KEY?.trim()) {
      console.log(chalk.green("Implementation now:", await implementationOf(ethers, proxy)));
      let total = 0;
      for (const recipient of recipients) total += (await registry.sharesFor(recipient))[0].length;
      console.log(chalk.green(`Live shares of the migrated recipients: ${total}`));
    }
  });
