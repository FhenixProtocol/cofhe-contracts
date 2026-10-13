import { createInterface } from "readline/promises";

/**
 * Asks `question` on the terminal and resolves true only for "y" / "yes". `yes` skips the prompt.
 * Without a terminal (CI, piped input) it throws rather than hang or proceed unconfirmed.
 */
export async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    throw new Error(`${question} No terminal to confirm on - pass --yes to proceed.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}
