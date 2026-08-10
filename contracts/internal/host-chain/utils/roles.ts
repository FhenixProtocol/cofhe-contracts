import chalk from "chalk";

/**
 * Grants every role a contract declares (any `*_ROLE` public constant in its ABI) to `adminSigner`.
 *
 * Discovering the roles from the ABI rather than listing them keeps deployments in sync with the
 * contracts: a role added to a contract is granted here without touching this file.
 *
 * DEFAULT_ADMIN_ROLE is skipped on purpose - AccessControlDefaultAdminRules reverts on granting it
 * directly, and the initial admin already holds it from `initialize`.
 *
 * @param contract    An AccessControl contract instance.
 * @param adminSigner Signer holding DEFAULT_ADMIN_ROLE, and the grantee.
 * @param log         Whether to print each grant. Off for test fixtures.
 */
export async function grantAllRoles(contract: any, adminSigner: any, log = true) {
  const grantee = adminSigner.address;
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
