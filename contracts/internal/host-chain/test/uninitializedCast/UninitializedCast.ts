/**
 * The asEuintN casts from ebool, euintN and eaddress, and their toU* bindings, treat an
 * uninitialized (zero) handle as an encrypted zero of the source type, as the arithmetic,
 * comparison, bitwise and select helpers already do.
 *
 * There is no coprocessor on the hardhat network, so there is no plaintext to assert on. Handles
 * are content-addressed (TaskManager derives them from the operands and the function id, with no
 * nonce), so each probe in UninitializedCast.sol casts a never-written mapping slot and an explicit
 * encrypted zero, emits both handles and requires them to be equal. The test reads the event and
 * checks that the handle is non-zero, equal to the reference and of the target type.
 */

import { expect } from "chai";
import hre from "hardhat";
import type { Contract } from "ethers";
import { deployOnChainFixture } from "../onChain/OnChain.fixture";

const { ethers } = hre;

const EUINT8_TFHE = 2;
const EUINT32_TFHE = 4;
const EUINT64_TFHE = 5;
const EUINT128_TFHE = 6;

// Handle layout, low bytes: ... || isTrivial (1 bit) | uintType (7 bits) || securityZone (1 byte)
function handleType(handle: bigint): number {
  return Number((handle >> 8n) & 0x7fn);
}

async function castHandles(contract: Contract, tx: any): Promise<{ got: bigint; want: bigint }> {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    let parsed;
    try {
      parsed = contract.interface.parseLog(log);
    } catch {
      continue; // not a probe log
    }
    if (parsed?.name === "Cast") return { got: BigInt(parsed.args.got), want: BigInt(parsed.args.want) };
  }
  throw new Error("Cast event not found");
}

describe("FHE.sol casts of an uninitialized handle", function () {
  let probe: Contract;
  let user: string;

  before(async function () {
    await deployOnChainFixture();

    const factory = await ethers.getContractFactory("UninitializedCast");
    probe = (await factory.deploy()) as unknown as Contract;
    await probe.waitForDeployment();

    [, { address: user }] = await ethers.getSigners();
  });

  const cases: Array<{ name: string; fn: string; toType: number }> = [
    { name: "upcast euint32 -> euint64 casts an encrypted zero", fn: "upcast", toType: EUINT64_TFHE },
    { name: "downcast euint64 -> euint8 casts an encrypted zero", fn: "downcast", toType: EUINT8_TFHE },
    { name: "euint64.toU128() casts an encrypted zero", fn: "binding", toType: EUINT128_TFHE },
    { name: "ebool -> euint32 casts an encrypted false", fn: "fromBool", toType: EUINT32_TFHE },
    { name: "eaddress -> euint128 casts an encrypted address(0)", fn: "fromAddress", toType: EUINT128_TFHE },
    { name: "add (reference) treats an uninitialized operand as an encrypted zero", fn: "add", toType: EUINT64_TFHE },
  ];

  for (const { name, fn, toType } of cases) {
    it(name, async function () {
      const { got, want } = await castHandles(probe, await probe[fn](user));
      expect(got).to.not.equal(0n);
      expect(got).to.equal(want);
      expect(handleType(got)).to.equal(toType);
    });
  }

  it("an initialized value is cast as itself, not replaced by zero", async function () {
    const { got, want } = await castHandles(probe, await probe.initialized(7));
    expect(got).to.not.equal(0n);
    expect(got).to.not.equal(want);
    expect(handleType(got)).to.equal(EUINT64_TFHE);
  });
});
