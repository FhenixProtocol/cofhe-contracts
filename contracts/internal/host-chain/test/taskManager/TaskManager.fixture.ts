import type { TaskManager } from "../../types";
import hre from "hardhat";

export async function deployTaskManagerFixture(): Promise<{
  taskManager: TaskManager;
  taskManagerAddress: string;
}> {
  // Run deploy scripts to set up TaskManager
  await hre.run("deploy");

  // Get the deployed TaskManager
  const taskManagerAddress = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";
  const taskManager = await hre.ethers.getContractAt("TaskManager", taskManagerAddress);

  return { taskManager, taskManagerAddress };
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
