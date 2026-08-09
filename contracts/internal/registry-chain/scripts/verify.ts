import hre from "hardhat";

// The deployed address is published to commitment-registry-address.txt at deploy time;
// pass it in via COMMITMENT_REGISTRY_ADDRESS. OpenZeppelin's verify override verifies the
// implementation and links the proxy ABI in a single call.
async function main() {
  const address = process.env.COMMITMENT_REGISTRY_ADDRESS;
  if (!address) {
    throw new Error("COMMITMENT_REGISTRY_ADDRESS is not set");
  }

  await hre.run("verify:verify", { address, constructorArguments: [] });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
