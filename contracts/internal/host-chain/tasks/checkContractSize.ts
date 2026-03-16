import { task } from "hardhat/config";
import chalk from "chalk";

const EVM_SIZE_LIMIT = 24_576; // 24KB
const WARN_THRESHOLD = 22_528; // 22KB

const TRACKED_CONTRACTS = [
  "TaskManager",
  "ACL",
  "PlaintextsStorage",
  "ERC1967Proxy",
];

task(
  "task:check-contract-size",
  "Check that contract bytecode stays within the 24KB EVM limit"
).setAction(async function (_taskArguments, hre) {
  await hre.run("compile");

  let failed = false;

  for (const name of TRACKED_CONTRACTS) {
    const artifact = await hre.artifacts.readArtifact(name);
    // deployedBytecode is a hex string starting with "0x"
    const bytecodeSize = (artifact.deployedBytecode.length - 2) / 2;

    const pct = ((bytecodeSize / EVM_SIZE_LIMIT) * 100).toFixed(1);

    if (bytecodeSize > EVM_SIZE_LIMIT) {
      console.log(
        chalk.red(
          `FAIL: ${name} — ${bytecodeSize} bytes (${pct}% of limit, exceeds 24KB by ${bytecodeSize - EVM_SIZE_LIMIT} bytes)`
        )
      );
      failed = true;
    } else if (bytecodeSize > WARN_THRESHOLD) {
      console.log(
        chalk.yellow(
          `WARN: ${name} — ${bytecodeSize} bytes (${pct}% of limit)`
        )
      );
    } else {
      console.log(
        chalk.green(`OK:   ${name} — ${bytecodeSize} bytes (${pct}% of limit)`)
      );
    }
  }

  if (failed) {
    console.log(
      chalk.red(
        "\nOne or more contracts exceed the 24KB EVM bytecode size limit."
      )
    );
    process.exit(1);
  } else {
    console.log(chalk.green("\nAll contracts are within the 24KB size limit."));
  }
});
