import chalk from "chalk";

/**
 * Grants every role a contract declares (any `*_ROLE` public constant in its ABI) to `account`.
 *
 * Discovering the roles from the ABI rather than listing them keeps deployments in sync with the
 * contracts: a role added to a contract is granted here without touching this file.
 *
 * DEFAULT_ADMIN_ROLE is skipped on purpose - AccessControlDefaultAdminRules reverts on granting it
 * directly, and the initial admin already holds it from `initialize`.
 *
 * Keep the signature in sync with the sibling copy in `registry-chain/utils/deploy.ts` - the two
 * hardhat projects have no shared package, so this is duplicated on purpose.
 *
 * @param contract    An AccessControl contract instance.
 * @param adminSigner Signer holding DEFAULT_ADMIN_ROLE; also the grantee unless `account` is set.
 * @param account     Optional grantee, defaults to `adminSigner.address`.
 * @param log         Whether to print each grant. Off for test fixtures.
 */
export async function grantAllRoles(
  contract: any,
  adminSigner: any,
  account?: string,
  log = true,
) {
  const grantee = account ?? adminSigner.address;
  const connectedContract = contract.connect(adminSigner);
  const defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE();

  const roleNames: string[] = contract.interface.fragments
    .filter(
      (fragment: any) =>
        fragment.type === "function" &&
        fragment.inputs.length === 0 &&
        /^[A-Z0-9_]+_ROLE$/.test(fragment.name) &&
        fragment.name !== "DEFAULT_ADMIN_ROLE",
    )
    .map((fragment: any) => fragment.name);

  // Discovering roles from the ABI means an ABI that no longer exposes them - a stale typechain
  // build, the wrong factory, a renamed constant - silently grants nothing and returns success,
  // leaving the proxy with no UPGRADER_ROLE holder and a clean deploy log. Fail loudly instead.
  // DEFAULT_ADMIN_ROLE is excluded from this count on purpose: it always matches the *_ROLE
  // pattern via the inherited AccessControl getter, so counting it made this guard unreachable -
  // an ABI missing every grantable role (e.g. UPGRADER_ROLE) still passed with length 1.
  if (roleNames.length === 0) {
    throw new Error(
      `grantAllRoles found no grantable *_ROLE constants on this contract's ABI (excluding ` +
        `DEFAULT_ADMIN_ROLE), so it would grant nothing. Expected at least UPGRADER_ROLE. ` +
        `Recompile, or check the factory being passed in.`,
    );
  }

  for (const roleName of roleNames) {
    const role = await contract[roleName]();
    if (role === defaultAdminRole || (await contract.hasRole(role, grantee))) {
      continue;
    }
    const tx = await connectedContract.grantRole(role, grantee);
    await tx.wait();
    if (log) {
      console.log(chalk.green(`Granted ${roleName} to ${grantee}`));
    }
  }
}

/**
 * The roles the maintenance wallet holds on the TaskManager.
 *
 * Both are narrow by design - see the role notes at the top of TaskManager.sol: their worst case
 * is availability (halting intake, or moving the security-zone bounds), not disclosure. The four
 * admin-equivalent roles (UPGRADER, CONFIG_MANAGER, VERIFIER_SIGNER_MANAGER,
 * DECRYPT_SIGNER_MANAGER) are deliberately absent - those belong with DEFAULT_ADMIN on the Safe.
 */
export const MAINTENANCE_ROLES = ["PAUSER_ROLE", "SECURITY_ZONE_MANAGER_ROLE"] as const;

/**
 * Resolves role names to their on-chain `bytes32` values.
 *
 * Throws when the ABI does not declare one, rather than skipping it: a stale build or the wrong
 * contract would otherwise silently drop a role from a grant, leaving the grantee with less than
 * it is supposed to have and a clean log - the same failure `grantAllRoles` guards against.
 *
 * @param contract  An AccessControl contract instance.
 * @param roleNames The `*_ROLE` constant names to resolve.
 */
export async function resolveRolesByName(
  contract: any,
  roleNames: readonly string[],
): Promise<{ name: string; role: string }[]> {
  const resolved: { name: string; role: string }[] = [];
  for (const name of roleNames) {
    if (typeof contract[name] !== "function") {
      throw new Error(
        `${name} is not declared on this contract's ABI, so it cannot be granted or revoked. ` +
          `Recompile, or check the contract being passed in.`,
      );
    }
    resolved.push({ name, role: await contract[name]() });
  }
  return resolved;
}

/**
 * Grants named roles to `grantee`, skipping any it already holds.
 *
 * Idempotent, so a re-run after a partially applied grant costs nothing and reports the final
 * state. `adminSigner` must hold DEFAULT_ADMIN_ROLE - every role in {@link MAINTENANCE_ROLES} is
 * administered by it.
 *
 * @param contract    An AccessControl contract instance.
 * @param adminSigner Signer holding DEFAULT_ADMIN_ROLE; sends the grants.
 * @param grantee     The account receiving the roles.
 * @param roleNames   The `*_ROLE` constant names to grant.
 * @param log         Whether to print each grant.
 */
export async function grantRolesByName(
  contract: any,
  adminSigner: any,
  grantee: string,
  roleNames: readonly string[],
  log = true,
) {
  const connectedContract = contract.connect(adminSigner);
  for (const { name, role } of await resolveRolesByName(contract, roleNames)) {
    if (await contract.hasRole(role, grantee)) {
      if (log) {
        console.log(chalk.dim(`${grantee} already holds ${name}`));
      }
      continue;
    }
    const tx = await connectedContract.grantRole(role, grantee);
    await tx.wait();
    if (log) {
      console.log(chalk.green(`Granted ${name} to ${grantee}`));
    }
  }
}

