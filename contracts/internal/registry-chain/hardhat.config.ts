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
    arbitrumSepolia: {
      chainId: 421614,
      url: "https://little-convincing-fog.arbitrum-sepolia.quiknode.pro/e925be62bdfa8faab560daa332c0c95e26189870/",
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
