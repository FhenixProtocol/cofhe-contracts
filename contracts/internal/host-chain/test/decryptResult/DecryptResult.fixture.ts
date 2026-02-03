import hre from "hardhat";
const { ethers } = hre;
import { Wallet, BaseContract } from "ethers";

// Hardcoded TaskManager address from contracts/addresses/TaskManagerAddress.sol
const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

export interface DecryptResultFixture {
  taskManager: BaseContract;
  plaintextsStorage: BaseContract;
  owner: any;
  testSigner: Wallet;
  otherAccount: any;
  originalSigner: string;
}

/**
 * Generate a deterministic test signing key for testing
 * This key is ONLY for testing - never use in production
 */
function getTestSignerWallet(): Wallet {
  // Deterministic private key for testing (32 bytes)
  const testPrivateKey = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  return new ethers.Wallet(testPrivateKey, ethers.provider);
}

export async function deployDecryptResultFixture(): Promise<DecryptResultFixture> {
  // First, run the deploy task to ensure contracts are deployed and upgraded
  await hre.run("deploy");

  const accounts = await hre.ethers.getSigners();
  // accounts[0] = KEY, accounts[1] = KEY2, accounts[2] = AGGREGATOR_KEY (owner)
  const owner = accounts[2]; // Aggregator is the owner of TaskManager
  const otherAccount = accounts[0];

  // Get the existing TaskManager at the hardcoded address
  const taskManager = await ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS);
  console.log("TaskManager attached at:", TASK_MANAGER_ADDRESS);

  // Get the PlaintextsStorage address from TaskManager
  const plaintextsStorageAddress = await taskManager.plaintextsStorage();
  const plaintextsStorage = await ethers.getContractAt("PlaintextsStorage", plaintextsStorageAddress);
  console.log("PlaintextsStorage at:", plaintextsStorageAddress);

  // Create test signer for decrypt result verification
  const testSigner = getTestSignerWallet();

  // Store the original signer so we can restore it after tests
  const originalSigner = await taskManager.decryptResultSigner();
  console.log("Original decryptResultSigner:", originalSigner);

  // Set the decrypt result signer to our test signer for testing
  const connectedTM = taskManager.connect(owner);
  await connectedTM.setDecryptResultSigner(testSigner.address);
  console.log("DecryptResultSigner set to:", testSigner.address);

  return {
    taskManager,
    plaintextsStorage,
    owner,
    testSigner,
    otherAccount,
    originalSigner,
  };
}

export async function getTokensFromFaucet() {
  if (hre.network.name === "localfhenix") {
    const signers = await hre.ethers.getSigners();

    if (
      (await hre.ethers.provider.getBalance(signers[0].address)).toString() ===
      "0"
    ) {
      await (hre as any).fhenixjs.getFunds(signers[0].address);
    }
  }
}
