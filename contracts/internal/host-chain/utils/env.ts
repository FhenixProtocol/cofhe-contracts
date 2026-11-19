/** The trimmed value of an environment variable, or an error naming it when blank or unset. */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}
