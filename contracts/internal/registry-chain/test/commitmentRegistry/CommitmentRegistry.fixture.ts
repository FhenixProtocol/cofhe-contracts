import hre from "hardhat";
const { ethers } = hre;
import { upgrades } from "hardhat";
import { BaseContract } from "ethers";

export interface CommitmentRegistryFixture {
  registry: BaseContract;
  owner: any;
  poster: any;
  otherAccount: any;
}

export async function deployCommitmentRegistryFixture(): Promise<CommitmentRegistryFixture> {
  const [owner, poster, otherAccount] = await ethers.getSigners();

  const CommitmentRegistry = await ethers.getContractFactory("CommitmentRegistry");
  const deployed = await upgrades.deployProxy(
    CommitmentRegistry,
    [owner.address, poster.address],
    { kind: "uups", initializer: "initialize" },
  );
  const registry = await deployed.waitForDeployment();

  return { registry, owner, poster, otherAccount };
}
