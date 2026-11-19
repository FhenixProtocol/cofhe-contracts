/** Everything `run` prints with console.log, joined by newlines. */
export async function logsOf(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}
