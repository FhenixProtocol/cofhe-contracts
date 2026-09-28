import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const { ethers, upgrades } = hre;

const ID = 1n;

describe("CoFHEAddressBook", function () {
  let owner: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let tmA: HardhatEthersSigner;
  let tmB: HardhatEthersSigner;
  let Book: any;
  let book: any;

  beforeEach(async function () {
    [owner, other, tmA, tmB] = await ethers.getSigners();
    Book = await ethers.getContractFactory("CoFHEAddressBook");
    book = await upgrades.deployProxy(Book, [owner.address], { kind: "uups", initializer: "initialize" });
    await book.waitForDeployment();
  });

  it("cannot be initialized twice", async function () {
    await expect(book.initialize(other.address)).to.be.revertedWithCustomError(book, "InvalidInitialization");
  });

  describe("getTm", function () {
    it("reverts on an id that was never set", async function () {
      await expect(book.getTm(ID)).to.be.revertedWithCustomError(book, "TaskManagerNotSet").withArgs(ID);
    });
  });

  describe("setTm", function () {
    it("sets an id and emits with a zero previous value", async function () {
      await expect(book.connect(owner).setTm(ID, tmA.address))
        .to.emit(book, "TaskManagerSet")
        .withArgs(ID, ethers.ZeroAddress, tmA.address);
      expect(await book.getTm(ID)).to.equal(tmA.address);
    });

    it("overwrites an id and emits the previous value", async function () {
      await (await book.connect(owner).setTm(ID, tmA.address)).wait();
      await expect(book.connect(owner).setTm(ID, tmB.address))
        .to.emit(book, "TaskManagerSet")
        .withArgs(ID, tmA.address, tmB.address);
      expect(await book.getTm(ID)).to.equal(tmB.address);
    });

    it("keeps ids independent", async function () {
      await (await book.connect(owner).setTm(ID, tmA.address)).wait();
      await (await book.connect(owner).setTm(2n, tmB.address)).wait();
      expect(await book.getTm(ID)).to.equal(tmA.address);
      expect(await book.getTm(2n)).to.equal(tmB.address);
    });

    it("rejects the zero address", async function () {
      await expect(book.connect(owner).setTm(ID, ethers.ZeroAddress)).to.be.revertedWithCustomError(book, "InvalidAddress");
    });

    it("is owner-only", async function () {
      await expect(book.connect(other).setTm(ID, tmA.address))
        .to.be.revertedWithCustomError(book, "OwnableUnauthorizedAccount")
        .withArgs(other.address);
    });
  });

  describe("unsetTm", function () {
    beforeEach(async function () {
      await (await book.connect(owner).setTm(ID, tmA.address)).wait();
    });

    it("clears the id and emits a zero current value", async function () {
      await expect(book.connect(owner).unsetTm(ID))
        .to.emit(book, "TaskManagerSet")
        .withArgs(ID, tmA.address, ethers.ZeroAddress);
      await expect(book.getTm(ID)).to.be.revertedWithCustomError(book, "TaskManagerNotSet").withArgs(ID);
    });

    it("reverts on an id that is already unset", async function () {
      await (await book.connect(owner).unsetTm(ID)).wait();
      await expect(book.connect(owner).unsetTm(ID)).to.be.revertedWithCustomError(book, "TaskManagerNotSet").withArgs(ID);
    });

    it("can be followed by setTm", async function () {
      await (await book.connect(owner).unsetTm(ID)).wait();
      await (await book.connect(owner).setTm(ID, tmB.address)).wait();
      expect(await book.getTm(ID)).to.equal(tmB.address);
    });

    it("is owner-only", async function () {
      await expect(book.connect(other).unsetTm(ID))
        .to.be.revertedWithCustomError(book, "OwnableUnauthorizedAccount")
        .withArgs(other.address);
    });
  });

  describe("upgrades", function () {
    it("preserve the mapping when the owner upgrades", async function () {
      await (await book.connect(owner).setTm(ID, tmA.address)).wait();
      const newImpl = await Book.deploy();
      await newImpl.waitForDeployment();
      await (await book.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x")).wait();
      expect(await upgrades.erc1967.getImplementationAddress(await book.getAddress())).to.equal(await newImpl.getAddress());
      expect(await book.getTm(ID)).to.equal(tmA.address);
    });

    it("are owner-only", async function () {
      const newImpl = await Book.deploy();
      await newImpl.waitForDeployment();
      await expect(book.connect(other).upgradeToAndCall(await newImpl.getAddress(), "0x"))
        .to.be.revertedWithCustomError(book, "OwnableUnauthorizedAccount")
        .withArgs(other.address);
    });
  });

  describe("two-step ownership", function () {
    it("gives the nominee nothing until it accepts", async function () {
      await (await book.connect(owner).transferOwnership(other.address)).wait();
      expect(await book.owner()).to.equal(owner.address);
      expect(await book.pendingOwner()).to.equal(other.address);

      await expect(book.connect(other).setTm(ID, tmA.address))
        .to.be.revertedWithCustomError(book, "OwnableUnauthorizedAccount")
        .withArgs(other.address);
      await expect(book.connect(other).unsetTm(ID))
        .to.be.revertedWithCustomError(book, "OwnableUnauthorizedAccount")
        .withArgs(other.address);
      const newImpl = await Book.deploy();
      await newImpl.waitForDeployment();
      await expect(book.connect(other).upgradeToAndCall(await newImpl.getAddress(), "0x"))
        .to.be.revertedWithCustomError(book, "OwnableUnauthorizedAccount")
        .withArgs(other.address);
      await (await book.connect(owner).setTm(ID, tmA.address)).wait();

      await (await book.connect(other).acceptOwnership()).wait();
      expect(await book.owner()).to.equal(other.address);
      await (await book.connect(other).setTm(ID, tmB.address)).wait();
      await expect(book.connect(owner).setTm(ID, tmA.address))
        .to.be.revertedWithCustomError(book, "OwnableUnauthorizedAccount")
        .withArgs(owner.address);
    });

    it("lets only the owner nominate", async function () {
      await expect(book.connect(other).transferOwnership(other.address))
        .to.be.revertedWithCustomError(book, "OwnableUnauthorizedAccount")
        .withArgs(other.address);
    });
  });
});
