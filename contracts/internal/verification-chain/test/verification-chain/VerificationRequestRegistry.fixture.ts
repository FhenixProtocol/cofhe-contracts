import hre from "hardhat";
const { ethers } = hre;
import { BaseContract } from "ethers";

export interface VerificationRequestRegistryFixture {
  contract: BaseContract;
  owner: any;
  otherAccount: any;
}

export async function deployVerificationRequestRegistryFixture(): Promise<VerificationRequestRegistryFixture> {
  const [owner, otherAccount] = await ethers.getSigners();

  const VerificationRequestRegistry = await ethers.getContractFactory("VerificationRequestRegistry");
  const contract = await VerificationRequestRegistry.deploy();
  await contract.waitForDeployment();

  return {
    contract,
    owner,
    otherAccount,
  };
}
