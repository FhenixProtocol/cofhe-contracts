import { ethers, upgrades } from "hardhat";
import { Contract } from "ethers";

/**
 * Deploys a UUPS proxy for the given contract.
 * @param contractName The contract to deploy behind a proxy
 * @param initArgs Arguments passed to the initialize function
 * @returns The proxy contract instance and its address
 */
export async function deployUUPSProxy(
  contractName: string,
  initArgs: unknown[],
): Promise<{ proxy: Contract; address: string }> {
  const factory = await ethers.getContractFactory(contractName);
  const deployed = await upgrades.deployProxy(factory, initArgs, {
    kind: "uups",
    initializer: "initialize",
  });
  const proxy = (await deployed.waitForDeployment()) as unknown as Contract;
  const address = await proxy.getAddress();
  console.log(`Deployed ${contractName} proxy to: ${address}`);
  return { proxy, address };
}
