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
        /^[A-Z0-9_]+_ROLE$/.test(fragment.name),
    )
    .map((fragment: any) => fragment.name);

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
