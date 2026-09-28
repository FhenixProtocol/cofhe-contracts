import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { verifyAddressBookDeployment } from "../../tasks/deployAddressBook";
import { installAddressBook } from "../helpers/addressBook";

const { ethers, upgrades } = hre;

describe("verifyAddressBookDeployment", function () {
  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let book: any;
  let bookAddress: string;
  let implementation: string;

  beforeEach(async function () {
    await ethers.provider.send("hardhat_reset", []);
    [owner, stranger] = await ethers.getSigners();
    book = await installAddressBook(owner);
    bookAddress = await book.getAddress();
    implementation = await upgrades.erc1967.getImplementationAddress(bookAddress);
  });

  it("passes for the expected implementation and an accepted owner", async function () {
    await verifyAddressBookDeployment(hre, bookAddress, implementation, [stranger.address, owner.address]);
  });

  it("rejects an owner outside the accepted set", async function () {
    await (await book.connect(owner).transferOwnership(stranger.address)).wait();
    await (await book.connect(stranger).acceptOwnership()).wait();
    await expect(verifyAddressBookDeployment(hre, bookAddress, implementation, [owner.address])).to.be.rejectedWith(
      /owned by/,
    );
  });

  it("rejects an unexpected implementation", async function () {
    const Book = await ethers.getContractFactory("CoFHEAddressBook");
    const otherImpl = await Book.deploy();
    await otherImpl.waitForDeployment();
    await expect(
      verifyAddressBookDeployment(hre, bookAddress, await otherImpl.getAddress(), [owner.address]),
    ).to.be.rejectedWith(/runs implementation/);
  });
});
