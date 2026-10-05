import { expect } from "chai";
import * as fs from "fs";
import hre from "hardhat";
import * as path from "path";

import {
  computeAddressBookAddresses,
  readCommittedAddresses,
  readFrozenArtifacts,
} from "../../utils/addressBookDeterministic";
import { addressBookAddress } from "../../utils/addressBook";

/**
 * The canonical address book address is derived from the committed creation bytecode. These pin
 * that bytecode to the current compile, so a source edit, a compiler bump or an OpenZeppelin bump
 * fails here instead of silently moving the address on the next chain.
 */
describe("Frozen address-book bytecode", function () {
  it("matches the current compile", async function () {
    const frozen = readFrozenArtifacts();
    const book = await hre.artifacts.readArtifact("CoFHEAddressBook");
    const proxy = await hre.artifacts.readArtifact("ERC1967Proxy");
    expect(
      book.bytecode,
      "CoFHEAddressBook creation bytecode drifted: ship changes as CoFHEAddressBookV2.sol, or run " +
        "FREEZE_FORCE=1 pnpm freeze:addressBook for a deliberate address change",
    ).to.equal(frozen.implCreationCode);
    expect(proxy.bytecode, "ERC1967Proxy creation bytecode drifted").to.equal(frozen.proxyCreationCode);
  });

  it("reproduces the committed addresses", function () {
    const committed = readCommittedAddresses();
    const computed = computeAddressBookAddresses(committed.bootstrapOwner, readFrozenArtifacts());
    expect(computed.addressBookImplV1).to.equal(committed.addressBookImplV1);
    expect(computed.addressBook).to.equal(committed.addressBook);
  });

  it("is the address FHE.sol is compiled against", function () {
    const committed = readCommittedAddresses();
    expect(addressBookAddress()).to.equal(committed.addressBook);
    const source = fs.readFileSync(path.join(__dirname, "../../../../FHE.sol"), "utf8");
    expect(source).to.include(`address constant COFHE_ADDRESS_BOOK = ${committed.addressBook};`);
  });
});
