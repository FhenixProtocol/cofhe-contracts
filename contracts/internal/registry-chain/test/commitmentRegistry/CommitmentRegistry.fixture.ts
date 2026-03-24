import hre from "hardhat";
const { ethers } = hre;
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
  const impl = await CommitmentRegistry.deploy();
  await impl.waitForDeployment();

  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const initData = CommitmentRegistry.interface.encodeFunctionData("initialize", [
    owner.address,
    poster.address,
  ]);
  const proxy = await ERC1967Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  const registry = CommitmentRegistry.attach(await proxy.getAddress());

  return { registry, owner, poster, otherAccount };
}
