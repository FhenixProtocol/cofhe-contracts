import { expect } from "chai";
import hre from "hardhat";

import { deployOnChainFixture } from "../onChain/OnChain.fixture";
import { taskManagerId } from "../../utils/addressBook";

const { ethers } = hre;

describe("FHE.sol resolves the TaskManager through the address book", function () {
  it("reverts with TaskManagerNotSet while the id is unset and works again once it is set", async function () {
    const { testContract, taskManagerAddress, addressBook } = await deployOnChainFixture();
    const [owner] = await ethers.getSigners();

    await (await addressBook.connect(owner).unsetTm(taskManagerId())).wait();
    await expect(testContract.trivial32(3, 5))
      .to.be.revertedWithCustomError(addressBook, "TaskManagerNotSet")
      .withArgs(taskManagerId());

    await (await addressBook.connect(owner).setTm(taskManagerId(), taskManagerAddress)).wait();
    await expect(testContract.trivial32(3, 5)).to.not.be.reverted;
  });
});
