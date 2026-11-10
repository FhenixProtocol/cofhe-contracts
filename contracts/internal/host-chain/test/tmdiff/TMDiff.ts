// Differential test: runs one call matrix against a frozen baseline TaskManager and the TaskManager
// of this build, on ONE proxy whose implementation slot is swapped between runs. Each case starts
// from the same EVM snapshot, block number, timestamp and caller, and compares success, return or
// revert data, every log and the ACL permissions on returned handles, byte for byte.
//
// The baseline is the TaskManager artifact of master b5c20ed, the last build before TaskManagerLib.
// Behaviour must stay identical to it; only gas differs. The file keeps only the artifact's abi,
// bytecode and sha, and the bytecode must need no linking: a build after TaskManagerLib does, so
// refreshing it to a newer commit also means linking TaskManagerLib before the deploy below.
import { deployLinkedTaskManagerFactory } from "../taskManagerFactory";
import hre from "hardhat";
import { expect } from "chai";
import fs from "fs";
import path from "path";
import { grantAllRoles } from "../../utils/roles";
import { installAddressBook, registerTaskManager } from "../helpers/addressBook";

const { ethers } = hre;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BASELINE = path.join(__dirname, "baseline-TaskManager.json");
const GAS = 16_000_000n;

// FunctionId and type values as in the baseline's ICofhe.sol; the baseline is frozen, so these are too.
const TYPES = [0, 2, 3, 4, 5, 6, 7]; // ebool, euint8..128, eaddress
const MAX: Record<number, bigint> = { 0: 1n, 2: 2n ** 8n - 1n, 3: 2n ** 16n - 1n, 4: 2n ** 32n - 1n, 5: 2n ** 64n - 1n, 6: 2n ** 128n - 1n, 7: 2n ** 160n - 1n };
const F = { cast: 2, select: 4, decrypt: 6, not: 12, trivialEncrypt: 26, random: 27, square: 30 };
const BINARY = [7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 28, 29];
const UINT256_MAX = 2n ** 256n - 1n;
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

type Tx = { fn: string; args: any[] };
type Case = { name: string; pre?: Tx[]; data: string; mode: number; expectOk?: boolean };

