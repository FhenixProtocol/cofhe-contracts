import hre from "hardhat";
import { deployUUPSProxy } from "../utils/deploy";

// OZ Relayer signer address (deterministic from dev keystore)
const DEFAULT_POSTER_ADDRESS = "0x53118C97bD4b7FdDb68244D788Ce7b2946ECd327";
const OZ_RELAYER_ADDRESS = process.env.POSTER_ADDRESS || DEFAULT_POSTER_ADDRESS;

// Commitment version to activate (must match COMMITMENT_VERSION in fhe-engine)
const INITIAL_VERSION = "0x0000000000000000000000000000000000000000000000000000000000000001";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!process.env.POSTER_ADDRESS) {
    console.warn(`WARNING: POSTER_ADDRESS not set, using default dev address: ${DEFAULT_POSTER_ADDRESS}`);
  }
  console.log("Deploying CommitmentRegistry with account:", deployer.address);

  const { proxy: registry, address: proxyAddress } = await deployUUPSProxy(
    "CommitmentRegistry",
    [deployer.address, OZ_RELAYER_ADDRESS],
  );

  console.log("Owner:", deployer.address);
  console.log("Poster:", OZ_RELAYER_ADDRESS);

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
