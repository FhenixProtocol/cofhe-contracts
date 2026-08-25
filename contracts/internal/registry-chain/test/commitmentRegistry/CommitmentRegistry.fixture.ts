import hre from "hardhat";
const { ethers } = hre;
import { upgrades } from "hardhat";
import { BaseContract } from "ethers";

import { grantAllRoles } from "../../utils/deploy";

export interface CommitmentRegistryFixture {
  registry: BaseContract;
  admin: any;
  poster: any;
  otherAccount: any;
}

export async function deployCommitmentRegistryFixture(): Promise<CommitmentRegistryFixture> {
  const [admin, poster, otherAccount] = await ethers.getSigners();

  const CommitmentRegistry = await ethers.getContractFactory("CommitmentRegistry");
  const deployed = await upgrades.deployProxy(
    CommitmentRegistry,
    [admin.address, 0, poster.address],
    { kind: "uups", initializer: "initialize" },
  );
  const registry = await deployed.waitForDeployment();

  // `initialize` only grants DEFAULT_ADMIN_ROLE, mirroring what the deploy script does.
  await grantAllRoles(registry, admin);

  return { registry, admin, poster, otherAccount };
}
