import { expect } from "chai";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

function runHardhatHelpWithoutDotenv(env: NodeJS.ProcessEnv) {
  const tempDir = mkdtempSync(join(tmpdir(), "cofhe-hardhat-config-"));

  try {
    const hardhatCli = require.resolve("hardhat/internal/cli/cli");
    const result = spawnSync(process.execPath, [hardhatCli, "--help"], {
      cwd: resolve(__dirname, "../.."),
      env: {
        ...env,
        DOTENV_CONFIG_PATH: join(tempDir, "missing.env"),
      },
      encoding: "utf8",
      timeout: 10_000,
    });

    const diagnostic = [
      result.stdout,
      result.stderr,
      result.error?.message,
      result.signal && `signal: ${result.signal}`,
    ]
      .filter(Boolean)
      .join("\n");

    expect(result.status, diagnostic).to.equal(0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("Hardhat config", function () {
  it("loads for offline commands without deployment keys", function () {
    const env = { ...process.env };
    delete env.KEY;
    delete env.KEY2;
    delete env.AGGREGATOR_KEY;

    runHardhatHelpWithoutDotenv(env);
  });

  it("loads for offline commands with empty deployment keys", function () {
    runHardhatHelpWithoutDotenv({
      ...process.env,
      KEY: "",
      KEY2: "",
      AGGREGATOR_KEY: "",
    });
  });
});
