import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { Wallet, keccak256, toUtf8Bytes, getBytes, zeroPadValue, toBeHex } from "ethers";

// Encryption type constants (must match Utils library in ICofhe.sol)
const EUINT8_TFHE = 2;
const EUINT16_TFHE = 3;
const EUINT32_TFHE = 4;
const EUINT64_TFHE = 5;
const EUINT128_TFHE = 6;
const EADDRESS_TFHE = 7;
const EBOOL_TFHE = 0;

/**
 * Build a ctHash with embedded type metadata
 * Format: keccak256(data)[0:30] || type (1 byte) || security_zone (1 byte)
 */
function buildCtHash(baseHash: string, encryptionType: number, securityZone: number = 0): bigint {
  const hash = BigInt(baseHash);
  // Clear the last 2 bytes (16 bits)
  const maskedHash = hash & (~BigInt(0xFFFF));
  // Embed type in bits 8-14 (7 bits for type, 1 bit for trivial flag)
  const typeShifted = BigInt(encryptionType) << BigInt(8);
  // Security zone in last byte
  const szByte = BigInt(securityZone & 0xFF);
  return maskedHash | typeShifted | szByte;
}

/**
 * Compute the message hash that matches Solidity's _computeDecryptResultHash assembly
 * Format: result (32) || enc_type (4) || chain_id (8) || ct_hash (32) = 76 bytes
 */
function computeDecryptResultHash(
  result: bigint,
  encryptionType: number,
  chainId: bigint,
  ctHash: bigint
): string {
  // Build 76-byte buffer exactly matching Solidity assembly
  const buffer = new Uint8Array(76);

  // result: 32 bytes (big-endian)
  const resultBytes = getBytes(zeroPadValue(toBeHex(result), 32));
  buffer.set(resultBytes, 0);

  // encryption_type: 4 bytes (i32, big-endian)
  const encTypeBytes = new Uint8Array(4);
  encTypeBytes[0] = (encryptionType >> 24) & 0xFF;
  encTypeBytes[1] = (encryptionType >> 16) & 0xFF;
  encTypeBytes[2] = (encryptionType >> 8) & 0xFF;
  encTypeBytes[3] = encryptionType & 0xFF;
  buffer.set(encTypeBytes, 32);

  // chain_id: 8 bytes (u64, big-endian)
  const chainIdBytes = new Uint8Array(8);
  const chainIdBigInt = BigInt(chainId);
  for (let i = 7; i >= 0; i--) {
    chainIdBytes[7 - i] = Number((chainIdBigInt >> BigInt(i * 8)) & BigInt(0xFF));
  }
  buffer.set(chainIdBytes, 36);

  // ct_hash: 32 bytes (big-endian)
  const ctHashBytes = getBytes(zeroPadValue(toBeHex(ctHash), 32));
  buffer.set(ctHashBytes, 44);

  return keccak256(buffer);
}

/**
 * Sign a decrypt result using the same format as the TN dispatcher
 */
async function signDecryptResult(
  signer: Wallet,
  result: bigint,
  encryptionType: number,
  chainId: bigint,
  ctHash: bigint
): Promise<string> {
  // Compute message hash matching Solidity's assembly
  const messageHash = computeDecryptResultHash(result, encryptionType, chainId, ctHash);

  // Sign the hash directly (not with personal_sign prefix - matches TN's sign_prehash)
  const signature = signer.signingKey.sign(messageHash);

  // Return 65-byte signature as hex (r + s + v)
  return signature.r.slice(2) + signature.s.slice(2) + signature.v.toString(16).padStart(2, "0");
}

