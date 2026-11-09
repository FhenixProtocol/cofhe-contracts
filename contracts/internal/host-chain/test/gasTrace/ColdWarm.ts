import hre from "hardhat";
const { ethers } = hre;
import { deployOnChainFixture } from "../onChain/OnChain.fixture";

// Lists the own overhead of every call into the library in one transaction with many tasks,
// to show which call pays the cold-account price and which pay the warm price.
describe("ColdWarm", function () {
  it("lists per-call overhead of library calls in OnChain.trivial8", async function () {
    if (!process.env.GAS_TRACE_OUT) this.skip();
    const { testContract } = await deployOnChainFixture();
    const libAddress = (await hre.artifacts.readArtifact("TaskManager")).deployedLinkReferences;
    const rc = await (await testContract.trivial8(3, 5)).wait();
    const trace = await ethers.provider.send("debug_traceTransaction", [rc!.hash, { disableStorage: true, disableMemory: true }]);
    const logs = trace.structLogs;
    const perCall: number[] = [];
    const byTarget: Record<string, number[]> = {};
    for (let i = 0; i < logs.length; i++) {
      const s = logs[i];
      if (s.op !== "DELEGATECALL") continue;
      const n = logs[i + 1];
      if (!n || n.depth !== s.depth + 1) continue;
      // Library code is the only delegatecall target whose first frame is entered from TaskManager impl
      // at depth >= 3 (test contract -> TM proxy -> TM impl -> lib).
      if (s.depth < 3) continue;
      const target = "0x" + s.stack[s.stack.length - 2].slice(-40).toLowerCase();
      let j = i + 1;
      while (j < logs.length && logs[j].depth > s.depth) j++;
      const childUsed = n.gas - (logs[j - 1].gas - logs[j - 1].gasCost);
      perCall.push(s.gas - logs[j].gas - childUsed);
      const list = (byTarget[target] ??= []);
      list.push(s.gas - logs[j].gas - childUsed);
    }
    const summary = Object.fromEntries(
      Object.entries(byTarget).map(([t, v]) => [t, { calls: v.length, first: v[0], rest: [...new Set(v.slice(1))], total: v.reduce((a, b) => a + b, 0) }]),
    );
    console.log(JSON.stringify({ gasUsed: Number(rc!.gasUsed), linkRefs: Object.keys(libAddress), summary }));
  });
});
