/**
 * Shared parsing of the Bindings* surface in FHE.sol, used by the delegation and coverage checks.
 */

import * as path from "path";

// contracts/internal/host-chain/test/bindings -> contracts/FHE.sol
export const FHE_SOL = path.resolve(__dirname, "../../../../FHE.sol");

export const BINDINGS_SOL = path.resolve(
  __dirname,
  "../../contracts/tests/Bindings.sol"
);

/** One per encrypted type. A new type is a deliberate event that should update this list. */
export const EXPECTED_LIBRARIES = [
  "BindingsEbool",
  "BindingsEuint8",
  "BindingsEuint16",
  "BindingsEuint32",
  "BindingsEuint64",
  "BindingsEuint128",
  "BindingsEaddress",
];

/** Library name -> the Solidity type it binds, which is also the prefix used in fixture labels. */
export const LIBRARY_TYPES: Record<string, string> = {
  BindingsEbool: "ebool",
  BindingsEuint8: "euint8",
  BindingsEuint16: "euint16",
  BindingsEuint32: "euint32",
  BindingsEuint64: "euint64",
  BindingsEuint128: "euint128",
  BindingsEaddress: "eaddress",
};

/**
 * Bindings that return void or bool. They carry no handle, so the on-chain fixture cannot compare
 * them and only the static checks cover them.
 */
export const ACL_AND_UTIL = new Set([
  "allow",
  "allowThis",
  "allowGlobal",
  "allowPublic",
  "allowSender",
  "allowTransient",
  "allowForDecryption",
  "isAllowed",
  "isPubliclyAllowed",
  "isInitialized",
  "unwrap",
]);

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Text between the brace at `open` and its match, plus the index just past the closing brace. */
export function matchBrace(source: string, open: number): { inner: string; end: number } {
  let depth = 1;
  let i = open + 1;

  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }

  return { inner: source.slice(open + 1, i - 1), end: i };
}

/** Trailing identifier of each comma-separated entry: `euint8 lhs, euint8 rhs` -> [lhs, rhs]. */
export function splitNames(list: string): string[] {
  return list
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(/\s+/).pop() as string);
}

/** Body of each `library Bindings* { ... }`, comments already stripped. */
export function libraryBodies(source: string): Map<string, string> {
  const stripped = stripComments(source);
  const bodies = new Map<string, string>();
  const header = /library\s+(Bindings\w+)\s*\{/g;

  for (let match = header.exec(stripped); match !== null; match = header.exec(stripped)) {
    const { inner, end } = matchBrace(stripped, match.index + match[0].length - 1);
    bodies.set(match[1], inner);
    header.lastIndex = end;
  }

  return bodies;
}

/** Every binding name declared in each library, in source order. */
export function bindingNames(source: string): Map<string, string[]> {
  const names = new Map<string, string[]>();

  for (const [library, body] of libraryBodies(source)) {
    names.set(
      library,
      [...body.matchAll(/\bfunction\s+(\w+)\s*\([\s\S]*?\)\s*internal\b/g)].map((m) => m[1])
    );
  }

  return names;
}
