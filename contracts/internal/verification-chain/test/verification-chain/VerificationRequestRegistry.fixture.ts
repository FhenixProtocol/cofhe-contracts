import hre from "hardhat";
const { ethers } = hre;
import { BaseContract } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

export interface VerificationRequestRegistryFixture {
  contract: BaseContract;
  owner: HardhatEthersSigner;
  otherAccount: HardhatEthersSigner;
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
