import * as fs from "fs";
import * as path from "path";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * Writes the TaskManager artifact plus its address where the local stack picks it up.
 * `cofhe_utils.sh` copies this file to every service that needs the TaskManager ABI and address.
 */
export async function updateTaskManagerAddressInJsonArtifact(newAddress: string, hre: HardhatRuntimeEnvironment) {
  const artifactsDir = path.join(
    __dirname,
    `../ignition/deployments/chain-${await hre.getChainId()}/artifacts/`,
  );
  fs.mkdirSync(artifactsDir, { recursive: true });
  const filePath = path.join(artifactsDir, "TaskManager#TaskManager.json");
  const artifact = await hre.artifacts.readArtifact("TaskManager");
  fs.writeFileSync(filePath, JSON.stringify({ ...artifact, address: newAddress }, null, 4), "utf8");
  console.log(`Updated ${filePath} with new address: ${newAddress}`);
}
