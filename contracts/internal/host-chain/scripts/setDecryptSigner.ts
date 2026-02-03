import { ethers } from "hardhat";

async function main() {
  const [signer, _, aggregator] = await ethers.getSigners();
  const tm = await ethers.getContractAt("TaskManager", "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9");
  const dispatcherSigner = "0x3f1eae7d46d88f08fc2f8ed27fcb2ab183eb2d0e";
  console.log("Current signer:", await tm.decryptResultSigner());
  console.log("Setting signer to:", dispatcherSigner);
  const tx = await tm.connect(aggregator).setDecryptResultSigner(dispatcherSigner);
  await tx.wait();
  console.log("New signer:", await tm.decryptResultSigner());
}

main().catch(console.error);
