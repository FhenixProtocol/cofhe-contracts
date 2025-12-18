import * as fs from "fs"
import * as path from "path"

function updateTaskManagerAddressInFile(newAddress, filePath, searchValue, replaceValue) {
    let fileContent = fs.readFileSync(filePath, 'utf8');

    // Replace the address in the file content
    const updatedContent = fileContent.replace(searchValue, replaceValue);

    // Write the updated content back to the file
    fs.writeFileSync(filePath, updatedContent, 'utf8');
    console.log(`Updated ${filePath} with new address: ${newAddress}`);
}

// Only needed for development purposes, in production the address is constant
export function updateTaskManagerAddressInSolidity(newProxyAddress: string) {
    // Update the address in FHE.sol
    let filePath = path.join(__dirname, '../node_modules/@fhenixprotocol/', 'cofhe-contracts', 'FHE.sol');
    updateTaskManagerAddressInFile(
      newProxyAddress,
      filePath,
      /address constant TASK_MANAGER_ADDRESS = .+;/,
      `address constant TASK_MANAGER_ADDRESS = ${newProxyAddress};`
    );

    // Update the address in addresses/TaskManagerAddress.sol
    filePath = path.join(__dirname, '../contracts/addresses/', 'TaskManagerAddress.sol');
    updateTaskManagerAddressInFile(
      newProxyAddress,
      filePath,
      /address constant taskManagerAddress = .+;/,
      `address constant taskManagerAddress = ${newProxyAddress};`
    );
}

export async function updateTaskManagerAddressInJsonArtifact(newAddress, hre) {
  const filePath = path.join(
    __dirname,
    `../ignition/deployments/chain-${await hre.getChainId()}/artifacts/`,
    "DeterministicTM#DeterministicTM.json",
  );

  let fileContent = fs.readFileSync(filePath, "utf8");
  let json = JSON.parse(fileContent);
  json.address = newAddress;

  // Write the updated content back to the file
  fs.writeFileSync(filePath, JSON.stringify(json, null, 4), "utf8");
  console.log(`Updated ${filePath} with new address: ${newAddress}`);
  const newFilePath = path.join(
    __dirname,
    `../ignition/deployments/chain-${await hre.getChainId()}/artifacts/`,
    "TaskManager#TaskManager.json",
  );
  fs.renameSync(filePath, newFilePath);
  console.log(`Renamed ${filePath} to ${newFilePath}`);
}

export async function readTaskManagerAddressFromSolidity() {
    const filePath = path.join(__dirname, '../node_modules/@fhenixprotocol/', 'cofhe-contracts', 'FHE.sol');
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const address = fileContent.match(/address constant TASK_MANAGER_ADDRESS = (.+);/)?.[1];
    if (!address) {
        throw new Error('TaskManager address not found in FHE.sol');
    }
    return address;
}
