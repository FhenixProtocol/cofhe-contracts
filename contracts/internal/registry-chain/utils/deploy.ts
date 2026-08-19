import { ethers, upgrades } from "hardhat";
import { Contract } from "ethers";

/**
 * Deploys a UUPS proxy for the given contract.
 * @param contractName The contract to deploy behind a proxy
 * @param initArgs Arguments passed to the initialize function
 * @returns The proxy contract instance and its address
 */
export async function deployUUPSProxy(
  contractName: string,
  initArgs: unknown[],
): Promise<{ proxy: Contract; address: string }> {
  const factory = await ethers.getContractFactory(contractName);
  const deployed = await upgrades.deployProxy(factory, initArgs, {
    kind: "uups",
    initializer: "initialize",
  });
  const proxy = (await deployed.waitForDeployment()) as unknown as Contract;
  const address = await proxy.getAddress();
  console.log(`Deployed ${contractName} proxy to: ${address}`);
  return { proxy, address };
}

/**
 * Grants every role a contract declares (any `*_ROLE` public constant in its ABI) to `account`.
 *
 * Discovering the roles from the ABI rather than listing them keeps the deployment in sync
 * with the contracts: a role added to a contract is granted here without touching this file.
 *
 * DEFAULT_ADMIN_ROLE is skipped on purpose - AccessControlDefaultAdminRules reverts on granting
 * it directly, and the initial admin already holds it from `initialize`.
 *
 * Keep the signature in sync with the sibling copy in `host-chain/utils/roles.ts` - the two
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

  // Discovering roles from the ABI means an ABI that no longer exposes them - a stale typechain
  // build, the wrong factory, a renamed constant - silently grants nothing and returns success,
  // leaving the proxy with no UPGRADER_ROLE holder and a clean deploy log. Fail loudly instead.
  if (roleNames.length === 0) {
    throw new Error(
      `grantAllRoles found no *_ROLE constants on this contract's ABI, so it would grant nothing. ` +
        `Expected at least UPGRADER_ROLE. Recompile, or check the factory being passed in.`,
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
      console.log(`Granted ${roleName} to ${grantee}`);
    }
  }
}
