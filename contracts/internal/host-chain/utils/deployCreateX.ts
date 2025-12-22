import chalk from "chalk";
import * as fs from "fs"
import * as path from "path"
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const proxyTransactionDetails = {
  gasPrice: 100000000000n,
  gasLimit: 3_000_000n,
  signerAddress: "0xeD456e05CaAb11d66C4c797dD6c1D6f9A7F352b5",
  address: "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed"
};

export const isAlreadyDeployed = async function (hre: HardhatRuntimeEnvironment, contractExpectedAddress: string): Promise<boolean> {
  const code = await hre.ethers.provider.getCode(contractExpectedAddress);
  return code !== "0x";
}

export const deployCreateX = async function (hre: HardhatRuntimeEnvironment, signer: HardhatEthersSigner): Promise<boolean> {
  const { ethers } = hre;

  const filePath = path.resolve(__dirname, "tx-createX.txt");
  const transaction = fs.readFileSync(filePath, "utf-8");

  if (await isAlreadyDeployed(hre, proxyTransactionDetails.address)) {
    console.log("createX contract already deployed at:", proxyTransactionDetails.address);
    return true;
  }

  console.log("deploying createX contract");

  // Verify that the one-time address has enough funds to send the proxy deployment transaction
  const balanceOneTime = (await ethers.provider.getBalance(proxyTransactionDetails.signerAddress));
  const needed = proxyTransactionDetails.gasLimit * proxyTransactionDetails.gasPrice

  if (balanceOneTime < needed) {
    console.log("funding one-time deployer of proxy contract");
    await signer.sendTransaction({
      to: proxyTransactionDetails.signerAddress,
      value: needed - balanceOneTime,
    });
    console.log("sent some funds to one-time deployer of createX contract");
  } else {
    console.log("no need to send some funds to one-time deployer of createX contract, already has enough funds");
  }

  // deploy proxy contract
  const txResponse = await ethers.provider.broadcastTransaction(transaction);

  const receipt = await txResponse.wait();
  if (receipt?.contractAddress !== proxyTransactionDetails.address) {
    console.log(
      "Failed to deploy createX contract, resulting address",
      receipt?.contractAddress,
      "expected address",
      proxyTransactionDetails.address
    );

    return false;
  }

  console.log(chalk.green("successfully deployed createX contract to:", receipt.contractAddress));
  return true;
};