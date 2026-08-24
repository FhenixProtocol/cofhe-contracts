import hre from "hardhat";
import { expect } from "chai";

import { grantAllRoles } from "../../utils/roles";

const { ethers } = hre;

// ACL.allowTransient (and DeterministicACL.allowTransient) require msg.sender to equal
// the compile-time TASK_MANAGER_ADDRESS constant, so the TM proxy must be deployed at
// this fixed address. Mirrors deployProxyAtAddress from test/publiclyAllowed/PubliclyAllowed.ts.
const TASK_MANAGER_ADDRESS = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9";

/**
 * Install a UUPS proxy's runtime bytecode at a fixed address and initialize it in place.
 *
 * Copying storage slots out of a throwaway proxy is not enough under AccessControl: role
 * membership lives in mapping slots computed from the role and the account, not at a fixed
 * offset, so a copied proxy ends up with a default admin that holds no roles. Initialize through
 * the real proxy instead, exactly as test/onChain/OnChain.fixture.ts does.
 */
async function deployProxyAtAddress(
    targetAddress: string,
    implementationAddress: string,
    initData: string
): Promise<void> {
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    // Deploy a throwaway proxy only to capture the proxy runtime bytecode.
    const tempProxy = await ERC1967Proxy.deploy(implementationAddress, "0x");
    await tempProxy.waitForDeployment();
    const proxyBytecode = await ethers.provider.getCode(await tempProxy.getAddress());

    await ethers.provider.send("hardhat_setCode", [targetAddress, proxyBytecode]);

    const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    await ethers.provider.send("hardhat_setStorageAt", [
        targetAddress,
        IMPL_SLOT,
        ethers.zeroPadValue(implementationAddress, 32),
    ]);

    const [signer] = await ethers.getSigners();
    const tx = await signer.sendTransaction({ to: targetAddress, data: initData });
    await tx.wait();
}

async function deployTm(factoryName: string) {
    // Other test files deploy a TaskManager at this same hardcoded address inside the same Hardhat
    // network process; reset so `initialize` sees fresh storage.
    await ethers.provider.send("hardhat_reset", []);

    const [owner] = await ethers.getSigners();

    const TM = await ethers.getContractFactory(factoryName);
    const impl = await TM.deploy();
    await impl.waitForDeployment();
    const initData = TM.interface.encodeFunctionData("initialize", [owner.address, 0]);
    await deployProxyAtAddress(TASK_MANAGER_ADDRESS, await impl.getAddress(), initData);
    const tm = TM.attach(TASK_MANAGER_ADDRESS) as any;

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const ACL = await ethers.getContractFactory("ACL");
    const aclImpl = await ACL.deploy();
    await aclImpl.waitForDeployment();
    const aclInit = ACL.interface.encodeFunctionData("initialize", [owner.address, 0]);
    const aclProxy = await ERC1967Proxy.deploy(await aclImpl.getAddress(), aclInit);
    await aclProxy.waitForDeployment();

    // `initialize` grants only DEFAULT_ADMIN_ROLE, and each setter below is bound to its own role;
    // mirror the deploy script and grant them all.
    await grantAllRoles(tm, owner, undefined, false);

    await tm.setACLContract(await aclProxy.getAddress());
    await tm.setSecurityZones(0, 1);
    // TaskManager.initialize() sets verifierSigner to address(1); reset it here so this test takes
    // the debug path it targets.
    await tm.setVerifierSigner(ethers.ZeroAddress);
    return { tm, owner };
}

const EUINT32_TFHE = 4;

// topic0 of the event the commitment relay subscribes to. Hard-coded here the
// same way slim-listener hard-codes it, so a change to the event's shape fails
// this test instead of silently turning the relay into a no-op.
const INPUT_VERIFIED_TOPIC = ethers.id("InputVerified(uint256,bytes32)");

function expectedCommitment(ctHash: bigint): string {
    return ethers.toBeHex(ctHash, 32);
}

function makeInput(ctHash: bigint, securityZone = 0) {
    return { ctHash, securityZone, utype: EUINT32_TFHE, signature: "0x" };
}

/** The InputVerified logs of a receipt, decoded, in emission order. */
function inputVerifiedLogs(tm: any, receipt: any) {
    return receipt.logs
        .filter((log: any) => log.topics[0] === INPUT_VERIFIED_TOPIC)
        .map((log: any) => tm.interface.parseLog(log));
}

// verifierSigner is 0 here, so batchVerifyInputs takes the debug path and the
// signature argument is ignored — these tests target emission, not verification.
const NO_SIGNATURE = "0x";

describe("TaskManager InputVerified event", function () {
    let tm: any;
    let owner: any;

    before(async function () {
        ({ tm, owner } = await deployTm("TaskManager"));
    });

    it("emits InputVerified with the appended handle and contract-computed commitment", async function () {
        const ctHash = ethers.toBigInt(ethers.keccak256(ethers.toUtf8Bytes("ciphertext-bytes")));
        const inputs = [makeInput(ctHash)];

        const [expectedHandle] = await tm.batchVerifyInputs.staticCall(inputs, owner.address, NO_SIGNATURE);
        await expect(tm.batchVerifyInputs(inputs, owner.address, NO_SIGNATURE))
            .to.emit(tm, "InputVerified")
            .withArgs(expectedHandle, expectedCommitment(ctHash));
        // Known-answer vector shared with teecryptor's layout guard — the commitment
        // is the raw verifier-signed digest keccak256(ct bytes), verbatim.
        expect(expectedCommitment(ctHash)).to.equal(
            "0x40d2fbec275af2d35e33af88ddc72e89b518580794c21654f4138a12ae622613"
        );
    });

    it("emits one event per input of a batch, in input order", async function () {
        const ctHashes = [0xaaaan << 16n, 0xbbbbn << 16n, 0xccccn << 16n];
        const inputs = ctHashes.map((ctHash) => makeInput(ctHash));

        const expectedHandles = await tm.batchVerifyInputs.staticCall(inputs, owner.address, NO_SIGNATURE);
        const receipt = await (await tm.batchVerifyInputs(inputs, owner.address, NO_SIGNATURE)).wait();

        // One log per input, each with its own logIndex — the relay derives an
        // event id from (blockNumber, logIndex), so a batch yields N distinct ids.
        const events = inputVerifiedLogs(tm, receipt);
        expect(events.length).to.equal(inputs.length);
        events.forEach((event: any, i: number) => {
            expect(event.args.ctHash).to.equal(expectedHandles[i]);
            expect(event.args.commitment).to.equal(expectedCommitment(ctHashes[i]));
        });
    });

    it("emits the raw ctHash for any zone, with the zone pinned in handle byte 31", async function () {
        const ctHash = ethers.toBigInt(ethers.keccak256(ethers.toUtf8Bytes("other-bytes")));
        const inputs = [makeInput(ctHash, 0), makeInput(ctHash, 1)];

        const receipt = await (await tm.batchVerifyInputs(inputs, owner.address, NO_SIGNATURE)).wait();

        const events = inputVerifiedLogs(tm, receipt);
        // Zone is not in the commitment value; it is bound by the lookup key —
        // the appended handle carries the zone in its last byte. The same
        // ciphertext on two zones therefore shares a commitment but not a handle.
        expect(events.map((event: any) => event.args.ctHash & 0xffn)).to.deep.equal([0n, 1n]);
        for (const event of events) {
            expect(event.args.commitment).to.equal(expectedCommitment(ctHash));
        }
    });
});
