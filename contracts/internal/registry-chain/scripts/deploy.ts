import hre from "hardhat";

// OZ Relayer signer address (deterministic from dev keystore)
const OZ_RELAYER_ADDRESS = process.env.POSTER_ADDRESS || "0x3f1Eae7D46d88F08fc2F8ed27FCb2AB183EB2d0E";

// Commitment version to activate (must match COMMITMENT_VERSION in fhe-engine)
const INITIAL_VERSION = "0x0000000000000000000000000000000000000000000000000000000000000001";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying CommitmentRegistry with account:", deployer.address);

  // Deploy implementation
  const CommitmentRegistry = await hre.ethers.getContractFactory("CommitmentRegistry");
  const impl = await CommitmentRegistry.deploy();
  await impl.waitForDeployment();
  console.log("Implementation deployed to:", await impl.getAddress());

  // Deploy UUPS proxy
  const ERC1967Proxy = await hre.ethers.getContractFactory("ERC1967Proxy");
  const initData = CommitmentRegistry.interface.encodeFunctionData("initialize", [
    deployer.address,
    OZ_RELAYER_ADDRESS,
  ]);
  const proxy = await ERC1967Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  const proxyAddress = await proxy.getAddress();
  console.log("CommitmentRegistry proxy deployed to:", proxyAddress);
  console.log("Owner:", deployer.address);
  console.log("Poster:", OZ_RELAYER_ADDRESS);

  // Activate initial version
  const registry = CommitmentRegistry.attach(proxyAddress);
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
