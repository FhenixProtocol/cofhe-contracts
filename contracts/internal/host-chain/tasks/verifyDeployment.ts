import chalk from "chalk";
import { Etherscan } from "@nomicfoundation/hardhat-verify/etherscan";
import type { Interface } from "ethers";
import { task, types } from "hardhat/config";
import { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";

// Deterministic TaskManager proxy, identical on every chain (see deployDeterministicTM.ts).
const TM_PROXY_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";
// Dummy implementation the deterministic proxy is constructed with before the real upgrade.
const DUMMY_IMPL_ADDRESS = "0x3428Ca0c49393A34fABbDF61088b68aCff55b14e";
const PROXY_FQN = "contracts/ERC1967Proxy.sol:ERC1967Proxy";

type Ethers = HardhatRuntimeEnvironment["ethers"];

/**
 * Encodes the ERC1967Proxy constructor arguments used by the deterministic TaskManager
 * deployment: (dummy implementation, TaskManager.initialize(admin) calldata).
 */
export function encodeProxyConstructorArgs(
  ethers: Ethers,
  tmInterface: Interface,
  admin: string,
): string {
  const initData = tmInterface.encodeFunctionData("initialize", [admin]);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes"],
    [DUMMY_IMPL_ADDRESS, initData],
  );
}

/**
 * Verifies the TaskManager proxy's own source. The proxy is the local ERC1967Proxy.sol
 * deployed through CreateX, so OpenZeppelin's precompiled-artifact verification cannot match
 * it; we verify it directly via the standard-json build info. The constructor args are
 * reconstructed from the initialize-time owner; a wrong owner is rejected by the explorer.
 */
async function verifyTaskManagerProxy(
  hre: HardhatRuntimeEnvironment,
  tmInterface: Interface,
  admin: string,
): Promise<void> {
  const encodedArgs = encodeProxyConstructorArgs(hre.ethers, tmInterface, admin);

  const chainConfig = await Etherscan.getCurrentChainConfig(
    hre.network.name,
    hre.network.provider,
    hre.config.etherscan.customChains ?? [],
  );
  const etherscan = Etherscan.fromChainConfig(hre.config.etherscan.apiKey, chainConfig);
  if (await etherscan.isVerified(TM_PROXY_ADDRESS)) {
    console.log(chalk.green(`TaskManager proxy already verified at ${TM_PROXY_ADDRESS}`));
    return;
  }

  const buildInfo = await hre.artifacts.getBuildInfo(PROXY_FQN);
  if (buildInfo === undefined) {
    throw new Error(`missing build info for ${PROXY_FQN}; run 'pnpm compile' first`);
  }
  const { message: guid } = await etherscan.verify(
    TM_PROXY_ADDRESS,
    JSON.stringify(buildInfo.input),
    PROXY_FQN,
    `v${buildInfo.solcLongVersion}`,
    encodedArgs.slice(2),
  );
  const status = await etherscan.getVerificationStatus(guid);
  if (!status.isSuccess()) {
    throw new Error(`TaskManager proxy verification failed: ${status.message}`);
  }
  console.log(chalk.green(`Verified TaskManager proxy source at ${TM_PROXY_ADDRESS}`));
}

task("task:verifyDeployment", "Verify deployed host-chain contracts on the block explorer")
  .addOptionalParam(
    "admin",
    "initialize-time owner encoded in the deterministic TaskManager proxy (defaults to the current owner)",
    undefined,
    types.string,
  )
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const tm = await hre.ethers.getContractAt("TaskManager", TM_PROXY_ADDRESS);
    const admin: string = taskArguments.admin ?? (await tm.owner());

    console.log(chalk.bold.blue("Verifying TaskManager proxy source"));
    await verifyTaskManagerProxy(hre, tm.interface, admin);

    // OpenZeppelin's verify override verifies each implementation and links the proxy ABI.
    const proxies: Array<[string, string]> = [
      ["TaskManager", TM_PROXY_ADDRESS],
      ["ACL", await tm.acl()],
      ["PlaintextsStorage", await tm.plaintextsStorage()],
    ];
    for (const [name, address] of proxies) {
      console.log(chalk.bold.blue(`Verifying ${name} implementation and proxy link at ${address}`));
      await hre.run("verify:verify", { address, constructorArguments: [] });
    }
  });
