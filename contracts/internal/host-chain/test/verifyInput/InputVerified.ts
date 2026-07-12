import hre from "hardhat";
import { expect } from "chai";

const { ethers } = hre;

// ACL.allowTransient (and DeterministicACL.allowTransient) require msg.sender to equal
// the compile-time TASK_MANAGER_ADDRESS constant, so the TM proxy must be deployed at
// this fixed address. Mirrors deployProxyAtAddress from test/publiclyAllowed/PubliclyAllowed.ts.
const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

async function deployProxyAtAddress(
    targetAddress: string,
    implementationAddress: string,
    initData: string
): Promise<void> {
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const tempProxy = await ERC1967Proxy.deploy(implementationAddress, initData);
    await tempProxy.waitForDeployment();

    const proxyBytecode = await ethers.provider.getCode(await tempProxy.getAddress());
    await ethers.provider.send("hardhat_setCode", [targetAddress, proxyBytecode]);

    const storageSlots = [
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
        "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00",
        "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300",
        "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199301",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000000000000000000000000000003",
        "0x0000000000000000000000000000000000000000000000000000000000000004",
        "0x0000000000000000000000000000000000000000000000000000000000000005",
        "0x0000000000000000000000000000000000000000000000000000000000000006",
        "0x0000000000000000000000000000000000000000000000000000000000000007",
        "0x0000000000000000000000000000000000000000000000000000000000000008",
        "0x0000000000000000000000000000000000000000000000000000000000000009",
        "0x000000000000000000000000000000000000000000000000000000000000000a",
    ];

    const tempAddress = await tempProxy.getAddress();
    for (const slot of storageSlots) {
        const value = await ethers.provider.getStorage(tempAddress, slot);
        if (value !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
            await ethers.provider.send("hardhat_setStorageAt", [targetAddress, slot, value]);
        }
    }
}

async function deployTm(factoryName: string) {
    const [owner] = await ethers.getSigners();

    const TM = await ethers.getContractFactory(factoryName);
    const impl = await TM.deploy();
    await impl.waitForDeployment();
    const initData = TM.interface.encodeFunctionData("initialize", [owner.address]);
    await deployProxyAtAddress(TASK_MANAGER_ADDRESS, await impl.getAddress(), initData);
    const tm = TM.attach(TASK_MANAGER_ADDRESS);

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const ACL = await ethers.getContractFactory("ACL");
    const aclImpl = await ACL.deploy();
    await aclImpl.waitForDeployment();
    const aclInit = ACL.interface.encodeFunctionData("initialize", [owner.address]);
    const aclProxy = await ERC1967Proxy.deploy(await aclImpl.getAddress(), aclInit);
    await aclProxy.waitForDeployment();

    await tm.setACLContract(await aclProxy.getAddress());
    await tm.setSecurityZones(0, 1);
    // TaskManager.initialize() sets verifierSigner to address(1) (DeterministicTM uses
    // address(0)); reset it here so both variants take the debug path this test targets.
    await tm.setVerifierSigner(ethers.ZeroAddress);
    return { tm, owner };
}

function expectedCommitment(ctHash: bigint, securityZone: number): string {
    return ethers.solidityPackedKeccak256(["uint256", "uint8"], [ctHash, securityZone]);
}

describe("TaskManager InputVerified event", function () {
    let tm: any;
    let owner: any;

    before(async function () {
        ({ tm, owner } = await deployTm("TaskManager"));
    });

    it("emits InputVerified with the appended handle and contract-computed commitment", async function () {
        const ctHash = ethers.toBigInt(ethers.keccak256(ethers.toUtf8Bytes("ciphertext-bytes")));
        const input = { ctHash, securityZone: 0, utype: 4, signature: "0x" };

        const expectedHandle = await tm.verifyInput.staticCall(input, owner.address);
        await expect(tm.verifyInput(input, owner.address))
            .to.emit(tm, "InputVerified")
            .withArgs(expectedHandle, expectedCommitment(ctHash, 0));
        // Known-answer vector shared with teecryptor's input_commit_hash layout guard —
        // pins the Solidity and Rust encodings to the same 33-byte preimage.
        expect(expectedCommitment(ctHash, 0)).to.equal(
            "0x0697ff96c18ff49889bbe0e00b266c4a3a325fcf4ed301bd4c14330d547c7403"
        );
    });

    it("binds the security zone into the commitment", async function () {
        const ctHash = ethers.toBigInt(ethers.keccak256(ethers.toUtf8Bytes("other-bytes")));
        const input = { ctHash, securityZone: 1, utype: 4, signature: "0x" };

        const expectedHandle = await tm.verifyInput.staticCall(input, owner.address);
        await expect(tm.verifyInput(input, owner.address))
            .to.emit(tm, "InputVerified")
            .withArgs(expectedHandle, expectedCommitment(ctHash, 1));
        expect(expectedCommitment(ctHash, 1)).to.not.equal(expectedCommitment(ctHash, 0));
    });
});