describe("TaskManager differential (master vs branch)", function () {
  this.timeout(0);

  it("matches byte-for-byte on the full call matrix", async function () {
    await ethers.provider.send("hardhat_reset", []);
    const [owner] = await ethers.getSigners();
    const vSigner = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("verifier")));
    const dSigner = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("decrypter")));
    const wrong = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("wrong")));
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const addressBook = await installAddressBook(owner);
    const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    const BaseTM = new ethers.ContractFactory(base.abi, base.bytecode, owner);
    const baseImpl = await (await BaseTM.deploy()).waitForDeployment();
    const CandTM = await deployLinkedTaskManagerFactory();
    const candImpl = await (await CandTM.deploy()).waitForDeployment();
    const impls = { baseline: await baseImpl.getAddress(), candidate: await candImpl.getAddress() };

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const tmProxy = await (await ERC1967Proxy.deploy(impls.baseline, BaseTM.interface.encodeFunctionData("initialize", [owner.address, 0]))).waitForDeployment();
    const tmAddr = await tmProxy.getAddress();
    const tm: any = new ethers.Contract(tmAddr, base.abi, owner);
    const I = tm.interface;
    await registerTaskManager(addressBook, tmAddr);

    const ACL = await ethers.getContractFactory("ACL");
    const aclProxy = await (await ERC1967Proxy.deploy(await (await ACL.deploy()).getAddress(), ACL.interface.encodeFunctionData("initialize", [owner.address, 0, tmAddr]))).waitForDeployment();
    const PS = await ethers.getContractFactory("PlaintextsStorage");
    const psProxy = await (await ERC1967Proxy.deploy(await (await PS.deploy()).getAddress(), PS.interface.encodeFunctionData("initialize", [owner.address, 0, tmAddr]))).waitForDeployment();
    await grantAllRoles(tm, owner, undefined, false);
    await grantAllRoles(ACL.attach(await aclProxy.getAddress()), owner, undefined, false);
    await grantAllRoles(PS.attach(await psProxy.getAddress()), owner, undefined, false);
    await (await tm.setACLContract(await aclProxy.getAddress())).wait();
    await (await tm.setPlaintextsStorage(await psProxy.getAddress())).wait();
    await (await tm.setSecurityZones(0, 1)).wait();
    await (await tm.setVerifierSigner(vSigner.address)).wait();
    await (await tm.setDecryptResultSigner(dSigner.address)).wait();

    const probe: any = await (await (await ethers.getContractFactory("TMDiffProbe")).deploy()).waitForDeployment();
    const probeAddr = await probe.getAddress();

    // Persistent handles H[type][zone][value] allowed to the probe; created through the baseline,
    // like state an upgraded proxy inherits.
    const H: Record<string, bigint> = {};
    for (const t of TYPES) {
      const targets: string[] = [];
      const datas: string[] = [];
      for (const z of [0, 1]) for (const v of [0n, 1n]) {
        const h = await tm.createTask.staticCall(t, F.trivialEncrypt, [], [v, t, z]);
        H[`${t}.${z}.${v}`] = h;
        targets.push(tmAddr, tmAddr);
        datas.push(I.encodeFunctionData("createTask", [t, F.trivialEncrypt, [], [v, t, z]]), I.encodeFunctionData("allow", [h, probeAddr]));
      }
      await (await probe.multi(targets, datas, { gasLimit: GAS })).wait();
    }
    const h = (t: number, z = 0, v = 0n) => H[`${t}.${z}.${v}`];
    const notAllowed: bigint = await tm.createTask.staticCall(4, F.trivialEncrypt, [], [999, 4, 0]);
    const withZone = (x: bigint, zByte: number) => (x & ~0xffn) | BigInt(zByte);

    const ct = (rt: number, f: number, enc: bigint[], extra: bigint[] | number[]) => I.encodeFunctionData("createTask", [rt, f, enc, extra]);
    const cases: Case[] = [];
    const add = (name: string, data: string, mode = 1, pre?: Tx[], expectOk?: boolean) => cases.push({ name, data, mode, pre, expectOk });

    // ---------------- createTask ----------------
    for (let f = 0; f < 32; f++) {
      add(`ct f=${f} binary euint32`, ct(4, f, [h(4), h(4, 0, 1n)], []));
      add(`ct f=${f} unary euint32`, ct(4, f, [h(4)], []));
      add(`ct f=${f} no inputs`, ct(4, f, [], []));
    }
    for (const f of BINARY) for (const t of TYPES) add(`ct binary f=${f} t=${t}`, ct(t, f, [h(t), h(t, 0, 1n)], []));
    for (const f of [F.not, F.square]) for (const t of TYPES) add(`ct unary f=${f} t=${t}`, ct(t, f, [h(t)], []));
    for (const t of TYPES) for (const to of [...TYPES, 1, 8, 256]) add(`ct cast ${t}->${to}`, ct(to > 255 ? 4 : to, F.cast, [h(t)], [BigInt(to)]));
    for (const t of TYPES) add(`ct select t=${t}`, ct(t, F.select, [h(0), h(t), h(t, 0, 1n)], []));
    for (const t of TYPES) for (const z of [0n, 1n, 2n, UINT256_MAX, 2n ** 31n]) for (const v of [0n, MAX[t], MAX[t] + 1n])
      add(`ct trivial t=${t} z=${z} v=${v}`, ct(t, F.trivialEncrypt, [], [v, BigInt(t), z]));
    for (const toType of [1n, 8n, 256n]) add(`ct trivial toType=${toType}`, ct(4, F.trivialEncrypt, [], [1n, toType, 0n]));
    add("ct trivial too few extra", ct(4, F.trivialEncrypt, [], [1n, 4n]));
    for (const rt of [1, 8, 9, 255]) add(`ct bad returnType ${rt}`, ct(rt, 8, [h(4), h(4, 0, 1n)], []));
    add("ct random rejected", ct(4, F.random, [], [1n, 0n]));
    add("ct decrypt rejected", ct(4, F.decrypt, [h(4)], []));
    add("ct too many: 4 enc", ct(4, 8, [h(4), h(4), h(4), h(4)], []));
    add("ct too many: 2 enc + 2 extra", ct(4, 8, [h(4), h(4)], [1n, 2n]));
    add("ct too many: 0 enc + 4 extra", ct(4, F.trivialEncrypt, [], [1n, 4n, 0n, 0n]));
    add("ct unary with 2", ct(4, F.not, [h(4), h(4)], []));
    add("ct cast with 2 enc", ct(4, F.cast, [h(4), h(4)], [4n]));
    add("ct binary with 1", ct(4, 8, [h(4)], []));
    add("ct binary with 3", ct(4, 8, [h(4), h(4), h(4)], []));
    add("ct select with 2", ct(4, F.select, [h(0), h(4)], []));
    add("ct select with 4", ct(4, F.select, [h(0), h(4), h(4), h(4)], []));
    add("ct select non-bool cond", ct(4, F.select, [h(4), h(4), h(4)], []));
    add("ct select branch type mismatch", ct(4, F.select, [h(0), h(4), h(5)], []));
    add("ct select branch zone mismatch", ct(4, F.select, [h(0), h(4), h(4, 1)], []));
    add("ct binary type mismatch", ct(4, 8, [h(4), h(5)], []));
    add("ct binary zone mismatch", ct(4, 8, [h(4), h(4, 1)], []));
    add("ct binary zone 1 ok", ct(4, 8, [h(4, 1), h(4, 1, 1n)], []));
    add("ct binary invalid zone 2", ct(4, 8, [withZone(h(4), 2), withZone(h(4, 0, 1n), 2)], []));
    add("ct binary invalid zone -1", ct(4, 8, [withZone(h(4), 0xff), withZone(h(4, 0, 1n), 0xff)], []));
    add("ct unary invalid zone", ct(4, F.not, [withZone(h(4), 2)], []));
    add("ct binary extra input", ct(4, 8, [h(4), h(4)], [1n]));
    add("ct add on eaddress", ct(7, 8, [h(7), h(7)], []));
    add("ct add on ebool", ct(0, 8, [h(0), h(0)], []));
    add("ct and on eaddress", ct(7, 10, [h(7), h(7)], []));
    add("ct not on eaddress", ct(7, F.not, [h(7)], []));
    add("ct eq on eaddress", ct(0, 24, [h(7), h(7, 0, 1n)], []));
    add("ct ACL not allowed first", ct(4, 8, [notAllowed, h(4)], []));
    add("ct ACL not allowed second", ct(4, 8, [h(4), notAllowed], []));
    add("ct ACL not allowed unary", ct(4, F.not, [notAllowed], []));
    // Invalid enum value: hand-encoded, the typed encoder refuses it.
    add("ct funcId=32 (invalid enum)", ct(4, 8, [h(4), h(4)], []).replace(/^(0x.{8}.{64}).{64}/, `$1${"0".repeat(62)}20`));
    const disable: Tx = { fn: "disable", args: [] };
    add("ct disabled valid trivial", ct(4, F.trivialEncrypt, [], [1n, 4n, 0n]), 1, [disable]);
    add("ct disabled valid binary", ct(4, 8, [h(4), h(4)], []), 1, [disable]);
    add("ct disabled invalid input", ct(4, F.not, [h(4), h(4)], []), 1, [disable]);
    add("ct disabled bad type", ct(9, 8, [h(4), h(4)], []), 1, [disable]);
    add("ct disabled then enabled", ct(4, 8, [h(4), h(4)], []), 1, [disable, { fn: "enable", args: [] }]);
    const alOn: Tx = { fn: "enableAccessList", args: [] };
    const listProbe: Tx = { fn: "addToAccessList", args: [[probeAddr]] };
    const denyProbe: Tx = { fn: "setDenyList", args: [[probeAddr], true] };
    add("ct access list on, not listed", ct(4, 8, [h(4), h(4)], []), 1, [alOn]);
    add("ct access list on, listed", ct(4, 8, [h(4), h(4)], []), 1, [alOn, listProbe], true);
    add("ct access list on, listed then removed", ct(4, 8, [h(4), h(4)], []), 1, [alOn, listProbe, { fn: "removeFromAccessList", args: [[probeAddr]] }]);
    add("ct access list off, listed only", ct(4, 8, [h(4), h(4)], []), 1, [listProbe]);
    add("ct deny list", ct(4, 8, [h(4), h(4)], []), 1, [denyProbe]);
    add("ct deny list, invalid input", ct(4, F.not, [h(4), h(4)], []), 1, [denyProbe]);
    add("ct deny list ignored when access list on + listed", ct(4, 8, [h(4), h(4)], []), 1, [denyProbe, alOn, listProbe]);
    add("ct deny list off again", ct(4, 8, [h(4), h(4)], []), 1, [denyProbe, { fn: "setDenyList", args: [[probeAddr], false] }]);
    add("ct valid add", ct(4, 8, [h(4), h(4, 0, 1n)], []), 1, undefined, true);

    // ---------------- createRandomTask ----------------
    const rnd = (t: number, seed: bigint, z: number) => I.encodeFunctionData("createRandomTask", [t, seed, z]);
    for (const t of [...TYPES, 1, 8, 255]) for (const z of [0, 1, 2, -1]) for (const s of [0n, 12345n]) add(`rnd t=${t} z=${z} seed=${s}`, rnd(t, s, z));
    add("rnd valid seed 0", rnd(4, 0n, 0), 1, undefined, true);
    add("rnd valid seed n", rnd(4, 7n, 0), 1, undefined, true);
    add("rnd seed max", rnd(4, UINT256_MAX, 1));
    add("rnd disabled", rnd(4, 7n, 0), 1, [disable]);
    add("rnd disabled bad type", rnd(9, 7n, 0), 1, [disable]);
    add("rnd access list on", rnd(4, 0n, 0), 1, [alOn]);
    add("rnd access list on + listed", rnd(4, 7n, 0), 1, [alOn, listProbe]);
    add("rnd deny list", rnd(4, 7n, 0), 1, [denyProbe]);

    // ---------------- batchVerifyInputs ----------------
    type In = { ctHash: bigint; securityZone: number; utype: number };
    const signBatch = (w: any, inputs: In[], sender: string, contract = probeAddr) => {
      const hs = inputs.map((x) => ethers.solidityPackedKeccak256(["uint256", "uint8", "uint8", "address", "uint256", "address"], [x.ctHash, x.utype, x.securityZone, sender, chainId, contract]));
      return w.signingKey.sign(ethers.keccak256(ethers.concat(hs.length ? hs : ["0x"]))).serialized;
    };
    const bvi = (inputs: In[], sender: string, sig: string) => I.encodeFunctionData("batchVerifyInputs", [inputs.map((x) => [x.ctHash, x.securityZone, x.utype]), sender, sig]);
    const in1: In[] = [{ ctHash: 0x1234n << 16n, securityZone: 0, utype: 4 }];
    const in3: In[] = [
      { ctHash: 0xaaaan << 200n, securityZone: 0, utype: 0 },
      { ctHash: UINT256_MAX, securityZone: 1, utype: 7 },
      { ctHash: 0n, securityZone: 1, utype: 6 },
    ];
    const user = owner.address;
    add("bvi valid 1", bvi(in1, user, signBatch(vSigner, in1, user)), 2, undefined, true);
    add("bvi valid 3", bvi(in3, user, signBatch(vSigner, in3, user)), 2, undefined, true);
    for (const t of [...TYPES, 1, 8, 255]) {
      const x: In[] = [{ ctHash: 77n, securityZone: 1, utype: t }];
      add(`bvi utype ${t}`, bvi(x, user, signBatch(vSigner, x, user)), 2);
    }
    add("bvi wrong signer", bvi(in3, user, signBatch(wrong, in3, user)), 2);
    add("bvi tampered ctHash", bvi([{ ...in3[0], ctHash: 1n }, in3[1], in3[2]], user, signBatch(vSigner, in3, user)), 2);
    add("bvi tampered utype", bvi([{ ...in1[0], utype: 5 }], user, signBatch(vSigner, in1, user)), 2);
    add("bvi tampered order", bvi([in3[1], in3[0], in3[2]], user, signBatch(vSigner, in3, user)), 2);
    add("bvi wrong sender param", bvi(in1, probeAddr, signBatch(vSigner, in1, user)), 2);
    add("bvi signed for other contract", bvi(in1, user, signBatch(vSigner, in1, user, tmAddr)), 2);
    for (const z of [2, 127, 128, 255]) {
      const x: In[] = [{ ctHash: 5n, securityZone: z, utype: 4 }];
      add(`bvi bad zone ${z}`, bvi(x, user, signBatch(vSigner, x, user)), 2);
    }
    add("bvi bad zone 2nd item", bvi([in1[0], { ...in1[0], securityZone: 2 }], user, signBatch(vSigner, [in1[0], { ...in1[0], securityZone: 2 }], user)), 2);
    add("bvi empty batch, valid sig", bvi([], user, signBatch(vSigner, [], user)), 2);
    add("bvi empty batch, wrong sig", bvi([], user, signBatch(wrong, [], user)), 2);
    add("bvi empty sig", bvi(in1, user, "0x"), 2);
    add("bvi short sig", bvi(in1, user, "0x" + "11".repeat(10)), 2);
    add("bvi 64-byte sig", bvi(in1, user, "0x" + "11".repeat(64)), 2);
    add("bvi zero sig", bvi(in1, user, "0x" + "00".repeat(65)), 2);
    const sigIn1 = ethers.Signature.from(signBatch(vSigner, in1, user));
    const highS = ethers.concat([sigIn1.r, ethers.toBeHex(SECP_N - BigInt(sigIn1.s), 32), sigIn1.v === 27 ? "0x1c" : "0x1b"]);
    add("bvi high-s sig", bvi(in1, user, highS), 2);
    add("bvi compact 64-byte valid sig", bvi(in1, user, sigIn1.compactSerialized), 2);
    const zeroV: Tx = { fn: "setVerifierSigner", args: [ethers.ZeroAddress] };
    add("bvi signer 0, garbage sig", bvi(in3, user, "0x1234"), 2, [zeroV], true);
    add("bvi signer 0, bad zone", bvi([{ ctHash: 5n, securityZone: 9, utype: 4 }], user, "0x"), 2, [zeroV]);
    add("bvi signer 0, empty", bvi([], user, "0x"), 2, [zeroV]);
    add("bvi access list on", bvi(in1, user, signBatch(vSigner, in1, user)), 2, [alOn]);
    add("bvi access list on + listed", bvi(in1, user, signBatch(vSigner, in1, user)), 2, [alOn, listProbe]);
    add("bvi deny list", bvi(in1, user, signBatch(vSigner, in1, user)), 2, [denyProbe]);
    add("bvi disabled", bvi(in1, user, signBatch(vSigner, in1, user)), 2, [disable]);

    // ---------------- decrypt results ----------------
    const decHash = (ctHash: bigint, result: bigint) =>
      ethers.solidityPackedKeccak256(["uint256", "uint32", "uint64", "uint256"], [result, Number((ctHash >> 8n) & 0x7fn), chainId, ctHash]);
    const signDec = (w: any, ctHash: bigint, result: bigint) => w.signingKey.sign(decHash(ctHash, result)).serialized;
    const c1 = h(4), c2 = h(2, 1), c3 = h(0);
    const r1 = 42n, r2 = 255n, r3 = 1n;
    const sig1 = signDec(dSigner, c1, r1), sig2 = signDec(dSigner, c2, r2), sig3 = signDec(dSigner, c3, r3);
    const badSigs: Record<string, string> = {
      "wrong signer": signDec(wrong, c1, r1),
      "wrong result": signDec(dSigner, c1, r1 + 1n),
      "empty": "0x",
      "short": "0x" + "22".repeat(10),
      "64 bytes": "0x" + "22".repeat(64),
      "zero": "0x" + "00".repeat(65),
      "compact valid": ethers.Signature.from(sig1).compactSerialized,
      "high-s": (() => { const s = ethers.Signature.from(sig1); return ethers.concat([s.r, ethers.toBeHex(SECP_N - BigInt(s.s), 32), s.v === 27 ? "0x1c" : "0x1b"]); })(),
      "bad v": ethers.concat([ethers.dataSlice(sig1, 0, 64), "0x05"]),
    };
    const zeroD: Tx = { fn: "setDecryptResultSigner", args: [ethers.ZeroAddress] };
    for (const fn of ["publishDecryptResult", "verifyDecryptResult", "verifyDecryptResultSafe"]) {
      const enc = (sig: string, r = r1) => I.encodeFunctionData(fn, [c1, r, sig]);
      add(`${fn} valid`, enc(sig1), 0, undefined, true);
      add(`${fn} valid ebool`, I.encodeFunctionData(fn, [c3, r3, sig3]), 0, undefined, true);
      for (const [k, s] of Object.entries(badSigs)) add(`${fn} ${k}`, enc(s), 0);
      add(`${fn} signer 0, garbage`, enc("0xdead"), 0, [zeroD], true);
      add(`${fn} signer 0, wrong signer sig`, enc(badSigs["wrong signer"]), 0, [zeroD], true);
      add(`${fn} disabled`, enc(sig1), 0, [disable]);
      add(`${fn} access list on`, enc(sig1), 0, [alOn]);
    }
    for (const fn of ["publishDecryptResultBatch", "verifyDecryptResultBatch", "verifyDecryptResultBatchSafe"]) {
      const enc = (cs: bigint[], rs: bigint[], ss: string[]) => I.encodeFunctionData(fn, [cs, rs, ss]);
      add(`${fn} valid 3`, enc([c1, c2, c3], [r1, r2, r3], [sig1, sig2, sig3]), 0, undefined, true);
      add(`${fn} empty`, enc([], [], []), 0);
      for (const [k, s] of Object.entries(badSigs)) add(`${fn} item2 ${k}`, enc([c1, c2, c3], [r1, r2, r3], [sig1, s, sig3]), 0);
      add(`${fn} len mismatch results`, enc([c1, c2], [r1], [sig1, sig2]), 0);
      add(`${fn} len mismatch sigs`, enc([c1, c2], [r1, r2], [sig1]), 0);
      add(`${fn} len mismatch both`, enc([c1], [r1, r2], [sig1, sig2]), 0);
      add(`${fn} signer 0, garbage`, enc([c1, c2], [r1, r2], ["0x", "0x01"]), 0, [zeroD], true);
      add(`${fn} signer 0, len mismatch`, enc([c1, c2], [r1], ["0x", "0x01"]), 0, [zeroD]);
      add(`${fn} disabled`, enc([c1], [r1], [sig1]), 0, [disable]);
      add(`${fn} duplicate item`, enc([c1, c1], [r1, r1], [sig1, sig1]), 0);
    }

    // ---------------- run ----------------
    const snap0 = await ethers.provider.send("evm_snapshot", []);
    const t0 = (await ethers.provider.getBlock("latest"))!.timestamp + 1000;
    let snap = snap0;

    const runCase = async (c: Case, impl: string) => {
      await ethers.provider.send("evm_revert", [snap]);
      snap = await ethers.provider.send("evm_snapshot", []);
      await ethers.provider.send("hardhat_setStorageAt", [tmAddr, IMPL_SLOT, ethers.zeroPadValue(impl, 32)]);
      const out: any[] = [];
      let ts = t0;
      for (const p of c.pre ?? []) {
        await ethers.provider.send("evm_setNextBlockTimestamp", [ts++]);
        const r = await (await tm[p.fn](...p.args, { gasLimit: GAS })).wait();
        out.push({ pre: p.fn, status: r.status, logs: r.logs.map((l: any) => [l.address, l.topics, l.data]) });
      }
      await ethers.provider.send("evm_setNextBlockTimestamp", [ts]);
      const r = await (await probe.exec(tmAddr, c.data, c.mode, { gasLimit: GAS })).wait();
      const logs = r.logs.map((l: any) => [l.address, l.topics, l.data]);
      const res = probe.interface.parseLog(r.logs[r.logs.length - 1]);
      // The probe's in-transaction isAllowed cannot tell a transient grant from a permanent one;
      // a read after the transaction can, because transient grants are gone by then.
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const handles: bigint[] = !res.args.success || c.mode === 0 ? []
        : c.mode === 1 ? [coder.decode(["uint256"], res.args.ret)[0]]
        : [...coder.decode(["uint256[]"], res.args.ret)[0]];
      const allowedAfter = await Promise.all(handles.map((handle) => tm.isAllowed(handle, probeAddr)));
      out.push({ status: r.status, logs, allowedAfter });
      return { out, ok: res.args.success as boolean, gas: r.gasUsed as bigint };
    };

    const mismatches: string[] = [];
    let okCount = 0, gasBase = 0n, gasCand = 0n;
    for (const c of cases) {
      const b = await runCase(c, impls.baseline);
      const k = await runCase(c, impls.candidate);
      if (b.ok) okCount++;
      gasBase += b.gas; gasCand += k.gas;
      if (c.expectOk !== undefined && b.ok !== c.expectOk) throw new Error(`matrix self-check failed on baseline: ${c.name} ok=${b.ok}`);
      const bj = JSON.stringify(b.out, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      const kj = JSON.stringify(k.out, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      if (bj !== kj) mismatches.push(`${c.name}\n  baseline:  ${bj}\n  candidate: ${kj}`);
    }
    console.log(`TMDIFF cases=${cases.length} baselineSuccess=${okCount} reverted=${cases.length - okCount} mismatches=${mismatches.length} gasBase=${gasBase} gasCand=${gasCand}`);
    for (const m of mismatches) console.log("TMDIFF MISMATCH " + m);
    expect(gasBase).to.not.equal(gasCand, "both runs used the same code: impl swap had no effect");
    expect(mismatches).to.deep.equal([]);
  });
});
