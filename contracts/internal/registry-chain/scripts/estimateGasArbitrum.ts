import hre from "hardhat";
const { ethers, upgrades } = hre;

const NODE_INTERFACE_ADDRESS = "0x00000000000000000000000000000000000000C8";
const NODE_INTERFACE_ABI = [
  "function gasEstimateComponents(address to, bool contractCreation, bytes calldata data) external payable returns (uint64 gasEstimate, uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
];

function randomBytes32(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

async function main() {
  const [signer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(signer.address);
  console.log(`\nDeployer: ${signer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error("\nNo balance! Fund this address with Arbitrum Sepolia ETH first.");
    process.exit(1);
  }

  // Deploy
  console.log("\n--- Deploying CommitmentRegistry ---");
  const Factory = await ethers.getContractFactory("CommitmentRegistry");
  const proxy = await upgrades.deployProxy(Factory, [signer.address, signer.address], {
    kind: "uups",
    initializer: "initialize",
  });
  await proxy.waitForDeployment();
  const registryAddress = await proxy.getAddress();
  console.log(`Deployed at: ${registryAddress}`);

  // Activate a version on the gas-test chain
  const version = ethers.keccak256(ethers.toUtf8Bytes("gas-test-v1"));
  const chainId = 42161n; // Arbitrum One — purely cosmetic for gas estimation
  const tx = await proxy.setVersionStatus(chainId, version, 1); // Active
  await tx.wait();
  console.log("Version activated");

  // NodeInterface for L1+L2 gas estimation
  const nodeInterface = new ethers.Contract(NODE_INTERFACE_ADDRESS, NODE_INTERFACE_ABI, signer);

  const batchSizes = [1, 10, 25, 50, 100];

  console.log("\n--- Gas Estimation (L1 + L2) ---\n");
  console.log(
    "| Batch Size | Total Gas | L1 Gas | L2 Gas | L1 Base Fee (gwei) | Est. L1 Cost (ETH) | Est. Total Cost (ETH) |"
  );
  console.log(
    "|------------|-----------|--------|--------|--------------------|--------------------|----------------------|"
  );

  for (const size of batchSizes) {
    const handles = Array.from({ length: size }, () => randomBytes32());
    const commitHashes = Array.from({ length: size }, () => randomBytes32());

    // Encode the calldata
    const calldata = proxy.interface.encodeFunctionData("postCommitments", [chainId, version, handles, commitHashes]);

    try {
      // Get gas components from Arbitrum's NodeInterface
      const [gasEstimate, gasEstimateForL1, baseFee, l1BaseFeeEstimate] =
        await nodeInterface.gasEstimateComponents.staticCall(registryAddress, false, calldata);

      const totalGas = Number(gasEstimate);
      const l1Gas = Number(gasEstimateForL1);
      const l2Gas = totalGas - l1Gas;
      const l1BaseFeeGwei = Number(l1BaseFeeEstimate) / 1e9;
      const baseFeeWei = Number(baseFee);

      // Estimate costs
      const l1CostWei = BigInt(l1Gas) * l1BaseFeeEstimate;
      const totalCostWei = BigInt(totalGas) * baseFee;
      const l1CostEth = Number(l1CostWei) / 1e18;
      const totalCostEth = Number(totalCostWei) / 1e18;

      console.log(
        `| ${String(size).padStart(10)} | ${String(totalGas).padStart(9)} | ${String(l1Gas).padStart(6)} | ${String(l2Gas).padStart(6)} | ${l1BaseFeeGwei.toFixed(4).padStart(18)} | ${l1CostEth.toFixed(10).padStart(18)} | ${totalCostEth.toFixed(10).padStart(20)} |`
      );
    } catch (e: any) {
      console.log(`| ${String(size).padStart(10)} | ERROR: ${e.message?.slice(0, 60)} |`);
    }
  }

  // Also do a real tx for batch of 10 to get actual receipt gas
  console.log("\n--- Actual Transaction (batch of 10) ---\n");
  const handles10 = Array.from({ length: 10 }, () => randomBytes32());
  const commitHashes10 = Array.from({ length: 10 }, () => randomBytes32());
  const realTx = await proxy.postCommitments(chainId, version, handles10, commitHashes10);
  const receipt = await realTx.wait();
  const gasUsed = receipt!.gasUsed;
  const effectiveGasPrice = receipt!.gasPrice;
  const actualCost = gasUsed * effectiveGasPrice;

  console.log(`Gas used: ${gasUsed}`);
  console.log(`Effective gas price: ${ethers.formatUnits(effectiveGasPrice, "gwei")} gwei`);
  console.log(`Actual cost: ${ethers.formatEther(actualCost)} ETH`);

  // ETH price placeholder
  const ethPrices = [2000, 2500, 3000];
  console.log("\n--- USD Cost Estimates (batch of 10, actual tx) ---\n");
  for (const price of ethPrices) {
    const usd = Number(ethers.formatEther(actualCost)) * price;
    console.log(`  ETH @ $${price}: $${usd.toFixed(6)} per batch of 10 ($${(usd / 10).toFixed(6)} per commitment)`);
  }

  // Monthly projections
  console.log("\n--- Monthly Cost Projections (based on actual tx) ---\n");
  const costPerCommitment = Number(ethers.formatEther(actualCost)) / 10;
  for (const dailyCTs of [100_000, 500_000]) {
    for (const price of [2000, 2500]) {
      const monthly = costPerCommitment * dailyCTs * 30 * price;
      console.log(`  ${(dailyCTs / 1000).toFixed(0)}K CTs/day, ETH @ $${price}: $${monthly.toFixed(2)}/month`);
    }
  }

  console.log("\nDone!");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
