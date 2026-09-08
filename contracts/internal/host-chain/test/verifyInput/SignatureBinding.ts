/**
 * Input signature field binding — every field in the verifier's preimage is load-bearing.
 *
 * `batchVerifyInputs` recovers the signer from
 *   keccak256(h_0 || ... || h_n),  h_i = keccak256(abi.encodePacked(
 *     ctHash, utype, securityZone, sender, chainid, contractAddress))
 * so a signature is valid for exactly one (ctHash, type, zone, sender, chain, contract) tuple.
 *
 * Each test signs over a tuple with ONE field changed and then submits the unchanged, known-good
 * call. If that field were missing from the preimage the mutated signature would still recover to
 * `verifierSigner` and the call would succeed — so a revert is proof the field is bound. Mutating
 * the signature rather than the call keeps every test's on-chain arguments identical, which rules
 * out a revert that came from somewhere other than signer recovery.
 *
 * `contractAddress` binding is covered separately in ContractBinding.ts.
 */

import { expect } from "chai";
import hre from "hardhat";
import { Wallet } from "ethers";

import { deployOnChainFixture, TASK_MANAGER_ADDRESS } from "../onChain/OnChain.fixture";

const { ethers } = hre;

const EUINT8 = 2;
const EUINT32 = 4;
const SECURITY_ZONE = 0;
// A second zone inside the fixture's configured range (-128..127).
const OTHER_SECURITY_ZONE = 1;

// A known key so the test controls the verifier signer.
const VERIFIER = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

interface SignedTuple {
  ctHash: bigint;
  utype: number;
  securityZone: number;
  sender: string;
  chainId: bigint;
  contractAddress: string;
}

/** The batch digest for a single input, signed as a raw ECDSA digest (no EIP-191 prefix). */
function sign(tuple: SignedTuple): string {
  const inputHash = ethers.solidityPackedKeccak256(
    ["uint256", "uint8", "uint8", "address", "uint256", "address"],
    [tuple.ctHash, tuple.utype, tuple.securityZone, tuple.sender, tuple.chainId, tuple.contractAddress]
  );
  return VERIFIER.signingKey.sign(ethers.keccak256(inputHash)).serialized;
}

describe("TaskManager batchVerifyInputs signature field binding", function () {
  let taskManager: any;
  let owner: any;
  let caller: any; // the consuming contract (msg.sender as TaskManager sees it)
  let user: any; // the account the input was encrypted for (sender)
  let attacker: any;

  // The one tuple every test submits on chain. Only the *signed* tuple varies.
  let signedTuple: SignedTuple;

  const CT_HASH = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab0000n;

  /** Sign over `signedTuple` with `overrides` applied, then submit the unchanged call. */
  function submitSignedWith(overrides: Partial<SignedTuple>) {
    const signature = sign({ ...signedTuple, ...overrides });
    const inputs = [{ ctHash: signedTuple.ctHash, securityZone: signedTuple.securityZone, utype: signedTuple.utype }];
    return taskManager.connect(caller).batchVerifyInputs(inputs, signedTuple.sender, signature);
  }

  before(async function () {
    await deployOnChainFixture();
    [owner, caller, user, attacker] = await ethers.getSigners();
    taskManager = await ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS);
    await taskManager.connect(owner).setVerifierSigner(VERIFIER.address);

    signedTuple = {
      ctHash: CT_HASH,
      utype: EUINT8,
      securityZone: SECURITY_ZONE,
      sender: user.address,
      chainId: (await ethers.provider.getNetwork()).chainId,
      contractAddress: caller.address,
    };
  });

  it("accepts the batch when every signed field matches the call", async function () {
    await expect(submitSignedWith({})).to.not.be.reverted;
  });

  it("rejects a signature made for a different ctHash", async function () {
    await expect(submitSignedWith({ ctHash: CT_HASH + (1n << 16n) })).to.be.revertedWithCustomError(
      taskManager,
      "InvalidSigner"
    );
  });

  it("rejects a signature made for a different type", async function () {
    await expect(submitSignedWith({ utype: EUINT32 })).to.be.revertedWithCustomError(
      taskManager,
      "InvalidSigner"
    );
  });

  it("rejects a signature made for a different security zone", async function () {
    await expect(submitSignedWith({ securityZone: OTHER_SECURITY_ZONE })).to.be.revertedWithCustomError(
      taskManager,
      "InvalidSigner"
    );
  });

  it("rejects a signature made for a different sender", async function () {
    await expect(submitSignedWith({ sender: attacker.address })).to.be.revertedWithCustomError(
      taskManager,
      "InvalidSigner"
    );
  });

  it("rejects a signature made for a different chainId", async function () {
    // block.chainid is fixed on the hardhat network, so the cross-chain replay is expressed the
    // other way round: a signature carrying a foreign chainId must not verify on this one.
    await expect(submitSignedWith({ chainId: signedTuple.chainId + 1n })).to.be.revertedWithCustomError(
      taskManager,
      "InvalidSigner"
    );
  });

  it("rejects a batch whose inputs are reordered after signing", async function () {
    // The digest concatenates per-input hashes in order, so position is part of what is signed
    // even when the multiset of inputs is unchanged.
    const inputs = [
      { ctHash: CT_HASH, securityZone: SECURITY_ZONE, utype: EUINT8 },
      { ctHash: CT_HASH + (1n << 16n), securityZone: SECURITY_ZONE, utype: EUINT8 },
    ];
    const hashes = inputs.map((input) =>
      ethers.solidityPackedKeccak256(
        ["uint256", "uint8", "uint8", "address", "uint256", "address"],
        [
          input.ctHash,
          input.utype,
          input.securityZone,
          signedTuple.sender,
          signedTuple.chainId,
          signedTuple.contractAddress,
        ]
      )
    );
    const signature = VERIFIER.signingKey.sign(ethers.keccak256(ethers.concat(hashes))).serialized;

    await expect(
      taskManager.connect(caller).batchVerifyInputs([...inputs].reverse(), signedTuple.sender, signature)
    ).to.be.revertedWithCustomError(taskManager, "InvalidSigner");
  });
});
