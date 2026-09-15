import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { Contract, ContractFactory } from "ethers";
import { task } from "hardhat/config";

import DeterministicTM from "../ignition/modules/DeterministicTM";
import { CREATEX_ADDRESS, deployCreateX, isAlreadyDeployed } from "../utils/deployCreateX";
import { fundAccount } from "../utils/fund";
import { deployCreate2ViaCreateX, deployDeterministic, DETERMINISTIC_SALT } from "../utils/deployDeterministic";
import { updateTaskManagerAddressInJsonArtifact } from "../utils/updateTaskManagerAddress";
import { isLocalNetwork } from "../utils/roles";
import chalk from "chalk";
import ERC1967ProxyModule from "../ignition/modules/ERC1967Proxy";
import { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";
// DOTENV_CONFIG_PATH is used to specify the path to the .env file for example in the CI
const dotenvConfigPath: string = process.env.DOTENV_CONFIG_PATH || "../.env";
dotenvConfig({ path: resolve(__dirname, dotenvConfigPath) });

/**
 * Gets the implementation address of a proxy contract
 * @param proxy The proxy contract to get the implementation address of
 * @returns The implementation address of the proxy contract
 */
async function getImplementationAddress(proxy: any, hre: HardhatRuntimeEnvironment) {
  const IMPLEMENTATION_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implementationAddress = await hre.ethers.provider.getStorage(
    proxy,
    IMPLEMENTATION_SLOT,
  );

  // Convert the storage value to address format
  return hre.ethers.getAddress(
    "0x" + implementationAddress.slice(-40),
  );
}

async function getDeterministicDummyContract(admin: string, hre: HardhatRuntimeEnvironment) {
  // deploy the dummy contract deterministically
  const expectedAddress = "0x3428Ca0c49393A34fABbDF61088b68aCff55b14e";
  const dummyAddress = await deployDeterministic(
    hre,
    expectedAddress,
    DeterministicTM,
    {},
  );
  console.log(chalk.green("Deployed dummy contract at:", dummyAddress));
  return dummyAddress;
}

/**
 * Gets the deterministic proxy contract
 * @param contractName The name of the contract to deploy
 * @param admin The admin account that has deploy permissions
 * @param factory The factory for the contract to deploy
 * @param implementationAddress The address of the implementation contract
 * @param implementation The implementation contract
 * @returns The proxy contract and its address
 */
async function getDeterministicProxyContract(
  admin: string,
  factory: ContractFactory,
  hre: HardhatRuntimeEnvironment
) {
  //Deploy the Proxy Contract
  // using the ERC1967ProxyModule, in the constructor we pass the implementation address and the data
  // where the data is the initialization data for the implementation contract
  const proxyAddress = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";
  // The proxy is deployed with CREATE2, so its address depends on its constructor args -
  // implementation and init data included. The init data must therefore stay byte-identical
  // to keep the proxy at `proxyAddress`, which is compiled into FHE.sol and into ACL /
  // PlaintextsStorage as a constant. It has to encode DeterministicTM's `initialize(address)`,
  // the implementation actually behind the proxy at this point, and not TaskManager's
  // role-based `initialize(address,uint48)`. deploy.ts later upgrades this proxy to
  // TaskManager and migrates it to AccessControl via initializeV2.
  const deterministicFactory = await hre.ethers.getContractFactory("DeterministicTM");
  const proxyInitData = deterministicFactory.interface.encodeFunctionData("initialize", [admin]);
  const dummyAddress = await getDeterministicDummyContract(admin, hre);
  const deployedAddress = await deployDeterministic(
    hre,
    proxyAddress,
    ERC1967ProxyModule,
    {
      implementation: dummyAddress,
      data: proxyInitData
    }
  );
  console.log(chalk.green("Deployed proxy at:", deployedAddress));

  // Get the proxy with the implementation's ABI
  const proxyContract = factory.attach(deployedAddress) as Contract;
  console.log(chalk.green("Proxy contract:", await proxyContract.getAddress()));
  const implementationAddressFromProxy = await getImplementationAddress(proxyContract, hre);

  if (implementationAddressFromProxy !== dummyAddress) {
    console.log(chalk.red("Implementation address from proxy does not match expected address", implementationAddressFromProxy, " != ", dummyAddress));
    process.exit(1);
  }

  console.log(chalk.green("Implementation address from proxy:", implementationAddressFromProxy));


  return { proxyContract, deployedAddress: deployedAddress.toString() };
}

// Canonical CREATE2 ingredients. The proxy address compiled into FHE.sol is derived from
// CreateX + DETERMINISTIC_SALT + the proxy init code, which embeds
// `DeterministicTM.initialize(BOOTSTRAP_OWNER)` - so all three are protocol constants: change
// any of them and the proxy lands somewhere other than the canonical address.
const EXPECTED_TM_PROXY_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";
const EXPECTED_DUMMY_ADDRESS = "0x3428Ca0c49393A34fABbDF61088b68aCff55b14e";

// The address of the intentionally-public local dev key (see AGGREGATOR_KEY in .env.example).
// It is baked into the canonical proxy address, so the bootstrap proxy is unavoidably created
// with a publicly-known key as its Ownable owner. deployDeterministicTMRemote therefore hands
// ownership to TM_ADMIN_ADDRESS in a transaction broadcast together with the creation.
const BOOTSTRAP_OWNER = "0x55A07F9f7eD7F110c2Ddd8f2f5d8677Dc94aF4E2";

// ERC-7201 slot of `openzeppelin.storage.Ownable` - where the bootstrap implementation records
// its owner. Matches LegacyOwnable.OWNABLE_STORAGE_SLOT in the contracts.
const OWNABLE_STORAGE_SLOT =
  "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300";

async function legacyOwnerOf(hre: HardhatRuntimeEnvironment, proxy: string): Promise<string> {
  const raw = await hre.ethers.provider.getStorage(proxy, OWNABLE_STORAGE_SLOT);
  return hre.ethers.getAddress("0x" + raw.slice(-40));
}

// ERC-7201 slot of `openzeppelin.storage.Ownable2Step` - the nominee `transferOwnership` records.
const OWNABLE2STEP_STORAGE_SLOT =
  "0x237e158222e3e6968b72b9db0d8043aacf074ad9f650f0d1606b4d82ee432c00";

async function pendingOwnerOf(hre: HardhatRuntimeEnvironment, proxy: string): Promise<string> {
  const raw = await hre.ethers.provider.getStorage(proxy, OWNABLE2STEP_STORAGE_SLOT);
  return hre.ethers.getAddress("0x" + raw.slice(-40));
}

/**
 * Completes the two-step ownership handover on the bootstrap proxy.
 *
 * `DeterministicTM` is `Ownable2StepUpgradeable`, so `transferOwnership` only nominates - it
 * writes `_pendingOwner` and leaves `owner` alone. Until the nominee calls `acceptOwnership()`
 * the proxy is still owned by the publicly-known bootstrap key, i.e. still upgradeable by anyone
 * holding it. This sends whichever of the two steps is still outstanding, so it both finishes a
 * fresh bootstrap and repairs a run that died between them.
 *
 * The accept cannot share the bootstrap key's consecutive-nonce trick - it has to come from the
 * nominee - so a window of one block remains where the public key is still the owner. On Ethereum
 * the private-mempool endpoint is what keeps that window from being observable; elsewhere it is
 * short and the task fails loudly if anything used it.
 */
async function secureOwnership(
  hre: HardhatRuntimeEnvironment,
  dummyFactory: any,
  signer: any,
  bootstrapWallet: any,
  securedOwnerAddress: string,
) {
  const owner = await legacyOwnerOf(hre, EXPECTED_TM_PROXY_ADDRESS);
  if (owner.toLowerCase() === securedOwnerAddress.toLowerCase()) {
    return;
  }

  const pending = await pendingOwnerOf(hre, EXPECTED_TM_PROXY_ADDRESS);
  if (pending.toLowerCase() !== securedOwnerAddress.toLowerCase()) {
    console.log(chalk.yellow(`Nominating ${securedOwnerAddress} (pending owner is ${pending})`));
    const transferTx = await bootstrapWallet.sendTransaction({
      to: EXPECTED_TM_PROXY_ADDRESS,
      data: dummyFactory.interface.encodeFunctionData("transferOwnership", [securedOwnerAddress]),
      gasLimit: 300_000n,
    });
    console.log(chalk.dim("transferOwnership broadcast:", transferTx.hash));
    await transferTx.wait();
  }

  const acceptTx = await signer.sendTransaction({
    to: EXPECTED_TM_PROXY_ADDRESS,
    data: dummyFactory.interface.encodeFunctionData("acceptOwnership"),
    gasLimit: 300_000n,
  });
  console.log(chalk.dim("acceptOwnership broadcast:", acceptTx.hash));
  await acceptTx.wait();
}

/**
 * Bootstraps the deterministic TaskManager proxy on a live network and immediately secures it.
 *
 * The proxy must be created with the publicly-known BOOTSTRAP_OWNER as its Ownable owner (that
 * address is part of the CREATE2 derivation), which means that until ownership moves, anyone
 * holding the public dev key can upgrade the proxy.
 *
 * Three transactions, because `DeterministicTM` is Ownable2Step and `transferOwnership` only
 * nominates:
 *   1. `CreateX.deployCreate2`        - bootstrap key, nonce n
 *   2. `transferOwnership(TM_ADMIN)`  - bootstrap key, nonce n+1
 *   3. `acceptOwnership()`            - TM_ADMIN itself
 *
 * 1 and 2 are broadcast back-to-back on consecutive nonces from the same account, so nothing
 * from that account can execute between them and they normally share a block. 3 has to come from
 * the nominee, so it cannot join that sequence: a window of roughly one block remains in which
 * the public key is still the owner. On Ethereum, point the RPC at a private-mempool endpoint
 * (e.g. Flashbots Protect) so none of this is visible before inclusion - a bundle covering all
 * three would close the window outright; Arbitrum One has no public mempool.
 *
 * Idempotent and resumable: an already-secured proxy is reported and left alone, one still owned
 * by the bootstrap key has its handover completed (the state a run interrupted between 2 and 3
 * leaves behind), and any other owner aborts loudly as a possible squat.
 */
async function deployDeterministicTMRemote(hre: HardhatRuntimeEnvironment) {
  const { ethers } = hre;
  const [signer] = await ethers.getSigners();

  const securedOwner = process.env.TM_ADMIN_ADDRESS?.trim();
  if (!securedOwner) {
    throw new Error(
      "TM_ADMIN_ADDRESS must be set on a live network - ownership of the bootstrap proxy is " +
        "transferred to it immediately after creation, and it later signs the TaskManager migration.",
    );
  }
  const securedOwnerAddress = ethers.getAddress(securedOwner);

  // Ownable2Step means TM_ADMIN_ADDRESS has to send acceptOwnership itself, so this task needs to
  // be able to sign as it - not merely know the address.
  if (signer.address.toLowerCase() !== securedOwnerAddress.toLowerCase()) {
    throw new Error(
      `TM_ADMIN_ADDRESS is ${securedOwnerAddress} but the configured signer is ${signer.address}. ` +
        `Ownership moves via Ownable2Step, so TM_ADMIN_ADDRESS has to send acceptOwnership - set ` +
        `KEY to its private key.`,
    );
  }

  const bootstrapKey = process.env.BOOTSTRAP_OWNER_KEY?.trim();
  if (!bootstrapKey) {
    throw new Error(
      `BOOTSTRAP_OWNER_KEY must be set on a live network: the key for ${BOOTSTRAP_OWNER} ` +
        `(the intentionally-public dev key, see .env.example). It signs the proxy creation and ` +
        `the immediate transferOwnership, and needs a small ETH balance for those two transactions.`,
    );
  }
  const bootstrapWallet = new ethers.Wallet(bootstrapKey, ethers.provider);
  if (bootstrapWallet.address !== BOOTSTRAP_OWNER) {
    throw new Error(
      `BOOTSTRAP_OWNER_KEY is the key for ${bootstrapWallet.address}, not for the canonical ` +
        `bootstrap owner ${BOOTSTRAP_OWNER}. A proxy created with any other owner does not land ` +
        `at the canonical address ${EXPECTED_TM_PROXY_ADDRESS}.`,
    );
  }

  if (!(await isAlreadyDeployed(hre, CREATEX_ADDRESS))) {
    throw new Error(
      `CreateX is not deployed at ${CREATEX_ADDRESS} on this network - refusing to bootstrap. ` +
        `See https://github.com/pcaversaccio/createx for chains where it is available.`,
    );
  }

  // Idempotency and squat detection: the address is world-deployable (CreateX CREATE2 is
  // deployer-agnostic), so code already at the address is either our earlier run or a takeover.
  if (await isAlreadyDeployed(hre, EXPECTED_TM_PROXY_ADDRESS)) {
    const currentOwner = await legacyOwnerOf(hre, EXPECTED_TM_PROXY_ADDRESS);
    if (currentOwner.toLowerCase() === securedOwnerAddress.toLowerCase()) {
      console.log(
        chalk.green(
          `TaskManager bootstrap proxy already deployed at ${EXPECTED_TM_PROXY_ADDRESS} and ` +
            `owned by ${currentOwner} - nothing to do.`,
        ),
      );
      return;
    }
    // Still owned by the bootstrap key: an earlier run created the proxy but did not finish the
    // two-step handover. That is the one state worth resuming rather than refusing - and the most
    // urgent, since the public key owns the proxy until it is fixed.
    if (currentOwner.toLowerCase() === BOOTSTRAP_OWNER.toLowerCase()) {
      console.log(
        chalk.yellow(
          `Proxy at ${EXPECTED_TM_PROXY_ADDRESS} exists but is still owned by the bootstrap key ` +
            `- completing the handover to ${securedOwnerAddress}.`,
        ),
      );
      const dummyFactory = await ethers.getContractFactory("DeterministicTM");
      await secureOwnership(hre, dummyFactory, signer, bootstrapWallet, securedOwnerAddress);
      const owner = await legacyOwnerOf(hre, EXPECTED_TM_PROXY_ADDRESS);
      if (owner.toLowerCase() !== securedOwnerAddress.toLowerCase()) {
        throw new Error(
          `CRITICAL: the proxy at ${EXPECTED_TM_PROXY_ADDRESS} is still owned by ${owner} after ` +
            `the handover. Investigate immediately and do not run the main deployment.`,
        );
      }
      console.log(chalk.green(`Handover complete: owner is ${owner}.`));
      return;
    }
    throw new Error(
      `TaskManager proxy already exists at ${EXPECTED_TM_PROXY_ADDRESS} with legacy owner ` +
        `${currentOwner}, which is not TM_ADMIN_ADDRESS (${securedOwnerAddress}). If that owner ` +
        `is not an address you control, the canonical address may have been taken over on this ` +
        `network - do NOT proceed; investigate before anything else.`,
    );
  }

  // The dummy implementation embeds no owner and disables its initializers, so deploying it
  // carries no race - any signer can do it, through CreateX, ahead of the proxy.
  console.log(chalk.bold.blue("----------------DeterministicTM implementation--------------"));
  const dummyFactory = await ethers.getContractFactory("DeterministicTM");
  await deployCreate2ViaCreateX(
    hre,
    signer,
    EXPECTED_DUMMY_ADDRESS,
    dummyFactory.bytecode,
    "DeterministicTM implementation",
  );

  console.log(chalk.bold.blue("--------------TaskManager proxy (bootstrap)-----------------"));
  const balance = await ethers.provider.getBalance(bootstrapWallet.address);
  if (balance === 0n) {
    throw new Error(
      `The bootstrap key wallet ${bootstrapWallet.address} has no ETH on this network. Fund it ` +
        `with enough for two transactions (proxy creation + transferOwnership) and re-run.`,
    );
  }

  const proxyFactory = await ethers.getContractFactory("ERC1967Proxy");
  const initData = dummyFactory.interface.encodeFunctionData("initialize", [BOOTSTRAP_OWNER]);
  const initCode = ethers.concat([
    proxyFactory.bytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes"], [EXPECTED_DUMMY_ADDRESS, initData]),
  ]);

  const createXIface = new ethers.Interface([
    "function deployCreate2(bytes32 salt, bytes initCode) payable returns (address)",
  ]);
  const nonce = await ethers.provider.getTransactionCount(bootstrapWallet.address);
  const deployTx = await bootstrapWallet.sendTransaction({
    to: CREATEX_ADDRESS,
    data: createXIface.encodeFunctionData("deployCreate2", [DETERMINISTIC_SALT, initCode]),
    nonce,
  });
  console.log(chalk.dim("proxy creation broadcast:", deployTx.hash));
  // Broadcast the securing transfer before the creation confirms: same sender and consecutive
  // nonces, so nothing from this account can execute in between and the two usually share a
  // block. Gas estimation would run against an address that has no code yet, hence the explicit
  // gas limit.
  const transferTx = await bootstrapWallet.sendTransaction({
    to: EXPECTED_TM_PROXY_ADDRESS,
    data: dummyFactory.interface.encodeFunctionData("transferOwnership", [securedOwnerAddress]),
    nonce: nonce + 1,
    gasLimit: 300_000n,
  });
  console.log(chalk.dim("transferOwnership broadcast:", transferTx.hash));
  await deployTx.wait();
  await transferTx.wait();

  // Ownable2Step: the transfer above only nominated. Ownership does not actually move until the
  // nominee accepts, and until it does the public bootstrap key is still the owner.
  await secureOwnership(hre, dummyFactory, signer, bootstrapWallet, securedOwnerAddress);

  if (!(await isAlreadyDeployed(hre, EXPECTED_TM_PROXY_ADDRESS))) {
    throw new Error(
      `Proxy creation confirmed but there is no code at ${EXPECTED_TM_PROXY_ADDRESS} - the init ` +
        `code did not reproduce the canonical address on this network.`,
    );
  }
  const finalOwner = await legacyOwnerOf(hre, EXPECTED_TM_PROXY_ADDRESS);
  if (finalOwner.toLowerCase() !== securedOwnerAddress.toLowerCase()) {
    throw new Error(
      `CRITICAL: the proxy at ${EXPECTED_TM_PROXY_ADDRESS} is owned by ${finalOwner}, not by ` +
        `TM_ADMIN_ADDRESS (${securedOwnerAddress}). Ownership was NOT secured - investigate ` +
        `immediately and do not run the main deployment.`,
    );
  }
  console.log(
    chalk.green(
      `TaskManager bootstrap proxy deployed at ${EXPECTED_TM_PROXY_ADDRESS} and secured: ` +
        `owner is ${finalOwner}.`,
    ),
  );
}

task("task:deployDeterministicTM", "Deploy deterministic TaskManager").setAction(
  async function (taskArguments: TaskArguments, hre) {
    if (!isLocalNetwork(hre)) {
      await deployDeterministicTMRemote(hre);
      return;
    }

    // Note: we need to use an unused account for deployment via ignition, or it will complain
    const [signer, signerProxy, aggregatorSigner] = await hre.ethers.getSigners();

  console.log(chalk.bold.blue("-----------------------Funding-----------------------------"));
  if (hre.network.name.includes("localfhenix")) {
    // Deterministic deployment via createX contract:
    // Deploy create x contract
    console.log(chalk.green("Funding account:", signerProxy.address));
    
    await fundAccount(hre, signerProxy);
    await deployCreateX(hre, signerProxy);
  }

  await fundAccount(hre, aggregatorSigner);
  await fundAccount(hre, signer);
  console.log(chalk.dim("Successfully funded aggregator and deployer accounts"));
  console.log("\n");


  // Todo this needs to be deterministic
  // Headline in chalk blue, with length of 60
  console.log(chalk.bold.blue("-----------------------TaskManager--------------------------"));
  const TMFactory = await hre.ethers.getContractFactory("TaskManager");
  const { deployedAddress: TMProxyAddress } = await getDeterministicProxyContract(
    aggregatorSigner.address,
    TMFactory,
    hre
  );
  await updateTaskManagerAddressInJsonArtifact(TMProxyAddress, hre);
  }
);
