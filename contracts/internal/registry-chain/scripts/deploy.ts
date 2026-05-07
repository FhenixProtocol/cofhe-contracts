import hre from "hardhat";
import { deployUUPSProxy } from "../utils/deploy";

// OZ Relayer signer address (deterministic from dev keystore)
const DEFAULT_POSTER_ADDRESS = "0x53118C97bD4b7FdDb68244D788Ce7b2946ECd327";
const OZ_RELAYER_ADDRESS = process.env.POSTER_ADDRESS || DEFAULT_POSTER_ADDRESS;

// Commitment version to activate (must match COMMITMENT_VERSION in fhe-engine,
// currently "2"). Strings without "0x" are left-padded to bytes32, matching
// what the poster emits via parse_bytes32_padded — so the engine's "2" lands
// on-chain as 0x0000…0002.
const INITIAL_VERSION = "0x0000000000000000000000000000000000000000000000000000000000000002";

// Chain IDs to pre-activate INITIAL_VERSION on. Defaults to the local devnet
// chain so `pnpm deploy` works out of the box; CI/k8s deploys override via env.
const DEFAULT_CHAIN_IDS = "412346";
const CHAIN_IDS = (process.env.CHAIN_IDS || DEFAULT_CHAIN_IDS)
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => BigInt(s));

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!process.env.POSTER_ADDRESS) {
    console.warn(`WARNING: POSTER_ADDRESS not set, using default dev address: ${DEFAULT_POSTER_ADDRESS}`);
  }
  if (!process.env.CHAIN_IDS) {
    console.warn(`WARNING: CHAIN_IDS not set, defaulting to local devnet: ${DEFAULT_CHAIN_IDS}`);
  }
  console.log("Deploying CommitmentRegistry with account:", deployer.address);

  const { proxy: registry, address: proxyAddress } = await deployUUPSProxy(
    "CommitmentRegistry",
    [deployer.address, OZ_RELAYER_ADDRESS],
  );

  console.log("Owner:", deployer.address);
  console.log("Poster:", OZ_RELAYER_ADDRESS);

  // Activate INITIAL_VERSION on each chain. The poster will revert with
  // VersionNotActive if it tries to write for a chain that's not pre-activated
  // here, so this list must cover every chain the engine produces results for.
  for (const chainId of CHAIN_IDS) {
    const tx = await registry.setVersionStatus(chainId, INITIAL_VERSION, 1); // 1 = Active
    await tx.wait();
    console.log(`Version ${INITIAL_VERSION} activated for chainId ${chainId}`);
  }

  // Output the address in a parseable format for the deploy script
  console.log(`COMMITMENT_REGISTRY_ADDRESS=${proxyAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
