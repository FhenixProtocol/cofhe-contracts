import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { task, types } from "hardhat/config";
import chalk from "chalk";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { execTransactionThroughSafe, writeSafeBatch } from "../utils/safe";
import { MAINTENANCE_ROLES, resolveRolesByName } from "../utils/roles";
import { taskManagerAddress } from "../utils/taskManagerAddress";

const dotenvConfigPath: string = process.env.DOTENV_CONFIG_PATH || "../.env";
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) });

// The canonical TaskManager proxy - the only host-chain contract that declares these roles.
const TM_PROXY_ADDRESS = taskManagerAddress();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

/**
 * Decides who can send the role changes, and refuses when that is nobody available here.
 *
 * Both roles are administered by DEFAULT_ADMIN_ROLE, so the sender has to hold it. Before the
 * handover that is the deployer; afterwards it is the Safe, and the change has to go through it.
 */
async function resolveAuthority(
  hre: HardhatRuntimeEnvironment,
  taskManager: any,
): Promise<
  { kind: "signer"; signer: any } | { kind: "safe"; safeAddress: string; ownerSigner: any | null }
> {
  const { ethers } = hre;
  const [signer] = await ethers.getSigners();
  const defaultAdminRole = await taskManager.DEFAULT_ADMIN_ROLE();

  if (await taskManager.hasRole(defaultAdminRole, signer.address)) {
    return { kind: "signer", signer };
  }

  const safeAddress = ethers.getAddress(requireEnv("SAFE_ADMIN_ADDRESS"));
  if (!(await taskManager.hasRole(defaultAdminRole, safeAddress))) {
    const currentAdmin = await taskManager.defaultAdmin();
    throw new Error(
      `Neither the signer (${signer.address}) nor SAFE_ADMIN_ADDRESS (${safeAddress}) holds ` +
        `DEFAULT_ADMIN_ROLE on the TaskManager - it is ${currentAdmin}. Run from the account ` +
        `that does.`,
    );
  }
  const ownerKey = process.env.SAFE_OWNER_KEY?.trim();
  return {
    kind: "safe",
    safeAddress,
    ownerSigner: ownerKey ? new ethers.Wallet(ownerKey, ethers.provider) : null,
  };
}

task(
  "task:grantMaintenanceRoles",
  "Grant (or revoke) the maintenance wallet's narrow operational roles on the TaskManager",
)
  .addParam("revoke", "Revoke the roles instead of granting them", false, types.boolean)
  .addOptionalParam("out", "Path for the Safe batch file, when one is written")
  .setAction(async function (taskArguments, hre) {
    const { ethers } = hre;
    const revoke: boolean = taskArguments.revoke;
    const target = ethers.getAddress(requireEnv("MAINTENANCE_ADDRESS"));
    const verb = revoke ? "Revoking" : "Granting";

    const taskManager: any = await ethers.getContractAt("TaskManager", TM_PROXY_ADDRESS);
    console.log(chalk.green(`${verb} ${MAINTENANCE_ROLES.join(", ")} for ${target}`));
    console.log(chalk.dim(`TaskManager: ${TM_PROXY_ADDRESS} on ${hre.network.name}`));

    // Idempotent: only the roles not already in the desired state are touched, so a re-run after
    // a partially executed Safe batch finishes the job and a re-run afterwards verifies it.
    const pending: { name: string; role: string }[] = [];
    for (const { name, role } of await resolveRolesByName(taskManager, MAINTENANCE_ROLES)) {
      if ((await taskManager.hasRole(role, target)) !== revoke) {
        console.log(chalk.green(`${name}: already ${revoke ? "revoked" : "held"} - nothing to do`));
        continue;
      }
      pending.push({ name, role });
    }
    if (pending.length === 0) {
      console.log(chalk.green("Nothing to do - every role is already in the requested state."));
      return;
    }

    const authority = await resolveAuthority(hre, taskManager);
    const method = revoke ? "revokeRole" : "grantRole";

    if (authority.kind === "signer") {
      const connected = taskManager.connect(authority.signer);
      for (const { name, role } of pending) {
        const tx = await connected[method](role, target);
        await tx.wait();
        console.log(chalk.green(`${name}: ${revoke ? "revoked from" : "granted to"} ${target}`));
      }
    } else if (authority.ownerSigner) {
      console.log(
        chalk.green(
          `Executing through Safe ${authority.safeAddress} as owner ${authority.ownerSigner.address}`,
        ),
      );
      for (const { name, role } of pending) {
        const data = taskManager.interface.encodeFunctionData(method, [role, target]);
        await execTransactionThroughSafe(
          hre,
          authority.safeAddress,
          authority.ownerSigner,
          TM_PROXY_ADDRESS,
          data,
        );
        console.log(chalk.green(`${name}: ${revoke ? "revoked from" : "granted to"} ${target}`));
      }
    } else {
      const path = writeSafeBatch(hre, {
        safeAddress: authority.safeAddress,
        slug: revoke ? "revoke-maintenance-roles" : "grant-maintenance-roles",
        name: `CoFHE - ${revoke ? "revoke" : "grant"} maintenance roles`,
        description:
          `${revoke ? "Revoke" : "Grant"} ${pending.map((p) => p.name).join(" and ")} ` +
          `${revoke ? "from" : "to"} ${target} on the TaskManager at ${TM_PROXY_ADDRESS}. ` +
          `Generated by task:grantMaintenanceRoles.`,
        transactions: pending.map(({ role }) => ({
          to: TM_PROXY_ADDRESS,
          data: taskManager.interface.encodeFunctionData(method, [role, target]),
        })),
        outPath: taskArguments.out,
      });
      console.log(
        chalk.bold.blue(`\nSAFE_OWNER_KEY not set - wrote a Safe Transaction Builder batch:`),
      );
      console.log(`  ${path}`);
      for (const { name } of pending) {
        console.log(chalk.dim(`  includes: ${method}(${name}, ${target})`));
      }
      console.log(
        chalk.yellow(
          "Import it in the Safe app under Apps -> Transaction Builder, review the calls, then " +
            "sign and execute. Re-run this task afterwards to verify.",
        ),
      );
      return;
    }

    for (const { name, role } of pending) {
      if ((await taskManager.hasRole(role, target)) === revoke) {
        throw new Error(
          `${name}: the transaction executed but hasRole(${target}) is still ` +
            `${revoke ? "true" : "false"}.`,
        );
      }
    }
    console.log(chalk.green(`Done - ${target} now holds ${revoke ? "none of" : "all of"} the maintenance roles.`));
  });
