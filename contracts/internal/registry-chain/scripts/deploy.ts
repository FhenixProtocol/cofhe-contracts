import hre from "hardhat";
import { deployUUPSProxy, grantAllRoles } from "../utils/deploy";

// OZ Relayer signer address (deterministic from dev keystore)
const DEFAULT_POSTER_ADDRESS = "0x53118C97bD4b7FdDb68244D788Ce7b2946ECd327";

// Commitment version to activate (must match COMMITMENT_VERSION in fhe-engine)
const INITIAL_VERSION = "0x0000000000000000000000000000000000000000000000000000000000000002";

/** True when deploying to a local dev chain, where the committed dev defaults are acceptable. */
function isLocalNetwork() {
  const name = hre.network.name;
  const url = (hre.network.config as any)?.url;
  if (name === "hardhat" || name === "localhost" || name.startsWith("localfhenix")) {
    return true;
  }
  return Boolean(url && (url.includes("localhost") || url.includes("127.0.0.1")));
}

/**
 * Resolves the delay enforced on default-admin handover, from `REGISTRY_ADMIN_DELAY`.
 *
 * Mirrors the host-chain guard: a zero delay makes default-admin transfers take effect
 * immediately, removing the timelock. Fine on a local stack, refused anywhere else. Blank and
 * whitespace-only count as unset rather than as zero, since `Number("")` is `0` and a set-but-empty
 * env var is common in CI and docker-compose.
 */
function resolveAdminDelay() {
  const raw = process.env.REGISTRY_ADMIN_DELAY;
  const provided = raw !== undefined && raw.trim() !== "";

  if (!provided) {
    if (!isLocalNetwork()) {
      throw new Error(
        `REGISTRY_ADMIN_DELAY must be set to a non-zero number of seconds on network ` +
          `"${hre.network.name}" (got ${raw === undefined ? "unset" : JSON.stringify(raw)}). A ` +
          `zero delay removes the default-admin transfer timelock.`,
      );
    }
    return 0;
  }

  const delay = Number(raw!.trim());
  if (!Number.isInteger(delay) || delay < 0) {
    throw new Error(
      `REGISTRY_ADMIN_DELAY must be a non-negative integer number of seconds, got ${JSON.stringify(raw)}`,
    );
  }
  if (delay === 0 && !isLocalNetwork()) {
    throw new Error(
      `REGISTRY_ADMIN_DELAY is 0 on network "${hre.network.name}". Refusing - that removes the ` +
        `default-admin transfer timelock.`,
    );
  }
  return delay;
}

/**
 * Resolves the initial poster. `DEFAULT_POSTER_ADDRESS` is derivable from the committed dev
 * keystore, so falling back to it on a public network would silently hand commitment-posting
 * rights to an account anyone can reconstruct. Require POSTER_ADDRESS off local networks.
 */
function resolvePosterAddress() {
  if (process.env.POSTER_ADDRESS) {
    return process.env.POSTER_ADDRESS;
  }
  if (!isLocalNetwork()) {
    throw new Error(
      `POSTER_ADDRESS must be set on network "${hre.network.name}". The default ` +
        `${DEFAULT_POSTER_ADDRESS} is derived from the dev keystore and must never hold ` +
        `poster rights outside a local stack.`,
    );
  }
  console.warn(`WARNING: POSTER_ADDRESS not set, using default dev address: ${DEFAULT_POSTER_ADDRESS}`);
  return DEFAULT_POSTER_ADDRESS;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const posterAddress = resolvePosterAddress();
  const adminDelay = resolveAdminDelay();
  console.log("Deploying CommitmentRegistry with account:", deployer.address);

  const { proxy: registry, address: proxyAddress } = await deployUUPSProxy(
    "CommitmentRegistry",
    [deployer.address, adminDelay, posterAddress],
  );

  console.log("Default admin:", deployer.address, "delay:", adminDelay);
  console.log("Poster:", posterAddress);

  // `initialize` only grants DEFAULT_ADMIN_ROLE. The deployer needs VERSION_MANAGER_ROLE for
  // the activation below, and UPGRADER_ROLE / POSTER_MANAGER_ROLE to operate the registry.
  await grantAllRoles(registry, deployer);

  // Activate initial version
  const tx = await registry.setVersionStatus(INITIAL_VERSION, 1); // 1 = Active
  await tx.wait();
  console.log("Version", INITIAL_VERSION, "activated");

  // Output the address in a parseable format for the deploy script
  console.log(`COMMITMENT_REGISTRY_ADDRESS=${proxyAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
