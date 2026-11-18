import type { HardhatRuntimeEnvironment } from "hardhat/types";

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** The implementation an ERC-1967 proxy points to. */
export async function implementationOf(ethers: any, proxy: string): Promise<string> {
  return ethers.getAddress("0x" + (await ethers.provider.getStorage(proxy, IMPLEMENTATION_SLOT)).slice(-40));
}

/**
 * Whether the proxy's implementation is exactly this build of `source:name`. UUPSUpgradeable
 * keeps the implementation's own address as an immutable, so those bytes are zeroed (as they are
 * in the compiler output) before comparing.
 */
export async function runsCurrentBuild(
  hre: HardhatRuntimeEnvironment,
  proxy: string,
  source: string,
  name: string,
): Promise<boolean> {
  const buildInfo = await hre.artifacts.getBuildInfo(`${source}:${name}`);
  if (!buildInfo) {
    throw new Error(`No build info for ${name}. Run \`pnpm compile\` first.`);
  }
  const deployed = buildInfo.output.contracts[source][name].evm.deployedBytecode;
  const expected = deployed.object.toLowerCase().replace(/^0x/, "");
  let code: string = (await hre.ethers.provider.getCode(await implementationOf(hre.ethers, proxy)))
    .toLowerCase()
    .slice(2);
  if (code.length !== expected.length) {
    return false;
  }
  for (const refs of Object.values(deployed.immutableReferences ?? {}) as { start: number; length: number }[][]) {
    for (const { start, length } of refs) {
      code = code.slice(0, start * 2) + "00".repeat(length) + code.slice((start + length) * 2);
    }
  }
  return code === expected;
}

/**
 * Waits until the RPC reports `address`'s nonce past `nonce`, i.e. the transaction that used it is
 * accepted, so the next transaction from the same key is not numbered from a stale count.
 */
export async function waitForNonce(ethers: any, address: string, nonce: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await ethers.provider.getTransactionCount(address, "latest")) <= nonce) {
    if (Date.now() > deadline) {
      throw new Error(
        `The RPC still reports ${address}'s nonce at ${nonce} after ${timeoutMs / 1000} s. ` +
          `Nothing was upgraded - re-run the task.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
