import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

/**
 * Guards `initialize(initialAdmin, ...)` against a zero `initialAdmin`, mirroring the check
 * `CommitmentRegistry.initialize` already has. A zero admin would deploy a proxy with
 * DEFAULT_ADMIN_ROLE held by address(0) - permanently unadministrable, since no signer can ever
 * be address(0).
 *
 * `initialize` runs via the proxy's constructor (a delegatecall), so the revert is asserted on
 * the `ERC1967Proxy` deployment itself, not on a separate call.
 */
describe("initialize rejects a zero initialAdmin", function () {
  it("on ACL", async function () {
    const ACL = await ethers.getContractFactory("ACL");
    const aclImpl = await ACL.deploy();
    await aclImpl.waitForDeployment();

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const initData = ACL.interface.encodeFunctionData("initialize", [ethers.ZeroAddress, 0]);

    await expect(
      ERC1967Proxy.deploy(await aclImpl.getAddress(), initData),
    ).to.be.revertedWithCustomError(ACL, "InvalidAddress");
  });

  it("on ACPShareRegistry", async function () {
    const ACPShareRegistry = await ethers.getContractFactory("ACPShareRegistry");
    const registryImpl = await ACPShareRegistry.deploy();
    await registryImpl.waitForDeployment();

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const initData = ACPShareRegistry.interface.encodeFunctionData("initialize", [ethers.ZeroAddress]);

    await expect(
      ERC1967Proxy.deploy(await registryImpl.getAddress(), initData),
    ).to.be.revertedWithCustomError(ACPShareRegistry, "InvalidAddress");
  });
});
