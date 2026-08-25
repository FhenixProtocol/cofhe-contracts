import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { Wallet } from "ethers";
import { deployOnChainFixture } from "../onChain/OnChain.fixture";

// TaskManager is deployed at this fixed address by the fixture (ACL/PlaintextsStorage
// hardcode it, and ACL.allowTransient requires msg.sender to equal it).
const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

// euint8, within the fixture's configured security-zone range (-128..127).
const EUINT8 = 2;
const SECURITY_ZONE = 0;

// A known key so the test controls the verifier signer.
const VERIFIER = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

interface Input {
  ctHash: bigint;
  securityZone: number;
  utype: number;
}

/**
 * Reproduce the batch digest TaskManager.extractBatchSigner recovers against:
 *   keccak256(h_0 || ... || h_n), h_i = keccak256(abi.encodePacked(
 *     ctHash, utype, securityZone, sender, chainId, contractAddress))
 * signed as a raw ECDSA digest (OZ ECDSA.recover, no EIP-191 prefix).
 */
function signBatch(
  inputs: Input[],
  sender: string,
  chainId: bigint,
  contractAddress: string
): string {
  const hashes = inputs.map((input) =>
    ethers.solidityPackedKeccak256(
      ["uint256", "uint8", "uint8", "address", "uint256", "address"],
      [input.ctHash, input.utype, input.securityZone, sender, chainId, contractAddress]
    )
  );
  return VERIFIER.signingKey.sign(ethers.keccak256(ethers.concat(hashes))).serialized;
}

describe("TaskManager batchVerifyInputs contract binding", function () {
  let taskManager: any;
  let owner: any;
  let caller: any; // stands in for the consuming contract (msg.sender)
  let user: any; // the account the input was encrypted for (sender)
  let chainId: bigint;

  const CT_HASH = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab0000n;
  // A single input is a batch of one — the same path FHE.asEuint8 takes.
  const INPUTS: Input[] = [{ ctHash: CT_HASH, securityZone: SECURITY_ZONE, utype: EUINT8 }];

  before(async function () {
    await deployOnChainFixture();
    [owner, caller, user] = await ethers.getSigners();
    taskManager = await ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS);
    await taskManager.connect(owner).setVerifierSigner(VERIFIER.address);
    chainId = (await ethers.provider.getNetwork()).chainId;
  });

  it("accepts a batch signed for the consuming contract (msg.sender)", async function () {
    // Signed with contractAddress = caller, and caller is the one calling batchVerifyInputs.
    const signature = signBatch(INPUTS, user.address, chainId, caller.address);

    const handles = await taskManager
      .connect(caller)
      .batchVerifyInputs.staticCall(INPUTS, user.address, signature);
    expect(handles.length).to.equal(INPUTS.length);
    expect(handles[0]).to.not.equal(0n);
    await expect(taskManager.connect(caller).batchVerifyInputs(INPUTS, user.address, signature)).to.not.be
      .reverted;
  });

  it("rejects replay into a different contract than the one signed for", async function () {
    // Verifier signed the batch for `user`'s contract (user.address), but an attacker
    // contract (`caller`) tries to consume it. msg.sender != signed contractAddress,
    // so the recovered signer differs from verifierSigner.
    const signature = signBatch(INPUTS, user.address, chainId, user.address);

    await expect(
      taskManager.connect(caller).batchVerifyInputs(INPUTS, user.address, signature)
    ).to.be.revertedWithCustomError(taskManager, "InvalidSigner");
  });

  it("still skips the check in debug mode (verifierSigner == address(0))", async function () {
    await taskManager.connect(owner).setVerifierSigner(ethers.ZeroAddress);
    // Bogus signature; debug mode must accept regardless of contract binding.
    await expect(taskManager.connect(caller).batchVerifyInputs(INPUTS, user.address, "0x")).to.not.be
      .reverted;
    await taskManager.connect(owner).setVerifierSigner(VERIFIER.address);
  });
});
