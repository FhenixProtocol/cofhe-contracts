import hre from "hardhat";
import { expect } from "chai";

import { guardedSalt } from "../../utils/addressBookDeterministic";
import { CREATEX_ADDRESS, deployCreateX } from "../../utils/deployCreateX";
import { deployTaskManagerLib, linkedTaskManagerFactory } from "../../utils/taskManagerLib";

const { ethers } = hre;

// The deploy and upgrade scripts link TaskManager to a TaskManagerLib at a CREATE2 address, so an
// unchanged library is reused across upgrades instead of deployed again.
describe("TaskManagerLib deploy and linking", function () {
  let libAddress: string;

  before(async function () {
    await ethers.provider.send("hardhat_reset", []);
    const [, signerProxy] = await ethers.getSigners();
    await deployCreateX(hre, signerProxy);
    const lib = await hre.artifacts.readArtifact("TaskManagerLib");
    libAddress = ethers.getCreate2Address(CREATEX_ADDRESS, guardedSalt(), ethers.keccak256(lib.bytecode));
  });

  // ethers keeps the linked bytecode, with the library address in place of the placeholder.
  function linksLibrary(factory: any): boolean {
    return factory.bytecode.toLowerCase().includes(libAddress.slice(2).toLowerCase());
  }

  it("deploys the library once through CreateX at its CREATE2 address", async function () {
    const [signer] = await ethers.getSigners();
    expect(await deployTaskManagerLib(hre, signer)).to.equal(libAddress);
    expect(await ethers.provider.getCode(libAddress)).to.not.equal("0x");
  });

  it("reuses the deployed library on a second deploy", async function () {
    const [signer] = await ethers.getSigners();
    const nonceBefore = await ethers.provider.getTransactionCount(signer.address);
    expect(await deployTaskManagerLib(hre, signer)).to.equal(libAddress);
    expect(await ethers.provider.getTransactionCount(signer.address)).to.equal(nonceBefore);
  });

  it("links the factory to that address without sending anything", async function () {
    const [, , fresh] = await ethers.getSigners();
    const nonceBefore = await ethers.provider.getTransactionCount(fresh.address);
    const factory = await linkedTaskManagerFactory(hre, fresh);
    expect(await ethers.provider.getTransactionCount(fresh.address)).to.equal(nonceBefore);
    expect(linksLibrary(factory)).to.equal(true);
  });
});
