import TaskManagerModule from "../ignition/modules/TaskManager";

export async function getTaskManagerDeployment(hre) {
  // should return the already deployed TaskManager
  const { [TaskManagerModule.id]: taskManager } = await hre.ignition.deploy(TaskManagerModule, {
    parameters: {
      TaskManager: {
        adminAddress: (await hre.ethers.getSigners())[2].address,
        minSecurityZone: 0,
        maxSecurityZone: 0,
      }
    }
  });

  console.log("TaskManager deployed at:", taskManager.target);
  return taskManager;
}
