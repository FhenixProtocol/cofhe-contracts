import type { OnChain } from "../../types";
import hre from "hardhat";

export async function deployOnChainFixture(): Promise<{
  testContract: OnChain;
  testContract2: OnChain2;
  address: string;
  address2: string;
}> {
  await hre.run("deploy");

  const accounts = await hre.ethers.getSigners();
  const contractOwner = accounts[0];

  const OnChain = await hre.ethers.getContractFactory("OnChain");
  const OnChain2 = await hre.ethers.getContractFactory("OnChain2");
  const testContract = await OnChain.connect(contractOwner).deploy();
  await testContract.waitForDeployment();

  const testContract2 = await OnChain2.connect(contractOwner).deploy();
  await testContract2.waitForDeployment();
  const address = await testContract.getAddress();
  const address2 = await testContract2.getAddress();

  return { testContract, testContract2, address, address2 };
}

export async function getTokensFromFaucet() {
  if (hre.network.name === "localfhenix") {
    const signers = await hre.ethers.getSigners();

    if (
      (await hre.ethers.provider.getBalance(signers[0].address)).toString() ===
      "0"
    ) {
      await hre.fhenixjs.getFunds(signers[0].address);
    }
  }
}
