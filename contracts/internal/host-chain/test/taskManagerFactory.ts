import { ethers } from "hardhat";

/// Deploys a NEW TaskManagerLib and returns a TaskManager factory linked to it.
///
/// TaskManager's bytecode has a placeholder for the TaskManagerLib address, so a TaskManager can
/// be deployed only after its library exists. Every call deploys another library; use it to deploy
/// a TaskManager on a fresh test chain or a new implementation for an upgrade test. To use a
/// TaskManager that is already deployed, attach to its address: the library is already linked in.
export async function deployLinkedTaskManagerFactory() {
  const lib = await ethers.deployContract("TaskManagerLib");
  await lib.waitForDeployment();
  return ethers.getContractFactory("TaskManager", {
    libraries: { TaskManagerLib: await lib.getAddress() },
  });
}
