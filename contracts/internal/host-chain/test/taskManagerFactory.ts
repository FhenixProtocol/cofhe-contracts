import { ethers } from "hardhat";

/// TaskManager calls TaskManagerHelper behind a proxy, so every deploy needs the helper first.
export async function getTaskManagerFactory() {
  const impl = await ethers.deployContract("TaskManagerHelper");
  const proxy = await ethers.deployContract("ERC1967Proxy", [await impl.getAddress(), "0x"]);
  const helper = await proxy.getAddress();
  const factory = await ethers.getContractFactory("TaskManager");
  const deploy = factory.deploy.bind(factory);
  (factory as any).deploy = (...args: any[]) => deploy(helper, ...args);
  return factory;
}