/**
 * Renounces every role the signer holds on the contract - the mirror of `grantAllRoles`, with
 * the same ABI-driven role discovery. DEFAULT_ADMIN_ROLE is excluded on purpose: it leaves via
 * the two-step default-admin transfer, not via renounce.
 *
 * @param contract An AccessControl contract instance.
 * @param signer   The account renouncing its own roles.
 * @param log      Whether to print each renounce.
 */
export async function renounceAllRoles(contract: any, signer: any, log = true) {
  const connectedContract = contract.connect(signer);
  const defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE();

  const roleNames: string[] = contract.interface.fragments
    .filter(
      (fragment: any) =>
        fragment.type === "function" &&
        fragment.inputs.length === 0 &&
        /^[A-Z0-9_]+_ROLE$/.test(fragment.name) &&
        fragment.name !== "DEFAULT_ADMIN_ROLE",
    )
    .map((fragment: any) => fragment.name);

  for (const roleName of roleNames) {
    const role = await contract[roleName]();
    if (role === defaultAdminRole || !(await contract.hasRole(role, signer.address))) {
      continue;
    }
    const tx = await connectedContract.renounceRole(role, signer.address);
    await tx.wait();
    if (log) {
      console.log(chalk.yellow(`Renounced ${roleName} from ${signer.address}`));
    }
  }
}

/**
 * Returns the proxy's current default admin, or null when the proxy has no AccessControl storage
 * yet - either because it still runs a pre-roles (Ownable) implementation, which has no
 * `defaultAdmin()` selector at all, or because it was upgraded without running initializeV2.
 */
export async function getDefaultAdmin(proxy: any, zeroAddress: string): Promise<string | null> {
  try {
    const defaultAdmin = await proxy.defaultAdmin();
    return defaultAdmin === zeroAddress ? null : defaultAdmin;
  } catch {
    return null;
  }
}

/**
 * True when the target network is a local dev chain, where the dev defaults (zero
 * signers, zero admin delay, the .env AGGREGATOR_KEY wallet) are acceptable.
 */
export function isLocalNetwork(hre: any) {
  const name: string | undefined = hre?.network?.name;
  const url: string | undefined = (hre?.network?.config as any)?.url;
  if (name === "hardhat" || name === "localhost" || name?.startsWith("localfhenix")) {
    return true;
  }
  return Boolean(url && (url.includes("localhost") || url.includes("127.0.0.1")));
}

/**
 * Resolves the default-admin transfer delay from `TM_ADMIN_DELAY`.
 *
 * A zero delay makes default-admin transfers take effect immediately, removing the timelock the
 * contract exists to enforce, so off a local network the value must be stated explicitly. Blank and
 * whitespace-only are treated as unset rather than as zero: `TM_ADMIN_DELAY=""` is common in CI and
 * docker-compose, and `Number("")` is `0`, so accepting it would hand a production deploy exactly
 * the delay this guard exists to prevent.
 */
export function resolveAdminDelay(hre: any): number {
  const raw = process.env.TM_ADMIN_DELAY;
  const provided = raw !== undefined && raw.trim() !== "";

  if (!provided) {
    if (!isLocalNetwork(hre)) {
      throw new Error(
        `TM_ADMIN_DELAY must be set to a non-zero number of seconds on network ` +
          `"${hre?.network?.name}" (got ${raw === undefined ? "unset" : JSON.stringify(raw)}). A ` +
          `zero delay makes default-admin transfers take effect immediately, removing the ` +
          `timelock AccessControlDefaultAdminRules exists to enforce.`,
      );
    }
    return 0;
  }

  const delay = Number(raw!.trim());
  if (!Number.isInteger(delay) || delay < 0) {
    throw new Error(
      `TM_ADMIN_DELAY must be a non-negative integer number of seconds, got ${JSON.stringify(raw)}`,
    );
  }
  if (delay === 0 && !isLocalNetwork(hre)) {
    throw new Error(
      `TM_ADMIN_DELAY is 0 on network "${hre?.network?.name}". Refusing - that removes the ` +
        `default-admin transfer timelock. Set a non-zero delay, or deploy to a local network.`,
    );
  }
  return delay;
}

/**
 * Throws unless the proxy's default admin is unset (pre-roles proxy, about to be migrated) or is
 * `signer` itself.
 *
 * Upgrading and granting roles need different roles - UPGRADER_ROLE and DEFAULT_ADMIN_ROLE - so a
 * signer holding only the former gets halfway: the implementation swaps, then `grantAllRoles`
 * reverts. That leaves the proxy on new code with no operational roles. Check before the swap.
 */
export function requireDefaultAdminIsSignerOrUnset(
  currentDefaultAdmin: string | null,
  signer: { address: string },
) {
  if (
    currentDefaultAdmin !== null &&
    currentDefaultAdmin.toLowerCase() !== signer.address.toLowerCase()
  ) {
    throw new Error(
      `Refusing to upgrade: default admin is ${currentDefaultAdmin}, but the signer is ` +
        `${signer.address}. The upgrade would succeed and the subsequent role grants would ` +
        `revert, leaving the proxy on the new implementation without operational roles. Run ` +
        `this from the default admin, or split the upgrade and the grants into separate ` +
        `admin-signed steps.`,
    );
  }
}
