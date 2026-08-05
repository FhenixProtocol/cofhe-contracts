import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { Contract, Wallet } from "ethers";

// Encryption type constants (must match Utils library in ICofhe.sol)
const EBOOL_TFHE = 0;
const EUINT8_TFHE = 2;
const EUINT32_TFHE = 4;
const EUINT64_TFHE = 5;

interface Input {
  ctHash: bigint;
  securityZone: number;
  utype: number;
  signature: string;
}

/**
 * Per-input message hash, matching TaskManager.inputMessageHash:
 * keccak256(abi.encodePacked(ctHash, utype, securityZone, sender, chainid, contractAddress)).
 * `contractAddress` is the consuming contract the input is bound to (msg.sender
 * as seen by TaskManager), so a direct EOA call binds to that account.
 */
function inputMessageHash(input: Input, sender: string, chainId: bigint, contractAddress: string): string {
  return ethers.solidityPackedKeccak256(
    ["uint256", "uint8", "uint8", "address", "uint256", "address"],
    [input.ctHash, input.utype, input.securityZone, sender, chainId, contractAddress]
  );
}

/**
 * Batch digest, matching TaskManager.extractBatchSigner:
 * keccak256(h_0 || h_1 || ... || h_n).
 */
function batchHash(inputs: Input[], sender: string, chainId: bigint, contractAddress: string): string {
  const hashes = inputs.map((input) => inputMessageHash(input, sender, chainId, contractAddress));
  return ethers.keccak256(ethers.concat(hashes));
}

/** Sign the batch digest the same way the verifier does (sign_prehash, no prefix). */
function signBatch(
  signer: Wallet,
  inputs: Input[],
  sender: string,
  chainId: bigint,
  contractAddress: string
): string {
  return signer.signingKey.sign(batchHash(inputs, sender, chainId, contractAddress)).serialized;
}

function makeInputs(): Input[] {
  return [
    { ctHash: 0x1111n << 16n, securityZone: 0, utype: EUINT8_TFHE, signature: "0x" },
    { ctHash: 0x2222n << 16n, securityZone: 0, utype: EUINT32_TFHE, signature: "0x" },
    { ctHash: 0x3333n << 16n, securityZone: 0, utype: EUINT64_TFHE, signature: "0x" },
  ];
}

export function shouldBehaveLikeBatchVerifyInput(): void {
  describe("batchVerifyInput", function () {
    it("verifies a batch with a single valid signature and returns one hash per input", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;
      const sender = (this.owner as { address: string }).address;
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const inputs = makeInputs();
      const signature = signBatch(testSigner, inputs, sender, chainId, sender);

      const result = await taskManager.batchVerifyInputs.staticCall(inputs, sender, signature);
      expect(result.length).to.equal(inputs.length);
      for (const appendedHash of result) {
        expect(appendedHash).to.not.equal(0n);
      }

      // Should not revert when actually executed.
      await taskManager.batchVerifyInputs(inputs, sender, signature);
    });

    it("reverts when the batch is signed by the wrong signer", async function () {
      const taskManager = this.taskManager as Contract;
      const sender = (this.owner as { address: string }).address;
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const inputs = makeInputs();
      const wrongSigner = ethers.Wallet.createRandom();
      const signature = signBatch(wrongSigner, inputs, sender, chainId, sender);

      await expect(
        taskManager.batchVerifyInputs(inputs, sender, signature)
      ).to.be.revertedWithCustomError(taskManager, "InvalidSigner");
    });

    it("reverts when an input is tampered with after signing", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;
      const sender = (this.owner as { address: string }).address;
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const inputs = makeInputs();
      const signature = signBatch(testSigner, inputs, sender, chainId, sender);

      // Mutate one input's ctHash so the reconstructed batch digest no longer matches.
      const tampered = makeInputs();
      tampered[1].ctHash = tampered[1].ctHash + (1n << 16n);

      await expect(
        taskManager.batchVerifyInputs(tampered, sender, signature)
      ).to.be.revertedWithCustomError(taskManager, "InvalidSigner");
    });

    it("skips signature verification in debug mode (verifierSigner == 0)", async function () {
      const taskManager = this.taskManager as Contract;
      const owner = this.owner as { address: string };
      const testSigner = this.testSigner as Wallet;
      const chainId = (await ethers.provider.getNetwork()).chainId;

      await (taskManager.connect(owner) as Contract).setVerifierSigner(ethers.ZeroAddress);

      const inputs = makeInputs();
      // Garbage signature is accepted because verification is disabled.
      const result = await taskManager.batchVerifyInputs.staticCall(inputs, owner.address, "0x");
      expect(result.length).to.equal(inputs.length);

      // Restore the signer so test ordering does not leak state.
      await (taskManager.connect(owner) as Contract).setVerifierSigner(testSigner.address);
    });
  });
}

