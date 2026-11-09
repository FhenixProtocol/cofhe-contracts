import hre from "hardhat";
import fs from "fs";
const { ethers } = hre;
import { grantAllRoles } from "../../utils/roles";
import { installAddressBook, registerTaskManager } from "../helpers/addressBook";

// Traces one createTask (FHE.asEuint8 -> trivialEncrypt) and splits its gas by frame and opcode.
describe("GasTrace", function () {
  it("traces createTask", async function () {
    if (!process.env.GAS_TRACE_OUT) this.skip();
    await ethers.provider.send("hardhat_reset", []);
    const [owner] = await ethers.getSigners();
    const names: Record<string, string> = {};
    const addressBook = await installAddressBook(owner);
    let libraries: Record<string, string> | undefined;
    if (await hre.artifacts.artifactExists("TaskManagerLib")) {
      const lib = await ethers.deployContract("TaskManagerLib");
      libraries = { TaskManagerLib: await lib.getAddress() };
      names[(await lib.getAddress()).toLowerCase()] = "TaskManagerLib";
    }
    const Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const ctorArgs: string[] = [];
    if (await hre.artifacts.artifactExists("TaskManagerHelper")) {
      const helperImpl = await ethers.deployContract("TaskManagerHelper");
      const helperProxy = await Proxy.deploy(await helperImpl.getAddress(), "0x");
      ctorArgs.push(await helperProxy.getAddress());
      names[(await helperImpl.getAddress()).toLowerCase()] = "TaskManagerHelper impl";
      names[(await helperProxy.getAddress()).toLowerCase()] = "TaskManagerHelper proxy";
    }
    const TaskManager = await ethers.getContractFactory("TaskManager", libraries ? { libraries } : {});
    const impl = await TaskManager.deploy(...ctorArgs);
    const tmProxy = await Proxy.deploy(await impl.getAddress(), TaskManager.interface.encodeFunctionData("initialize", [owner.address, 0]));
    const tmAddr = await tmProxy.getAddress();
    const tm: any = TaskManager.attach(tmAddr);
    await registerTaskManager(addressBook, tmAddr);
    const ACL = await ethers.getContractFactory("ACL");
    const aclImpl = await ACL.deploy();
    const aclProxy = await Proxy.deploy(await aclImpl.getAddress(), ACL.interface.encodeFunctionData("initialize", [owner.address, 0, tmAddr]));
    const PS = await ethers.getContractFactory("PlaintextsStorage");
    const psImpl = await PS.deploy();
    const psProxy = await Proxy.deploy(await psImpl.getAddress(), PS.interface.encodeFunctionData("initialize", [owner.address, 0, tmAddr]));
    await grantAllRoles(tm, owner, undefined, false);
    await grantAllRoles(ACL.attach(await aclProxy.getAddress()), owner, undefined, false);
    await tm.setACLContract(await aclProxy.getAddress());
    await tm.setPlaintextsStorage(await psProxy.getAddress());
    await tm.setSecurityZones(-128, 127);
    const t = await (await ethers.getContractFactory("PubliclyAllowedTest")).deploy();
    const known: [string, string][] = [
      [tmAddr, "TaskManager proxy"],
      [await impl.getAddress(), "TaskManager impl"],
      [await aclProxy.getAddress(), "ACL proxy"],
      [await aclImpl.getAddress(), "ACL impl"],
      [await t.getAddress(), "test contract"],
    ];
    for (const [a, n] of known) names[a.toLowerCase()] = n;

    await (await t.createWithoutGlobal(1)).wait(); // warm-up: the first call pays one-time storage init
    const rc = await (await t.createWithoutGlobal(42)).wait();
    const trace = await ethers.provider.send("debug_traceTransaction", [rc!.hash, { disableStorage: true, disableMemory: true }]);
    const logs = trace.structLogs;
    const calls = new Set(["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE"]);
    const byOp: Record<string, number> = {};
    const byFrame: Record<string, number> = {};
    const callOverhead: Record<string, number> = {};
    const frames: string[] = ["test contract"];
    for (let i = 0; i < logs.length; i++) {
      const s = logs[i];
      const frame = frames[s.depth - 1] ?? "?";
      let cost = s.gasCost;
      if (calls.has(s.op)) {
        const target = "0x" + s.stack[s.stack.length - 2].slice(-40).toLowerCase();
        const n = logs[i + 1];
        if (n && n.depth === s.depth + 1) {
          frames[s.depth] = (names[target] ?? target) + (s.op === "DELEGATECALL" ? " (delegatecall)" : "");
          let j = i + 1;
          while (j < logs.length && logs[j].depth > s.depth) j++;
          // A call opcode's reported cost includes the gas it forwards; keep only its own overhead.
          const childUsed = n.gas - (logs[j - 1].gas - logs[j - 1].gasCost);
          cost = s.gas - (logs[j] ? logs[j].gas : s.gas) - childUsed;
          const key = `${frame} -> ${frames[s.depth]}`;
          callOverhead[key] = (callOverhead[key] ?? 0) + cost;
        } else if (n) {
          cost = s.gas - n.gas; // precompile or account without code
        }
      }
      byOp[s.op] = (byOp[s.op] ?? 0) + cost;
      byFrame[frame] = (byFrame[frame] ?? 0) + cost;
    }
    const taskCreatedTopic = TaskManager.interface.getEvent("TaskCreated")!.topicHash;
    const taskCreated = rc!.logs.filter((log) => log.topics[0] === taskCreatedTopic);
    const taskCreatedFrom = taskCreated.map((log) => names[log.address.toLowerCase()] ?? log.address);
    fs.writeFileSync(process.env.GAS_TRACE_OUT!, JSON.stringify({ gasUsed: Number(rc!.gasUsed), taskCreatedFrom, byFrame, callOverhead, byOp }, null, 1));
  });
});
