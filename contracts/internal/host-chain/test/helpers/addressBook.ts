import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { addressBookAddress, taskManagerId } from "../../utils/addressBook";

const { ethers } = hre;

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * Install a UUPS proxy's runtime bytecode at a fixed address and initialize it in place. We can't
 * `deployProxy` at an arbitrary address, and AccessControl stores role membership in computed
 * mapping slots (not one fixed slot), so we initialize through the real proxy rather than copying
 * storage slots. Hardhat network only.
 */
export async function deployProxyAtAddress(
  targetAddress: string,
  implementationAddress: string,
  initData: string,
): Promise<void> {
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  // Deploy a throwaway proxy only to capture the proxy runtime bytecode.
  const tempProxy = await ERC1967Proxy.deploy(implementationAddress, "0x");
  await tempProxy.waitForDeployment();
  const proxyBytecode = await ethers.provider.getCode(await tempProxy.getAddress());

  await ethers.provider.send("hardhat_setCode", [targetAddress, proxyBytecode]);
  await ethers.provider.send("hardhat_setStorageAt", [
    targetAddress,
    IMPL_SLOT,
    ethers.zeroPadValue(implementationAddress, 32),
  ]);

  const [signer] = await ethers.getSigners();
  const tx = await signer.sendTransaction({ to: targetAddress, data: initData });
  await tx.wait();
}

/** Places a CoFHEAddressBook at the address FHE.sol is compiled against, owned by `owner`. */
export async function installAddressBook(owner: HardhatEthersSigner): Promise<any> {
  const Book = await ethers.getContractFactory("CoFHEAddressBook");
  const impl = await Book.deploy();
  await impl.waitForDeployment();
  await deployProxyAtAddress(
    addressBookAddress(),
    await impl.getAddress(),
    Book.interface.encodeFunctionData("initialize", [owner.address]),
  );
  return Book.attach(addressBookAddress()).connect(owner);
}

/** Registers `taskManagerAddress` under the id FHE.sol is compiled against. */
export async function registerTaskManager(book: any, taskManagerAddress: string): Promise<void> {
  await (await book.setTm(taskManagerId(), taskManagerAddress)).wait();
}
