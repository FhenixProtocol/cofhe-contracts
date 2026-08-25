/**
 * Every value-returning binding in FHE.sol, checked against its free-function form.
 *
 * There is no coprocessor on the hardhat network, so there is no plaintext to assert on.
 * Instead these pin the handles: TaskManager derives a handle as keccak256(operands || funcId)
 * with no nonce, so `ea.div(eb)` and `FHE.div(ea, eb)` must land on the same handle. A forwarder
 * that calls the wrong FHE function, or swaps its operands, produces a different handle and the
 * fixture reverts with the op name.
 *
 * Operands are distinct in every call so an operand swap is observable.
 */

import { expect } from "chai";
import hre from "hardhat";
import type { Contract } from "ethers";
import { deployOnChainFixture } from "../onChain/OnChain.fixture";

// Distinct so a swapped-operand forwarder changes the keccak preimage.
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
    await expect(bindings.bindings8(1, 0)).to.not.be.reverted;
  });

  it("euint16 bindings delegate to the same handle", async function () {
    await expect(bindings.bindings16(1, 0)).to.not.be.reverted;
  });

  it("euint32 bindings delegate to the same handle", async function () {
    await expect(bindings.bindings32(1, 0)).to.not.be.reverted;
  });

  it("euint64 bindings delegate to the same handle", async function () {
    await expect(bindings.bindings64(1, 0)).to.not.be.reverted;
  });

  it("euint128 bindings delegate to the same handle", async function () {
    await expect(bindings.bindings128(1, 0)).to.not.be.reverted;
  });

  it("eaddress bindings delegate to the same handle", async function () {
    await expect(bindings.bindingsAddress(ADDR_A, ADDR_B)).to.not.be.reverted;
  });
});
