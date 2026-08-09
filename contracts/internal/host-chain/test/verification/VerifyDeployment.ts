import { expect } from "chai";
import hre from "hardhat";
import { encodeProxyConstructorArgs } from "../../tasks/verifyDeployment";

const DUMMY_IMPL_ADDRESS = "0x3428Ca0c49393A34fABbDF61088b68aCff55b14e";

describe("task:verifyDeployment helpers", function () {
  const admin = "0x4e6206fC78674E5eFf48Dcd0166060f95a832c60";

  it("encodeProxyConstructorArgs encodes (dummy impl, initialize(admin))", async function () {
    const tmInterface = (await hre.ethers.getContractFactory("TaskManager")).interface;
    const encoded = encodeProxyConstructorArgs(hre.ethers, tmInterface, admin);

    const [impl, initData] = hre.ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "bytes"],
      encoded,
    );
    expect(impl).to.equal(DUMMY_IMPL_ADDRESS);

    const decodedCall = tmInterface.parseTransaction({ data: initData });
    expect(decodedCall?.name).to.equal("initialize");
    expect(decodedCall?.args[0]).to.equal(admin);
  });
});