export function shouldBehaveLikeBatchConverters(): void {
  describe("FHE batch converters", function () {
    it("asEuint8s returns the verified handles in input order", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;
      const owner = this.owner as { address: string };
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const batchInputs = (await ethers
        .getContractFactory("BatchInputsTest")
        .then((f) => f.deploy())) as unknown as Contract;
      await batchInputs.waitForDeployment();

      // asEuint8s pins securityZone to 0 and the utype to euint8.
      const ctHashes = [0xaaaan << 16n, 0xbbbbn << 16n, 0xccccn << 16n];
      const inputs: Input[] = ctHashes.map((ctHash) => ({
        ctHash,
        securityZone: 0,
        utype: EUINT8_TFHE,
        signature: "0x",
      }));
      // Expected handles come from TaskManager itself, called directly, so the
      // digest for that call binds to the EOA as both sender and contract.
      const directSignature = signBatch(testSigner, inputs, owner.address, chainId, owner.address);
      const expected = await taskManager.batchVerifyInputs.staticCall(inputs, owner.address, directSignature);

      // FHE.sol is inlined into the calling contract, so the digest for the real
      // path binds sender to the EOA and contract to BatchInputsTest.
      const signature = signBatch(testSigner, inputs, owner.address, chainId, await batchInputs.getAddress());

      const handles = ctHashes.map((ctHash) => ethers.zeroPadValue(ethers.toBeHex(ctHash), 32));
      await batchInputs.batchAsEuint8(handles, signature);

      expect(await batchInputs.lastHandlesLength()).to.equal(ctHashes.length);
      for (let i = 0; i < ctHashes.length; i++) {
        expect(BigInt(await batchInputs.lastHandles(i))).to.equal(expected[i]);
      }
    });

    it("asEuint8 verifies a single input as a batch of one", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;
      const owner = this.owner as { address: string };
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const batchInputs = (await ethers
        .getContractFactory("BatchInputsTest")
        .then((f) => f.deploy())) as unknown as Contract;
      await batchInputs.waitForDeployment();

      const ctHash = 0xfeedn << 16n;
      const inputs: Input[] = [{ ctHash, securityZone: 0, utype: EUINT8_TFHE, signature: "0x" }];

      const directSignature = signBatch(testSigner, inputs, owner.address, chainId, owner.address);
      const expected = await taskManager.batchVerifyInputs.staticCall(inputs, owner.address, directSignature);

      // Single-input asEuint8 goes through batchVerifyInputs with one element, so
      // the digest is keccak256(h_0) bound to BatchInputsTest as the consumer.
      const signature = signBatch(testSigner, inputs, owner.address, chainId, await batchInputs.getAddress());
      await batchInputs.singleAsEuint8(ethers.zeroPadValue(ethers.toBeHex(ctHash), 32), signature);

      expect(await batchInputs.lastHandlesLength()).to.equal(1);
      expect(BigInt(await batchInputs.lastHandles(0))).to.equal(expected[0]);
    });

    it("asEbools returns the verified handles in input order for the bytes[] overload", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;
      const owner = this.owner as { address: string };
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const batchInputs = (await ethers
        .getContractFactory("BatchInputsTest")
        .then((f) => f.deploy())) as unknown as Contract;
      await batchInputs.waitForDeployment();

      const ctHashes = [0xddddn << 16n, 0xeeeen << 16n];
      const inputs: Input[] = ctHashes.map((ctHash) => ({
        ctHash,
        securityZone: 0,
        utype: EBOOL_TFHE,
        signature: "0x",
      }));
      const directSignature = signBatch(testSigner, inputs, owner.address, chainId, owner.address);
      const expected = await taskManager.batchVerifyInputs.staticCall(inputs, owner.address, directSignature);

      const signature = signBatch(testSigner, inputs, owner.address, chainId, await batchInputs.getAddress());

      const encoded = inputs.map((input) =>
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint8", "uint8"],
          [input.ctHash, input.securityZone, input.utype]
        )
      );
      await batchInputs.batchAsEbool(encoded, signature);

      expect(await batchInputs.lastHandlesLength()).to.equal(ctHashes.length);
      for (let i = 0; i < ctHashes.length; i++) {
        expect(BigInt(await batchInputs.lastHandles(i))).to.equal(expected[i]);
      }
    });
  });
}
