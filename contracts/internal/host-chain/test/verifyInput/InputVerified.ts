import hre from "hardhat";
import { expect } from "chai";

import { grantAllRoles } from "../../utils/roles";
import { installAddressBook, registerTaskManager } from "../helpers/addressBook";

const { ethers } = hre;

// The TaskManager is registered in the address book FHE.sol resolves through; ACL is bound to it.
async function deployTm(factoryName: string) {
    // Other test files install the address book at the same fixed address inside the same Hardhat
    // network process; reset so `initialize` sees fresh storage.
    await ethers.provider.send("hardhat_reset", []);

    const [owner] = await ethers.getSigners();

    const addressBook = await installAddressBook(owner);

    const TM = await ethers.getContractFactory(factoryName);
    const impl = await TM.deploy();
    await impl.waitForDeployment();
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const tmProxy = await ERC1967Proxy.deploy(
        await impl.getAddress(),
        TM.interface.encodeFunctionData("initialize", [owner.address, 0]),
    );
    await tmProxy.waitForDeployment();
    const taskManagerAddress = await tmProxy.getAddress();
    const tm = TM.attach(taskManagerAddress) as any;
    await registerTaskManager(addressBook, taskManagerAddress);

    const ACL = await ethers.getContractFactory("ACL");
    const aclImpl = await ACL.deploy();
    await aclImpl.waitForDeployment();
    const aclInit = ACL.interface.encodeFunctionData("initialize", [owner.address, 0, taskManagerAddress]);
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
