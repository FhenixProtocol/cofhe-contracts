import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import { config as dotenvConfig } from "dotenv";
import { HardhatUserConfig } from "hardhat/config";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, "./.env") });

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.25",
    settings: {
      metadata: { bytecodeHash: "none" },
      optimizer: { enabled: true, runs: 800 },
      evmVersion: "cancun",
      viaIR: true,
    },
  },
  defaultNetwork: "hardhat",
  networks: {
    hardhat: { allowUnlimitedContractSize: true },
    localfhenix: {
      url: "http://127.0.0.1:42069",
      accounts: process.env.KEY ? [process.env.KEY] : [],
    },
    localfhenixk8s: {
      url: "http://hostchain:8547",
      accounts: process.env.KEY ? [process.env.KEY] : [],
    },
    arbitrumSepolia: {
      chainId: 421614,
      // Keyed provider endpoints must come from the environment — public repo, keyless default only.
      url: process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://arbitrum-sepolia-rpc.publicnode.com",
      accounts: process.env.KEY ? [process.env.KEY] : [],
    },
  },
  typechain: { outDir: "types", target: "ethers-v6" },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    outputFile: process.env.GAS_REPORT_FILE || undefined,
    noColors: !!process.env.GAS_REPORT_FILE,
  },
};

export default config;
