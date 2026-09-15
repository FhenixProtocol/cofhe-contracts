// Plugins
// Tasks
import "./tasks";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ignition-ethers";
import {config as dotenvConfig} from "dotenv";
import "fhenix-hardhat-docker";
import "fhenix-hardhat-plugin";
import "fhenix-hardhat-network";
import "hardhat-deploy";
import {HardhatUserConfig} from "hardhat/config";
import {resolve} from "path";
import {HttpNetworkUserConfig} from "hardhat/types";
import "@openzeppelin/hardhat-upgrades";

// DOTENV_CONFIG_PATH is used to specify the path to the .env file for example in the CI
const dotenvConfigPath: string = process.env.DOTENV_CONFIG_PATH || "./.env";
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) });

const TESTNET_CHAIN_ID = 8008135;
const TESTNET_RPC_URL = "https://api.helium.fhenix.zone";

// Keyed provider endpoints must come from the environment (or GitHub secrets in CI) —
// this is a public repo, so only keyless public RPCs may appear as defaults.
const SEPOLIA_CHAIN_ID = 11155111;
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
const ARBITRUM_SEPOLIA_RPC_URL = process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://arbitrum-sepolia-rpc.publicnode.com"

const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://base-sepolia-rpc.publicnode.com"

const ETHEREUM_CHAIN_ID = 1;
const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || "https://ethereum-rpc.publicnode.com"

const ARBITRUM_ONE_CHAIN_ID = 42161;
const ARBITRUM_ONE_RPC_URL = process.env.ARBITRUM_ONE_RPC_URL || "https://arbitrum-one-rpc.publicnode.com"

// Hardhat validates every network in this file at config load, not just the one being used, so a
// key that is irrelevant to the current deployment must drop out of the list rather than become an
// `undefined` entry - otherwise blanking AGGREGATOR_KEY for a mainnet deploy breaks the localfhenix
// config and refuses to load at all.
const accountsFrom = (...keys: (string | undefined)[]): string[] =>
  keys.filter((key): key is string => Boolean(key && key.trim()));

// Mainnet deploys sign with KEY only - there is no KEY2 / aggregator identity on mainnet.
const mainnetAccounts = accountsFrom(process.env.KEY);


const testnetConfig = {
    chainId: TESTNET_CHAIN_ID,
    url: TESTNET_RPC_URL,
}

const sepoliaConfig = {
    chainId: SEPOLIA_CHAIN_ID,
    url: SEPOLIA_RPC_URL,
    accounts: accountsFrom(process.env.KEY, process.env.KEY2), // Same address as used in Aggregator.js - should be in the .env file (not in .env.example)
}

const arbitrumSepoliaConfig = {
    chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
    url: ARBITRUM_SEPOLIA_RPC_URL,
    accounts: accountsFrom(process.env.KEY, process.env.KEY2), // Same address as used in Aggregator.js - should be in the .env file (not in .env.example)
}

const baseSepoliaConfig = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  url: BASE_SEPOLIA_RPC_URL,
  accounts: accountsFrom(process.env.KEY, process.env.KEY2), // Same address as used in Aggregator.js - should be in the .env file (not in .env.example)
}

const ethereumConfig = {
  chainId: ETHEREUM_CHAIN_ID,
  url: ETHEREUM_RPC_URL,
  accounts: mainnetAccounts,
}

const arbitrumOneConfig = {
  chainId: ARBITRUM_ONE_CHAIN_ID,
  url: ARBITRUM_ONE_RPC_URL,
  accounts: mainnetAccounts,
}

// Making sure we use different account in localfhenix -
// we might want to delete this and change the TM admin addres.
// Important: We can't use the same account for the tasks operations and the TM admin address.
const localfhenixconfig: HttpNetworkUserConfig  = {
  gas: "auto",
  gasMultiplier: 1.2,
  gasPrice: 100_000_000_000,
  timeout: 10_000,
  httpHeaders: {},
  url: "http://127.0.0.1:42069",
  accounts: accountsFrom(process.env.KEY, process.env.KEY2, process.env.AGGREGATOR_KEY),
}

const localfhenixk8sconfig: HttpNetworkUserConfig  = {
  gas: "auto",
  gasMultiplier: 1.2,
  gasPrice: 100_000_000_000,
  timeout: 10_000,
  httpHeaders: {},
  url: "http://hostchain:8547",
  accounts: accountsFrom(process.env.KEY, process.env.KEY2, process.env.AGGREGATOR_KEY),
};

function insertAccounts(config: any) {
  const keys = process.env.KEY;
  if (!keys) {
    let mnemonic = process.env.MNEMONIC;
    if (!mnemonic) {
      throw new Error("No mnemonic or private key provided, please set MNEMONIC or KEY in your .env file");
    }
    config['accounts'] = {
      count: 10,
      mnemonic,
      path: "m/44'/60'/0'/0",
    }
  } else {
    config['accounts'] = [keys];
  }
}
// Select either private keys or mnemonic from .env file or environment variables
insertAccounts(testnetConfig);

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.25',
    settings: {
      metadata: {
        // Not including the metadata hash
        // https://github.com/paulrberg/hardhat-template/issues/31
        bytecodeHash: 'none',
      },
      // Disable the optimizer when debugging
      // https://hardhat.org/hardhat-network/#solidity-optimizer-support
      optimizer: {
        enabled: true,
        runs: 800,
      },
      evmVersion: 'cancun',
      viaIR: true,
    },
  },
  defaultNetwork: "localfhenix",
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
    },
    testnet: testnetConfig,
    sepolia: sepoliaConfig as HttpNetworkUserConfig,
    arbitrumSepolia: arbitrumSepoliaConfig as HttpNetworkUserConfig,
    baseSepolia: baseSepoliaConfig as HttpNetworkUserConfig,
    ethereum: ethereumConfig as HttpNetworkUserConfig,
    arbitrumOne: arbitrumOneConfig as HttpNetworkUserConfig,
    localfhenix: localfhenixconfig,
    localfhenixk8s: localfhenixk8sconfig,
  },
  etherscan: {
    // Etherscan API v2 - a single key serves every supported chain (Ethereum, Arbitrum One, ...)
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
  typechain: {
    outDir: "types",
    target: "ethers-v6",
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    outputFile: process.env.GAS_REPORT_FILE || undefined,
    noColors: !!process.env.GAS_REPORT_FILE,
  },
};

export default config;
