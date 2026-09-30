import hre from "hardhat";
import { renounceAllRoles } from "../utils/deploy";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

/**
 * Renounces every operational role the deployer still holds on the CommitmentRegistry, once the
 * Safe is its default admin. Mirrors the host-chain `task:renounceDeployerRoles`.
 */
async function main() {
  const { ethers } = hre;
  const registryAddress = ethers.getAddress(requireEnv("COMMITMENT_REGISTRY_ADDRESS"));
  const safeAddress = ethers.getAddress(requireEnv("SAFE_ADMIN_ADDRESS"));
  const [signer] = await ethers.getSigners();
  console.log(`Renouncing roles held by ${signer.address}`);

  const registry = await ethers.getContractAt("CommitmentRegistry", registryAddress);
  const currentAdmin: string = await registry.defaultAdmin();
  // Renouncing before the Safe holds DEFAULT_ADMIN would leave the registry with an admin that
  // has no operational roles and no one else who does - refuse.
  if (currentAdmin.toLowerCase() !== safeAddress.toLowerCase()) {
    throw new Error(
      `CommitmentRegistry (${registryAddress}): default admin is ${currentAdmin}, not the Safe. ` +
        `Run scripts/acceptAdminAsSafe.ts first - renouncing now could leave the registry unmanageable.`,
    );
  }
  await renounceAllRoles(registry, signer);
  console.log("Done - the Safe is the default admin and sole role holder.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
