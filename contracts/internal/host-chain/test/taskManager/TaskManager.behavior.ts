import { expect } from "chai";
import hre from "hardhat";

export function shouldBehaveLikeTaskManagerERC2771(): void {
  describe("ERC-2771 Meta-Transaction Support", function () {
    it("should have no trusted forwarder by default", async function () {
      const taskManager = this.taskManager.connect(this.signers.admin);

      const forwarder = await taskManager.trustedForwarder();
      expect(forwarder).to.equal(hre.ethers.ZeroAddress);
    });

    it("should correctly report isTrustedForwarder as false for zero address", async function () {
      const taskManager = this.taskManager.connect(this.signers.admin);

      const isTrusted = await taskManager.isTrustedForwarder(hre.ethers.ZeroAddress);
      expect(isTrusted).to.equal(false);
    });

    it("should correctly report isTrustedForwarder as false for random address", async function () {
      const taskManager = this.taskManager.connect(this.signers.admin);
      const randomAddress = "0x1234567890123456789012345678901234567890";

      const isTrusted = await taskManager.isTrustedForwarder(randomAddress);
      expect(isTrusted).to.equal(false);
    });

    it("should allow owner to set trusted forwarder", async function () {
      const taskManager = this.taskManager.connect(this.signers.admin);
      const forwarderAddress = "0x1234567890123456789012345678901234567890";

      await taskManager.setTrustedForwarder(forwarderAddress);

      const forwarder = await taskManager.trustedForwarder();
      expect(forwarder).to.equal(forwarderAddress);
    });

    it("should correctly report isTrustedForwarder after setting", async function () {
      const taskManager = this.taskManager.connect(this.signers.admin);
      const forwarderAddress = "0x1234567890123456789012345678901234567890";

      await taskManager.setTrustedForwarder(forwarderAddress);

      const isTrusted = await taskManager.isTrustedForwarder(forwarderAddress);
      expect(isTrusted).to.equal(true);

      // Other addresses should still be false
      const otherAddress = "0x9876543210987654321098765432109876543210";
      const isOtherTrusted = await taskManager.isTrustedForwarder(otherAddress);
      expect(isOtherTrusted).to.equal(false);
    });

    it("should allow owner to update trusted forwarder", async function () {
      const taskManager = this.taskManager.connect(this.signers.admin);
      const forwarderAddress1 = "0x1234567890123456789012345678901234567890";
      const forwarderAddress2 = "0x9876543210987654321098765432109876543210";

      await taskManager.setTrustedForwarder(forwarderAddress1);
      expect(await taskManager.trustedForwarder()).to.equal(forwarderAddress1);

      await taskManager.setTrustedForwarder(forwarderAddress2);
      expect(await taskManager.trustedForwarder()).to.equal(forwarderAddress2);

      // First forwarder should no longer be trusted
      expect(await taskManager.isTrustedForwarder(forwarderAddress1)).to.equal(false);
      expect(await taskManager.isTrustedForwarder(forwarderAddress2)).to.equal(true);
    });

    it("should allow owner to clear trusted forwarder by setting to zero address", async function () {
      const taskManager = this.taskManager.connect(this.signers.admin);
      const forwarderAddress = "0x1234567890123456789012345678901234567890";

      await taskManager.setTrustedForwarder(forwarderAddress);
      expect(await taskManager.trustedForwarder()).to.equal(forwarderAddress);

      await taskManager.setTrustedForwarder(hre.ethers.ZeroAddress);
      expect(await taskManager.trustedForwarder()).to.equal(hre.ethers.ZeroAddress);
      expect(await taskManager.isTrustedForwarder(forwarderAddress)).to.equal(false);
    });

    it("should revert when non-owner tries to set trusted forwarder", async function () {
      // Get a non-owner signer
      const signers = await hre.ethers.getSigners();
      const nonOwner = signers[1];

      if (!nonOwner) {
        console.log("Skipping test: no second signer available");
        return;
      }

      const taskManager = this.taskManager.connect(nonOwner);
      const forwarderAddress = "0x1234567890123456789012345678901234567890";

      await expect(
        taskManager.setTrustedForwarder(forwarderAddress)
      ).to.be.revertedWithCustomError(taskManager, "OwnableUnauthorizedAccount");
    });
  });
}
