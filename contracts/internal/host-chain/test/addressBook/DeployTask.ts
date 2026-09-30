import { expect } from "chai";
import hre from "hardhat";

import { computeAddressBookAddresses, readFrozenArtifacts } from "../../utils/addressBookDeterministic";
import { taskManagerId } from "../../utils/addressBook";

const { ethers, upgrades } = hre;

/**
 * The task's local path, end to end on the in-process Hardhat network: CreateX from its presigned
 * deployment, then the frozen v1 implementation and the proxy, owned by the deployer.
 */
describe("task:deployAddressBook on a local network", function () {
  before(async function () {
    await ethers.provider.send("hardhat_reset", []);
  });

  it("deploys the frozen implementation and proxy through CreateX, owned by the deployer", async function () {
    const [deployer] = await ethers.getSigners();
    await hre.run("task:deployAddressBook");

    const expected = computeAddressBookAddresses(deployer.address, readFrozenArtifacts());
    expect(await ethers.provider.getCode(expected.addressBookImplV1)).to.not.equal("0x");
    expect(await ethers.provider.getCode(expected.addressBook)).to.not.equal("0x");
    expect(await upgrades.erc1967.getImplementationAddress(expected.addressBook)).to.equal(expected.addressBookImplV1);

    const book = await ethers.getContractAt("CoFHEAddressBook", expected.addressBook);
    expect(await book.owner()).to.equal(deployer.address);
    await expect(book.getTm(taskManagerId())).to.be.revertedWithCustomError(book, "TaskManagerNotSet");
  });

  it("is idempotent", async function () {
    const [deployer] = await ethers.getSigners();
    await hre.run("task:deployAddressBook");

    const expected = computeAddressBookAddresses(deployer.address, readFrozenArtifacts());
    expect(await ethers.provider.getCode(expected.addressBook)).to.not.equal("0x");
    const book = await ethers.getContractAt("CoFHEAddressBook", expected.addressBook);
    expect(await book.owner()).to.equal(deployer.address);
  });
});
