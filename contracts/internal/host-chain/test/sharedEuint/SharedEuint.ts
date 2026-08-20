/**
 * sharedEuint — contract-to-contract encrypted value movement.
 *
 * Covers the round trip, the four ways a claim is rejected, cross-transaction expiry, and presenter
 * substitution. The last one is paired: the attack must revert against a receiver that follows the
 * call-edge rule AND succeed against one that does not. Without the second case the first assertion
 * passes vacuously whenever the setup is subtly wrong.
 *
 * There is no coprocessor on the hardhat network, so results have no plaintext to check. Instead the
 * tests pin the handles themselves — which handle the receiver got, which handle the `div` task was
 * created over, and whether the receiver's `FHE.allowThis` on the result succeeded (it can only
 * succeed if the share granted real access).
 */

import { expect } from "chai";
import hre from "hardhat";
import type { Contract } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { deployOnChainFixture, TASK_MANAGER_ADDRESS } from "../onChain/OnChain.fixture";

const BALANCE = 100n;
const OTHER_BALANCE = 777n;

async function deploy(name: string): Promise<Contract> {
  const factory = await hre.ethers.getContractFactory(name);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return contract as unknown as Contract;
}

describe("sharedEuint", function () {
  let taskManager: Contract;
  let acl: Contract;

  let vault: Contract, token: Contract, unsafeToken: Contract, attacker: Contract;
  let vaultAddr: string, tokenAddr: string, unsafeAddr: string, attackerAddr: string;
  let user: string;

  before(async function () {
    await deployOnChainFixture();

    const [owner] = await hre.ethers.getSigners();
    user = (owner as HardhatEthersSigner).address;

    taskManager = (await hre.ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS)) as unknown as Contract;
    acl = (await hre.ethers.getContractAt("ACL", await taskManager.acl())) as unknown as Contract;
  });

  // Fresh fixtures per test, so a dangling share or a stored handle never leaks between cases.
  beforeEach(async function () {
    vault = await deploy("SharedVault");
    token = await deploy("SharedToken");
    unsafeToken = await deploy("SharedTokenUnsafe");
    attacker = await deploy("SharedAttacker");

    vaultAddr = await vault.getAddress();
    tokenAddr = await token.getAddress();
    unsafeAddr = await unsafeToken.getAddress();
    attackerAddr = await attacker.getAddress();

    await vault.setBalance(user, BALANCE);
  });

  /// Every `div` task created in `receipt`, as parsed TaskCreated events.
  function divTasks(receipt: any) {
    return receipt.logs
      .filter((log: any) => log.address.toLowerCase() === TASK_MANAGER_ADDRESS.toLowerCase())
      .map((log: any) => taskManager.interface.parseLog({ topics: [...log.topics], data: log.data }))
      .filter((parsed: any) => parsed?.name === "TaskCreated" && parsed.args.operation === "div");
  }

  describe("round trip", function () {
    it("shares out, computes, and shares the result back", async function () {
      const balanceHandle = await vault.balanceHandle(user);

      const receipt = await (await vault.roundTrip(tokenAddr, user)).wait();

      // The token computed over the shared handle itself — one div task, left input is the
      // vault's balance handle.
      const divs = divTasks(receipt);
      expect(divs).to.have.lengthOf(1);
      expect(divs[0].args.input1).to.equal(BigInt(balanceHandle));

      // The result handed back is the handle the div task produced, and the same one the token
      // credited to the vault.
      const resultHandle = await vault.lastResultHandle();
      expect(BigInt(resultHandle)).to.not.equal(0n);
      expect(BigInt(resultHandle)).to.equal(divs[0].args.ctHash);
      expect(resultHandle).to.equal(await token.creditedHandle(vaultAddr));

      // `FHE.allowThis(result)` inside roundTrip() only succeeds if the returned share granted the
      // vault real access, so a persisted allowance is proof the receive worked.
      expect(await acl.persistAllowed(BigInt(resultHandle), vaultAddr)).to.equal(true);

      // The token saw the vault as its counterparty, not the EOA that started the transaction.
      expect(await token.lastCreditedTo()).to.equal(vaultAddr);
    });

    it("the receiver gets the sharer's handle, not a copy", async function () {
      await vault.roundTrip(tokenAddr, user);
      expect(await token.lastReceivedHandle()).to.equal(await vault.balanceHandle(user));
    });

    it("grants the receiver transient access only — nothing persists", async function () {
      await vault.roundTrip(tokenAddr, user);

      // The share only ever granted transient access to the balance handle; nothing persisted it.
      const balanceHandle = BigInt(await vault.balanceHandle(user));
      expect(await acl.persistAllowed(balanceHandle, tokenAddr)).to.equal(false);
      expect(await acl.allowedTransient(balanceHandle, tokenAddr)).to.equal(false);
    });
  });

  describe("claims that must fail", function () {
    it("rejects a second receive of the same share (single use)", async function () {
      await expect(vault.shareOnceReceiveTwice(tokenAddr, user)).to.be.revertedWithCustomError(acl, "NotShared");
    });

    it("rejects a handle that was never shared", async function () {
      await expect(vault.pullWithoutSharing(tokenAddr, user)).to.be.revertedWithCustomError(acl, "NotShared");
    });

    it("rejects a claim by a contract the share was not directed at", async function () {
      // Directed at unsafeAddr, presented to tokenAddr. The slot for the token's key was never
      // written, so this is NotShared rather than UnexpectedSharer.
      await expect(vault.shareToWrongReceiver(tokenAddr, unsafeAddr, user))
        .to.be.revertedWithCustomError(acl, "NotShared")
        .withArgs(BigInt(await vault.balanceHandle(user)), tokenAddr);
    });

    it("rejects sharing a handle the sharer is not allowed on", async function () {
      const otherVault = await deploy("SharedVault");
      await otherVault.setBalance(user, OTHER_BALANCE);
      const foreign = await otherVault.balanceHandle(user);

      await expect(vault.shareForeignHandle(tokenAddr, foreign))
        .to.be.revertedWithCustomError(acl, "SenderNotAllowed")
        .withArgs(vaultAddr);
    });

    it("does not carry a share across transactions", async function () {
      await vault.shareOnly(tokenAddr, user); // tx 1 — shared, never consumed
      await expect(vault.pullWithoutSharing(tokenAddr, user)) // tx 2
        .to.be.revertedWithCustomError(acl, "NotShared");
    });
  });

  describe("presenter substitution", function () {
    // The vault shares, its own call fails and is swallowed, and the slot stays live for the rest of
    // the transaction (the tstore survives because only the inner call reverted). The attacker then
    // presents that dangling share as its own — two sequential calls from a contract it controls, no
    // reentrancy.

    it("reverts when the receiver follows the call-edge rule", async function () {
      await token.setRevertOnPullFrom(vaultAddr);

      // Specifically the sharer/presenter mismatch — not NotShared (which would mean the slot never
      // dangled and the test proved nothing) and not ForcedRevert.
      await expect(attacker.attack(vaultAddr, tokenAddr, user))
        .to.be.revertedWithCustomError(acl, "UnexpectedSharer")
        .withArgs(attackerAddr, vaultAddr); // expected: who presented it, actual: who shared it

      // Nothing was credited to anyone.
      expect(await token.lastCreditedTo()).to.equal(hre.ethers.ZeroAddress);
    });

    it("succeeds when the receiver names a trusted sharer instead — the attack is real", async function () {
      await unsafeToken.setTrustedSharer(vaultAddr);
      await unsafeToken.setRevertOnPullFrom(vaultAddr);

      await attacker.attack(vaultAddr, unsafeAddr, user);

      // The dangling share was written by the vault, so naming the vault satisfies the check and the
      // attacker is credited with the victim's value.
      expect(await unsafeToken.lastCreditedTo()).to.equal(attackerAddr);
    });
  });

  describe("ACL entry points", function () {
    it("rejects share and receive calls that do not come from the TaskManager", async function () {
      const [owner] = await hre.ethers.getSigners();
      const handle = BigInt(await vault.balanceHandle(user));

      await expect(acl.shareCtHash(handle, vaultAddr, tokenAddr))
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(owner.address);

      await expect(acl.receiveCtHash(handle, vaultAddr, tokenAddr))
        .to.be.revertedWithCustomError(acl, "DirectAllowForbidden")
        .withArgs(owner.address);
    });

    it("is not gated by the task-intake access list", async function () {
      const [owner] = await hre.ethers.getSigners();
      await taskManager.connect(owner).enableAccessList();

      try {
        // Permission management stays open while task intake is restricted, same as
        // allow/allowGlobal/allowTransient. shareCtHash gets as far as the ACL's custody check.
        await expect(taskManager.connect(owner).shareCtHash(1n, tokenAddr))
          .to.be.revertedWithCustomError(acl, "SenderNotAllowed")
          .withArgs(owner.address);

        await expect(taskManager.connect(owner).receiveCtHash(1n, vaultAddr))
          .to.be.revertedWithCustomError(acl, "NotShared")
          .withArgs(1n, owner.address);
      } finally {
        await taskManager.connect(owner).disableAccessList();
      }
    });
  });
});
