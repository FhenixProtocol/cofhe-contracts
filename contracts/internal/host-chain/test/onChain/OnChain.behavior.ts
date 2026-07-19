import { expect } from "chai";
import hre from "hardhat";
import { TASK_MANAGER_ADDRESS } from "./OnChain.fixture";

export function shouldBehaveLikeOnChain(): void {
  it("trivial encrypts should not create permitted euints", async function () {
    const contract = this.testContract.connect(this.signers.admin);
    const contract2 = this.testContract2.connect(this.signers.admin);
    const taskManager = await hre.ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS);

    const types = ["Bool", "8", "16", "32"];
    for (const type of types) {
      const funcName = `trivial${type}`;
      console.log("funcName", funcName);
      await contract[funcName](1, 0);

      await expect(contract[`notAllowedPersistently${type}`]()).to.be.revertedWithCustomError(taskManager, "ACLNotAllowed");
      console.log(`verified revert for type ${type}`);
    }

    const types2 = ["64", "128"];
    for (const type of types2) {
      const funcName = `trivial${type}`;
      console.log("funcName", funcName);
      await contract2[funcName](1, 0);

      await expect(contract2[`notAllowedPersistently${type}`]()).to.be.revertedWithCustomError(taskManager, "ACLNotAllowed");
      console.log(`verified revert for type ${type}`);
    }

    console.log("funcname trivialAddress");
    await contract2.trivialAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");

    await expect(contract2.notAllowedPersistentlyAddress()).to.be.revertedWithCustomError(taskManager, "ACLNotAllowed");
    console.log(`verified revert for type Address`);

    console.log("funcName cantEncryptMoreThanMaxUint32");
    await expect(contract.cantEncryptMoreThanMaxUint32()).to.be.revertedWithCustomError(taskManager, "InvalidInputForFunction");

    console.log("funcName cantEncryptWithFakeUintType");
    await expect(contract.cantEncryptWithFakeUintType()).to.be.revertedWithCustomError(taskManager, "UnsupportedType");

    console.log("funcName cantEncryptWithFakeSecurityZone");
    await expect(contract.cantEncryptWithFakeSecurityZone()).to.be.revertedWithCustomError(taskManager, "InvalidSecurityZone");

    console.log("funcName cantCastWithFakeType");
    await expect(contract.cantCastWithFakeType()).to.be.revertedWithCustomError(taskManager, "UnsupportedType");
  });

  it("createTask rejects on-chain decrypt tasks", async function () {
    const taskManager = await hre.ethers.getContractAt("TaskManager", TASK_MANAGER_ADDRESS);
    const DECRYPT = 6; // FunctionId.decrypt — on-chain decrypt was removed (#63), decryption is off-chain
    await expect(
      taskManager.connect(this.signers.admin).createTask(0, DECRYPT, [], []),
    ).to.be.revertedWithCustomError(taskManager, "DecryptFunctionNotSupported");
  });
}
