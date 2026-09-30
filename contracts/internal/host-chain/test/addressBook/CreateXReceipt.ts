import { expect } from "chai";
import { id, zeroPadValue } from "ethers";

import { CREATEX_ADDRESS } from "../../utils/deployCreateX";
import { createdAddressFromReceipt, guardedSalt } from "../../utils/addressBookDeterministic";

// CreateX's ContractCreation log for the canonical book on Base Sepolia (block 47498349,
// tx 0xa4ee1e9782052fa5e80aca911ab79dd3f96089a01828c1b089a3c5bf0954a655).
const BOOK = "0xC0F4e00E531a2B086492Ae3DCC1515038307196b";
const LIVE_LOG = {
  address: CREATEX_ADDRESS,
  topics: [
    "0xb8fda7e00c6b06a2b54e58521bc5894fee35f1090e5a3bb6390bfe2b98b497f7",
    "0x000000000000000000000000c0f4e00e531a2b086492ae3dcc1515038307196b",
    "0x11d694af164b84e9aaf49bc9bac08c2f1364f32028df90f41ff6749f31cd7227",
  ],
  data: "0x",
};

describe("CreateX receipt handling", function () {
  it("reads the created address from the ContractCreation log", function () {
    expect(LIVE_LOG.topics[0]).to.equal(id("ContractCreation(address,bytes32)"));
    expect(createdAddressFromReceipt({ logs: [LIVE_LOG] })).to.equal(BOOK);
  });

  it("ignores logs from other contracts and receipts without the event", function () {
    expect(createdAddressFromReceipt({ logs: [{ ...LIVE_LOG, address: BOOK }] })).to.equal(null);
    expect(createdAddressFromReceipt({ logs: [] })).to.equal(null);
    expect(createdAddressFromReceipt(null)).to.equal(null);
  });

  it("derives the same guarded salt CreateX logged on Base Sepolia", function () {
    expect(guardedSalt()).to.equal(LIVE_LOG.topics[2]);
    expect(zeroPadValue(BOOK, 32).toLowerCase()).to.equal(LIVE_LOG.topics[1]);
  });
});
