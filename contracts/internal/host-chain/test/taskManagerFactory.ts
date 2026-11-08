import { ethers } from "hardhat";

/// TaskManager links TaskManagerLib, so every deploy must deploy the library first.
export async function getTaskManagerFactory() {
  const lib = await ethers.deployContract("TaskManagerLib");
  await lib.waitForDeployment();
  return ethers.getContractFactory("TaskManager", {
    libraries: { TaskManagerLib: await lib.getAddress() },
  });
}