export function shouldBehaveLikeDecryptResult(): void {
  describe("publishDecryptResult", function () {
    it("should store result with valid signature", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const baseHash = keccak256(toUtf8Bytes("test-cthash-1"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(42);

      const signature = await signDecryptResult(
        testSigner,
        result,
        EUINT64_TFHE,
        chainId,
        ctHash
      );

      // Publish the result
      const tx = await taskManager.publishDecryptResult(
        ctHash,
        result,
        "0x" + signature
      );
      await tx.wait();

      // Verify result was stored
      const [storedResult, exists] = await taskManager.getDecryptResultSafe(ctHash);
      expect(exists).to.be.true;
      expect(storedResult).to.equal(result);
    });

    it("should emit DecryptionResult event", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const baseHash = keccak256(toUtf8Bytes("test-cthash-event"));
      const ctHash = buildCtHash(baseHash, EUINT32_TFHE);
      const result = BigInt(123);

      const signature = await signDecryptResult(
        testSigner,
        result,
        EUINT32_TFHE,
        chainId,
        ctHash
      );

      await expect(
        taskManager.publishDecryptResult(ctHash, result, "0x" + signature)
      ).to.emit(taskManager, "DecryptionResult");
    });

    it("should revert with invalid signature", async function () {
      const taskManager = this.taskManager as Contract;

      const baseHash = keccak256(toUtf8Bytes("test-cthash-invalid"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(99);

      // Create a fake signature (65 bytes of zeros won't work)
      const fakeSignature = "0x" + "00".repeat(65);

      // OpenZeppelin's ECDSA.recover throws ECDSAInvalidSignature for malformed signatures
      await expect(
        taskManager.publishDecryptResult(ctHash, result, fakeSignature)
      ).to.be.reverted;
    });

    it("should revert with wrong signer", async function () {
      const taskManager = this.taskManager as Contract;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const baseHash = keccak256(toUtf8Bytes("test-cthash-wrong-signer"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(55);

      // Sign with a different key
      const wrongSigner = new ethers.Wallet(
        "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        ethers.provider
      );

      const signature = await signDecryptResult(
        wrongSigner,
        result,
        EUINT64_TFHE,
        chainId,
        ctHash
      );

      await expect(
        taskManager.publishDecryptResult(ctHash, result, "0x" + signature)
      ).to.be.revertedWithCustomError(taskManager, "InvalidSigner");
    });

    it("should revert with tampered result", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const baseHash = keccak256(toUtf8Bytes("test-cthash-tampered"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const originalResult = BigInt(100);
      const tamperedResult = BigInt(999); // Different from signed value

      // Sign with original result
      const signature = await signDecryptResult(
        testSigner,
        originalResult,
        EUINT64_TFHE,
        chainId,
        ctHash
      );

      // Try to publish with tampered result
      await expect(
        taskManager.publishDecryptResult(ctHash, tamperedResult, "0x" + signature)
      ).to.be.revertedWithCustomError(taskManager, "InvalidSigner");
    });

    it("should work with different encryption types", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const encryptionTypes = [EBOOL_TFHE, EUINT8_TFHE, EUINT16_TFHE, EUINT32_TFHE, EUINT64_TFHE, EUINT128_TFHE];

      for (const encType of encryptionTypes) {
        const baseHash = keccak256(toUtf8Bytes(`test-cthash-type-${encType}`));
        const ctHash = buildCtHash(baseHash, encType);
        const result = BigInt(encType + 10);

        const signature = await signDecryptResult(
          testSigner,
          result,
          encType,
          chainId,
          ctHash
        );

        const tx = await taskManager.publishDecryptResult(
          ctHash,
          result,
          "0x" + signature
        );
        await tx.wait();

        const [storedResult, exists] = await taskManager.getDecryptResultSafe(ctHash);
        expect(exists).to.be.true;
        expect(storedResult).to.equal(result);
      }
    });
  });

  describe("publishDecryptResultBatch", function () {
    it("should store multiple results in one transaction", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const count = 3;
      const ctHashes: bigint[] = [];
      const results: bigint[] = [];
      const signatures: string[] = [];

      for (let i = 0; i < count; i++) {
        const baseHash = keccak256(toUtf8Bytes(`batch-cthash-${i}`));
        const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
        const result = BigInt(i * 100 + 1);

        const signature = await signDecryptResult(
          testSigner,
          result,
          EUINT64_TFHE,
          chainId,
          ctHash
        );

        ctHashes.push(ctHash);
        results.push(result);
        signatures.push("0x" + signature);
      }

      const tx = await taskManager.publishDecryptResultBatch(
        ctHashes,
        results,
        signatures
      );
      await tx.wait();

      // Verify all results were stored
      for (let i = 0; i < count; i++) {
        const [storedResult, exists] = await taskManager.getDecryptResultSafe(ctHashes[i]);
        expect(exists).to.be.true;
        expect(storedResult).to.equal(results[i]);
      }
    });

    it("should revert entire batch if one signature is invalid", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const ctHashes: bigint[] = [];
      const results: bigint[] = [];
      const signatures: string[] = [];

      // First valid entry
      const baseHash1 = keccak256(toUtf8Bytes("batch-fail-1"));
      const ctHash1 = buildCtHash(baseHash1, EUINT64_TFHE);
      const result1 = BigInt(111);
      const sig1 = await signDecryptResult(testSigner, result1, EUINT64_TFHE, chainId, ctHash1);

      ctHashes.push(ctHash1);
      results.push(result1);
      signatures.push("0x" + sig1);

      // Second invalid entry (bad signature)
      const baseHash2 = keccak256(toUtf8Bytes("batch-fail-2"));
      const ctHash2 = buildCtHash(baseHash2, EUINT64_TFHE);
      const result2 = BigInt(222);

      ctHashes.push(ctHash2);
      results.push(result2);
      signatures.push("0x" + "00".repeat(65)); // Invalid signature

      // OpenZeppelin's ECDSA.recover throws ECDSAInvalidSignature for malformed signatures
      await expect(
        taskManager.publishDecryptResultBatch(ctHashes, results, signatures)
      ).to.be.reverted;

      // First entry should NOT have been stored (atomic)
      const [, exists1] = await taskManager.getDecryptResultSafe(ctHash1);
      expect(exists1).to.be.false;
    });

    it("should revert on length mismatch", async function () {
      const taskManager = this.taskManager as Contract;

      await expect(
        taskManager.publishDecryptResultBatch(
          [BigInt(1), BigInt(2)],
          [BigInt(10)], // Length mismatch
          ["0x" + "00".repeat(65)]
        )
      ).to.be.revertedWith("Length mismatch");
    });
  });

  describe("verifyDecryptResult", function () {
    it("should return true for valid signature", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const baseHash = keccak256(toUtf8Bytes("verify-cthash-valid"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(777);

      const signature = await signDecryptResult(
        testSigner,
        result,
        EUINT64_TFHE,
        chainId,
        ctHash
      );

      const isValid = await taskManager.verifyDecryptResult(
        ctHash,
        result,
        "0x" + signature
      );
      expect(isValid).to.be.true;
    });

    it("should not modify state (view function)", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const baseHash = keccak256(toUtf8Bytes("verify-no-state"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(888);

      const signature = await signDecryptResult(
        testSigner,
        result,
        EUINT64_TFHE,
        chainId,
        ctHash
      );

      // Call verify
      await taskManager.verifyDecryptResult(ctHash, result, "0x" + signature);

      // Result should NOT be stored
      const [, exists] = await taskManager.getDecryptResultSafe(ctHash);
      expect(exists).to.be.false;
    });

    it("should revert for invalid signature", async function () {
      const taskManager = this.taskManager as Contract;

      const baseHash = keccak256(toUtf8Bytes("verify-invalid"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(999);

      // OpenZeppelin's ECDSA.recover throws ECDSAInvalidSignature for malformed signatures
      await expect(
        taskManager.verifyDecryptResult(ctHash, result, "0x" + "00".repeat(65))
      ).to.be.reverted;
    });
  });

  describe("Debug mode (signer = address(0))", function () {
    it("should skip verification when decryptResultSigner is address(0)", async function () {
      const taskManager = this.taskManager as Contract;
      const owner = this.owner;

      // Set signer to address(0) to enable debug mode
      await taskManager.connect(owner).setDecryptResultSigner(ethers.ZeroAddress);

      const baseHash = keccak256(toUtf8Bytes("debug-mode-test"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(12345);

      // Should succeed with any signature (even invalid)
      const tx = await taskManager.publishDecryptResult(
        ctHash,
        result,
        "0x" + "00".repeat(65)
      );
      await tx.wait();

      const [storedResult, exists] = await taskManager.getDecryptResultSafe(ctHash);
      expect(exists).to.be.true;
      expect(storedResult).to.equal(result);

      // Restore signer for other tests
      await taskManager.connect(owner).setDecryptResultSigner(this.testSigner.address);
    });

    it("verifyDecryptResult should return true in debug mode", async function () {
      const taskManager = this.taskManager as Contract;
      const owner = this.owner;

      await taskManager.connect(owner).setDecryptResultSigner(ethers.ZeroAddress);

      const baseHash = keccak256(toUtf8Bytes("debug-verify"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(54321);

      const isValid = await taskManager.verifyDecryptResult(
        ctHash,
        result,
        "0x" + "00".repeat(65)
      );
      expect(isValid).to.be.true;

      // Restore signer
      await taskManager.connect(owner).setDecryptResultSigner(this.testSigner.address);
    });
  });

  describe("setDecryptResultSigner", function () {
    it("should emit DecryptResultSignerChanged event", async function () {
      const taskManager = this.taskManager as Contract;
      const owner = this.owner;
      const testSigner = this.testSigner as Wallet;

      const newSigner = ethers.Wallet.createRandom().address;

      await expect(taskManager.connect(owner).setDecryptResultSigner(newSigner))
        .to.emit(taskManager, "DecryptResultSignerChanged")
        .withArgs(testSigner.address, newSigner);

      // Restore original signer
      await taskManager.connect(owner).setDecryptResultSigner(testSigner.address);
    });

    it("should only be callable by owner", async function () {
      const taskManager = this.taskManager as Contract;
      const otherAccount = this.otherAccount;

      const newSigner = ethers.Wallet.createRandom().address;

      await expect(
        taskManager.connect(otherAccount).setDecryptResultSigner(newSigner)
      ).to.be.revertedWithCustomError(taskManager, "OwnableUnauthorizedAccount");
    });
  });

  describe("setVerifierSigner", function () {
    it("should emit VerifierSignerChanged event", async function () {
      const taskManager = this.taskManager as Contract;
      const owner = this.owner;

      const originalSigner = await taskManager.verifierSigner();
      const newSigner = ethers.Wallet.createRandom().address;

      await expect(taskManager.connect(owner).setVerifierSigner(newSigner))
        .to.emit(taskManager, "VerifierSignerChanged")
        .withArgs(originalSigner, newSigner);

      // Restore original signer
      await taskManager.connect(owner).setVerifierSigner(originalSigner);
    });

    it("should only be callable by owner", async function () {
      const taskManager = this.taskManager as Contract;
      const otherAccount = this.otherAccount;

      const newSigner = ethers.Wallet.createRandom().address;

      await expect(
        taskManager.connect(otherAccount).setVerifierSigner(newSigner)
      ).to.be.revertedWithCustomError(taskManager, "OwnableUnauthorizedAccount");
    });
  });

  describe("verifyDecryptResultSafe", function () {
    it("should return true for valid signature", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const baseHash = keccak256(toUtf8Bytes("verify-safe-valid"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(777);

      const signature = await signDecryptResult(
        testSigner,
        result,
        EUINT64_TFHE,
        chainId,
        ctHash
      );

      const isValid = await taskManager.verifyDecryptResultSafe(
        ctHash,
        result,
        "0x" + signature
      );
      expect(isValid).to.be.true;
    });

    it("should return false for invalid signature (not revert)", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const baseHash = keccak256(toUtf8Bytes("verify-safe-invalid"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(999);

      // Sign with correct signer but wrong result (simulates tampered data)
      const signature = await signDecryptResult(
        testSigner,
        BigInt(123), // Different result than what we'll verify
        EUINT64_TFHE,
        chainId,
        ctHash
      );

      // Should return false, NOT revert
      const isValid = await taskManager.verifyDecryptResultSafe(
        ctHash,
        result,
        "0x" + signature
      );
      expect(isValid).to.be.false;
    });

    it("should return false for wrong signer (not revert)", async function () {
      const taskManager = this.taskManager as Contract;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const baseHash = keccak256(toUtf8Bytes("verify-safe-wrong-signer"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(555);

      // Sign with a different key
      const wrongSigner = new ethers.Wallet(
        "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        ethers.provider
      );

      const signature = await signDecryptResult(
        wrongSigner,
        result,
        EUINT64_TFHE,
        chainId,
        ctHash
      );

      // Should return false, NOT revert
      const isValid = await taskManager.verifyDecryptResultSafe(
        ctHash,
        result,
        "0x" + signature
      );
      expect(isValid).to.be.false;
    });

    it("should return true in debug mode (signer = address(0))", async function () {
      const taskManager = this.taskManager as Contract;
      const owner = this.owner;
      const testSigner = this.testSigner as Wallet;

      // Set signer to address(0) to enable debug mode
      await taskManager.connect(owner).setDecryptResultSigner(ethers.ZeroAddress);

      const baseHash = keccak256(toUtf8Bytes("verify-safe-debug"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(12345);

      // Should return true with any signature in debug mode
      const isValid = await taskManager.verifyDecryptResultSafe(
        ctHash,
        result,
        "0x" + "00".repeat(65)
      );
      expect(isValid).to.be.true;

      // Restore signer
      await taskManager.connect(owner).setDecryptResultSigner(testSigner.address);
    });

    it("should not modify state (view function)", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;

      const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const baseHash = keccak256(toUtf8Bytes("verify-safe-no-state"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(888);

      const signature = await signDecryptResult(
        testSigner,
        result,
        EUINT64_TFHE,
        chainId,
        ctHash
      );

      // Call verifySafe
      await taskManager.verifyDecryptResultSafe(ctHash, result, "0x" + signature);

      // Result should NOT be stored
      const [, exists] = await taskManager.getDecryptResultSafe(ctHash);
      expect(exists).to.be.false;
    });
  });

  describe("Cross-chain replay protection", function () {
    it("signature for one chain should not work on another", async function () {
      const taskManager = this.taskManager as Contract;
      const testSigner = this.testSigner as Wallet;

      const actualChainId = BigInt((await ethers.provider.getNetwork()).chainId);
      const fakeChainId = actualChainId + BigInt(1);

      const baseHash = keccak256(toUtf8Bytes("replay-test"));
      const ctHash = buildCtHash(baseHash, EUINT64_TFHE);
      const result = BigInt(555);

      // Sign for a different chain
      const signature = await signDecryptResult(
        testSigner,
        result,
        EUINT64_TFHE,
        fakeChainId, // Wrong chain
        ctHash
      );

      // Should fail because chainId in signature doesn't match block.chainid
      await expect(
        taskManager.publishDecryptResult(ctHash, result, "0x" + signature)
      ).to.be.revertedWithCustomError(taskManager, "InvalidSigner");
    });
  });
}
