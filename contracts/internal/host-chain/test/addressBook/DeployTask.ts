import { expect } from "chai";
import hre from "hardhat";

import { computeAddressBookAddresses, readFrozenArtifacts } from "../../utils/addressBookDeterministic";
import { taskManagerId } from "../../utils/addressBook";

const { ethers, upgrades } = hre;

// dotenv never overrides a variable that is already set, so blank ones are set to "".
const ENV_KEYS = ["AGGREGATOR_KEY", "TM_ADMIN_ADDRESS"] as const;

async function expectBookOwnedBy(owner: string) {
  const expected = computeAddressBookAddresses(owner, readFrozenArtifacts());
  expect(await ethers.provider.getCode(expected.addressBookImplV1)).to.not.equal("0x");
  expect(await ethers.provider.getCode(expected.addressBook)).to.not.equal("0x");
  expect(await upgrades.erc1967.getImplementationAddress(expected.addressBook)).to.equal(expected.addressBookImplV1);

  const book = await ethers.getContractAt("CoFHEAddressBook", expected.addressBook);
  expect(await book.owner()).to.equal(owner);
  await expect(book.getTm(taskManagerId())).to.be.revertedWithCustomError(book, "TaskManagerNotSet");
}

/**
 * The task's local path, end to end on the in-process Hardhat network: CreateX from its presigned
 * deployment, then the frozen v1 implementation and the proxy, owned by the admin deploy.ts picks.
 */
describe("task:deployAddressBook on a local network", function () {
  const saved: Record<string, string | undefined> = {};

  before(async function () {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    await ethers.provider.send("hardhat_reset", []);
  });

  after(function () {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  const aggregator = ethers.Wallet.createRandom();

  it("deploys the frozen implementation and proxy through CreateX, owned by the AGGREGATOR_KEY wallet", async function () {
    process.env.AGGREGATOR_KEY = aggregator.privateKey;
    process.env.TM_ADMIN_ADDRESS = "";
    await hre.run("task:deployAddressBook");

    await expectBookOwnedBy(aggregator.address);
  });

  it("is idempotent", async function () {
    process.env.AGGREGATOR_KEY = aggregator.privateKey;
    process.env.TM_ADMIN_ADDRESS = "";
    await hre.run("task:deployAddressBook");

    await expectBookOwnedBy(aggregator.address);
  });

  it("is owned by TM_ADMIN_ADDRESS when set", async function () {
    const admin = ethers.Wallet.createRandom().address;
    process.env.AGGREGATOR_KEY = aggregator.privateKey;
    process.env.TM_ADMIN_ADDRESS = admin;
    await hre.run("task:deployAddressBook");

    await expectBookOwnedBy(admin);
  });

  it("is owned by the deployer without AGGREGATOR_KEY", async function () {
    const [deployer] = await ethers.getSigners();
    process.env.AGGREGATOR_KEY = "";
    process.env.TM_ADMIN_ADDRESS = "";
    await hre.run("task:deployAddressBook");

    await expectBookOwnedBy(deployer.address);
  });
});
