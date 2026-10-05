import { expect } from "chai";
import hre from "hardhat";

import { deployOnChainFixture } from "../onChain/OnChain.fixture";
import { addressBookAddress, taskManagerId } from "../../utils/addressBook";

const { ethers } = hre;

const CT_HASH = ethers.zeroPadValue("0x1234", 32);
const SIGNATURE = "0x" + "11".repeat(65);

async function deploySafeVariants(): Promise<any> {
  const Factory = await ethers.getContractFactory("SafeVariantsTest");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();
  return contract;
}

async function expectSafeDefaults(contract: any): Promise<void> {
  const [result, decrypted] = await contract.getDecryptResultSafe(CT_HASH);
  expect(result).to.equal(0n);
  expect(decrypted).to.equal(false);

  expect(await contract.verifyDecryptResultSafe(CT_HASH, 7, SIGNATURE)).to.equal(false);

  const batch = await contract.verifyDecryptResultBatchSafe(
    [CT_HASH, CT_HASH, CT_HASH],
    [1, 2, 3],
    [SIGNATURE, SIGNATURE, SIGNATURE],
  );
  expect(batch).to.deep.equal([false, false, false]);
}

describe("Safe FHE variants tolerate a missing TaskManager", function () {
  it("still read through the TaskManager while it is registered", async function () {
    const { taskManagerAddress, plaintextsStorage } = await deployOnChainFixture();
    const contract = await deploySafeVariants();

    await ethers.provider.send("hardhat_impersonateAccount", [taskManagerAddress]);
    await ethers.provider.send("hardhat_setBalance", [taskManagerAddress, "0x" + (10n ** 18n).toString(16)]);
    const taskManagerSigner = await ethers.getSigner(taskManagerAddress);
    await (await plaintextsStorage.connect(taskManagerSigner).storeResult(CT_HASH, 42)).wait();
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [taskManagerAddress]);

    const [result, decrypted] = await contract.getDecryptResultSafe(CT_HASH);
    expect(result).to.equal(42n);
    expect(decrypted).to.equal(true);
  });

  it("return their defaults after unsetTm, while the non-Safe call reverts", async function () {
    const { addressBook } = await deployOnChainFixture();
    const [owner] = await ethers.getSigners();
    const contract = await deploySafeVariants();

    await (await addressBook.connect(owner).unsetTm(taskManagerId())).wait();

    await expectSafeDefaults(contract);
    await expect(contract.getDecryptResult(CT_HASH))
      .to.be.revertedWithCustomError(addressBook, "TaskManagerNotSet")
      .withArgs(taskManagerId());
  });

  it("return their defaults when there is no code at COFHE_ADDRESS_BOOK", async function () {
    await deployOnChainFixture();
    const contract = await deploySafeVariants();

    await ethers.provider.send("hardhat_setCode", [addressBookAddress(), "0x"]);

    await expectSafeDefaults(contract);
  });
});
