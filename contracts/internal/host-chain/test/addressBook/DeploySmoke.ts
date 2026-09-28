import { expect } from "chai";
import hre from "hardhat";

import { installAddressBook } from "../helpers/addressBook";
import { addressBookAddress, resolveTaskManager, taskManagerId } from "../../utils/addressBook";

const { ethers } = hre;

describe("hardhat deploy against the address book", function () {
  it("registers a fresh TaskManager, then upgrades it in place on a second run", async function () {
    this.timeout(300_000);
    await ethers.provider.send("hardhat_reset", []);
    const [deployer] = await ethers.getSigners();
    // deploy.ts loads ../.env with dotenv, which never overrides a variable that is already set,
    // so set every one it reads rather than deleting it.
    process.env.AGGREGATOR_KEY = ethers.Wallet.createRandom().privateKey;
    process.env.VERIFIER_ADDRESS = ethers.ZeroAddress;
    process.env.DECRYPT_RESULT_SIGNER = ethers.ZeroAddress;
    process.env.TM_ADMIN_ADDRESS = deployer.address;
    process.env.TM_ADMIN_DELAY = "";
    process.env.SAFE_ADMIN_ADDRESS = "";
    process.env.MAINTENANCE_ADDRESS = "";

    const book = await installAddressBook(deployer);
    await hre.run("deploy", { reset: true });
    const first = await resolveTaskManager(hre);
    expect(await ethers.provider.getCode(first)).to.not.equal("0x");
    expect(await book.getTm(taskManagerId())).to.equal(first);

    await hre.run("deploy", { reset: true });
    expect(await resolveTaskManager(hre)).to.equal(first);
    expect(addressBookAddress()).to.equal(await book.getAddress());
  });
});
