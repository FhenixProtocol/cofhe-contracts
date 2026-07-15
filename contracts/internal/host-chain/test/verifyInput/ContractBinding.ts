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

/**
 * Reproduce the message TaskManager.extractSigner hashes and recovers against:
 *   keccak256(abi.encodePacked(ctHash, utype, securityZone, sender, chainId, contractAddress))
 * signed as a raw ECDSA digest (OZ ECDSA.recover, no EIP-191 prefix).
 */
function signInput(
  ctHash: bigint,
  utype: number,
  securityZone: number,
  sender: string,
  chainId: bigint,
  contractAddress: string
): string {
  const digest = ethers.solidityPackedKeccak256(
    ["uint256", "uint8", "uint8", "address", "uint256", "address"],
    [ctHash, utype, securityZone, sender, chainId, contractAddress]
  );
  const sig = VERIFIER.signingKey.sign(digest);
  return "0x" + sig.r.slice(2) + sig.s.slice(2) + sig.v.toString(16).padStart(2, "0");
}

describe("TaskManager verifyInput contract binding", function () {
  let taskManager: any;
  let owner: any;
  let caller: any; // stands in for the consuming contract (msg.sender)
  let user: any; // the account the input was encrypted for (sender)
  let chainId: bigint;

  const CT_HASH = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab0000n;

  before(async function () {
    await deployOnChainFixture();
    [owner, caller, user] = await ethers.getSigners();
    taskManager = await ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS);
    await taskManager.connect(owner).setVerifierSigner(VERIFIER.address);
    chainId = (await ethers.provider.getNetwork()).chainId;
  });

  it("accepts an input signed for the consuming contract (msg.sender)", async function () {
    // Signed with contractAddress = caller, and caller is the one calling verifyInput.
    const signature = signInput(CT_HASH, EUINT8, SECURITY_ZONE, user.address, chainId, caller.address);
    const input = { ctHash: CT_HASH, securityZone: SECURITY_ZONE, utype: EUINT8, signature };

    const handle = await taskManager.connect(caller).verifyInput.staticCall(input, user.address, input.signature);
    expect(handle).to.not.equal(0n);
    await expect(taskManager.connect(caller).verifyInput(input, user.address, input.signature)).to.not.be.reverted;
  });

  it("rejects replay into a different contract than the one signed for", async function () {
    // Verifier signed the input for `user`'s contract (user.address), but an attacker
    // contract (`caller`) tries to consume it. msg.sender != signed contractAddress,
    // so the recovered signer differs from verifierSigner.
    const signature = signInput(CT_HASH, EUINT8, SECURITY_ZONE, user.address, chainId, user.address);
    const input = { ctHash: CT_HASH, securityZone: SECURITY_ZONE, utype: EUINT8, signature };

    await expect(
      taskManager.connect(caller).verifyInput(input, user.address, input.signature)
    ).to.be.revertedWithCustomError(taskManager, "InvalidSigner");
  });

  it("still skips the check in debug mode (verifierSigner == address(0))", async function () {
    await taskManager.connect(owner).setVerifierSigner(ethers.ZeroAddress);
    // Bogus signature; debug mode must accept regardless of contract binding.
    const input = { ctHash: CT_HASH, securityZone: SECURITY_ZONE, utype: EUINT8, signature: "0x" };
    await expect(taskManager.connect(caller).verifyInput(input, user.address, input.signature)).to.not.be.reverted;
    await taskManager.connect(owner).setVerifierSigner(VERIFIER.address);
  });
});
