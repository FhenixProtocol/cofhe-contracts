/**
 * Every value-returning binding in FHE.sol, checked against its free-function form.
 *
 * There is no coprocessor on the hardhat network, so there is no plaintext to assert on.
 * Instead these pin the handles: TaskManager derives a handle as keccak256(operands || funcId)
 * with no nonce, so `ea.div(eb)` and `FHE.div(ea, eb)` must land on the same handle. A forwarder
 * that calls the wrong FHE function, or swaps its operands, produces a different handle and the
 * fixture reverts with the op name.
 *
 * Operands are distinct and non-zero in every call so an operand swap is observable and neither
 * collides with the zero constant that FHE.asEbool builds internally.
 *
 * Two ops are invisible here and are covered only by the delegation check: `square`, which
 * TaskManager rewrites to `mul` with a duplicated operand, and any op whose FHE implementation is
 * defined in terms of another op.
 */

import { expect } from "chai";
import hre from "hardhat";
import type { Contract } from "ethers";
import { deployOnChainFixture } from "../onChain/OnChain.fixture";

// Distinct so a swapped-operand forwarder changes the keccak preimage, and both non-zero:
// FHE.asEbool(euintN) is implemented as ne(value, asEuintN(0)), so an operand of 0 would BE that
// internal constant and make `ea.ne(eb)` and `ea.toBool()` pin the same handle.
const ADDR_A = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ADDR_B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("FHE.sol method bindings", function () {
  let bindings: Contract;

  before(async function () {
    await deployOnChainFixture();

    const factory = await hre.ethers.getContractFactory("Bindings");
    bindings = (await factory.deploy()) as unknown as Contract;
    await bindings.waitForDeployment();
  });

  it("ebool bindings delegate to the same handle", async function () {
    await expect(bindings.bindingsBool(true, false)).to.not.be.reverted;
  });

  it("euint8 bindings delegate to the same handle", async function () {
    await expect(bindings.bindings8(3, 5)).to.not.be.reverted;
  });

  it("euint16 bindings delegate to the same handle", async function () {
    await expect(bindings.bindings16(3, 5)).to.not.be.reverted;
  });

  it("euint32 bindings delegate to the same handle", async function () {
    await expect(bindings.bindings32(3, 5)).to.not.be.reverted;
  });

  it("euint64 bindings delegate to the same handle", async function () {
    await expect(bindings.bindings64(3, 5)).to.not.be.reverted;
  });

  it("euint128 bindings delegate to the same handle", async function () {
    await expect(bindings.bindings128(3, 5)).to.not.be.reverted;
  });

  it("eaddress bindings delegate to the same handle", async function () {
    await expect(bindings.bindingsAddress(ADDR_A, ADDR_B)).to.not.be.reverted;
  });
});
