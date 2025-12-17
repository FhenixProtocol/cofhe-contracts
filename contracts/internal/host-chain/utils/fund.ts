import { HardhatRuntimeEnvironment } from "hardhat/types/runtime";
import chalk from "chalk";
import axios from "axios";
async function getFunds(address: string, faucetUrl: string) {
  const response = await axios.get(`${faucetUrl}/faucet?address=${address}`);

  if (response.status !== 200) {
    throw new Error(
      `Failed to get funds from faucet: ${response.status}: ${response.statusText}`,
    );
  }

  if (!response.data?.message?.includes("ETH successfully sent to address")) {
    throw new Error(
      `Failed to get funds from faucet: ${JSON.stringify(response.data)}`,
    );
  }
}

export async function fundAccount(
  hre: HardhatRuntimeEnvironment,
  signer: any
): Promise<any> {
  if ((await hre.ethers.provider.getBalance(signer.address)).toString() === "0") {
    if (hre.network.name === "localfhenixk8s") {
      await getFunds(signer.address, "http://hostchain:3000");
    } else if (hre.network.name === "localfhenix") {
      await hre.fhenixjs.getFunds(signer.address);
      console.log(
        chalk.green("Account with address", signer.address, "successfully funded")
      );
    } else {
      console.log(
        chalk.red(
          "Please fund your account with address", signer.address, "with testnet FHE from https://faucet.fhenix.zone"
        )
      );
    }
  } else {
    console.log(chalk.green("Account with address", signer.address, "already has funds"));
  }
}


