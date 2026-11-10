import hre from "hardhat";
import { expect } from "chai";

import { guardedSalt } from "../../utils/addressBookDeterministic";
import { CREATEX_ADDRESS, deployCreateX } from "../../utils/deployCreateX";
import { linkedTaskManagerFactory } from "../../utils/taskManagerLib";

const { ethers } = hre;

// The deploy and upgrade scripts link TaskManager to a TaskManagerLib at a CREATE2 address, so an
// unchanged library is reused across upgrades instead of deployed again.
describe("linkedTaskManagerFactory", function () {
  let libAddress: string;

  before(async function () {
    await ethers.provider.send("hardhat_reset", []);
    const [, signerProxy] = await ethers.getSigners();
    await deployCreateX(hre, signerProxy);
  });

  // ethers keeps the linked bytecode, with the library address in place of the placeholder.
  function linksLibrary(factory: any): boolean {
    return factory.bytecode.toLowerCase().includes(libAddress.slice(2).toLowerCase());
  }

  it("deploys the library once through CreateX and links it", async function () {
    const [signer] = await ethers.getSigners();
    const factory = await linkedTaskManagerFactory(hre, signer);
    const lib = await hre.artifacts.readArtifact("TaskManagerLib");
    libAddress = ethers.getCreate2Address(CREATEX_ADDRESS, guardedSalt(), ethers.keccak256(lib.bytecode));
    expect(await ethers.provider.getCode(libAddress)).to.not.equal("0x");
    expect(linksLibrary(factory)).to.equal(true);
  });

  it("reuses the deployed library on a second call", async function () {
    const [signer] = await ethers.getSigners();
    const nonceBefore = await ethers.provider.getTransactionCount(signer.address);
    const factory = await linkedTaskManagerFactory(hre, signer);
    expect(await ethers.provider.getTransactionCount(signer.address)).to.equal(nonceBefore);
    expect(linksLibrary(factory)).to.equal(true);
  });

  it("sends nothing with deploy: false and still links the predicted address", async function () {
    const [, , fresh] = await ethers.getSigners();
    const nonceBefore = await ethers.provider.getTransactionCount(fresh.address);
    const factory = await linkedTaskManagerFactory(hre, fresh, { deploy: false });
    expect(await ethers.provider.getTransactionCount(fresh.address)).to.equal(nonceBefore);
    expect(linksLibrary(factory)).to.equal(true);
  });

  it("deploys a TaskManager from the linked factory", async function () {
    const [signer] = await ethers.getSigners();
    const factory = await linkedTaskManagerFactory(hre, signer);
    const impl = await factory.deploy();
    await impl.waitForDeployment();
    expect(await ethers.provider.getCode(await impl.getAddress())).to.not.equal("0x");
  });
});
