/**
 * Static check that every Bindings<T> function forwards to the identically-named FHE function.
 *
 * The on-chain fixture can only reach bindings that return a handle. The ACL and utility
 * forwarders return void or bool, so a slip like `allowGlobal` calling `FHE.allowThis` is
 * invisible there -- and is an access-control bug, not a compute bug. This reads FHE.sol as
 * text and covers all of them.
 *
 * The check is deliberately whole-file: it discovers the libraries and their functions rather
 * than reading from a hardcoded list, so a binding added later is covered without touching this
 * file. That makes a silent no-match the main failure mode, hence the floor assertions below.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

// contracts/internal/host-chain/test/bindings -> contracts/FHE.sol
const FHE_SOL = path.resolve(__dirname, "../../../../FHE.sol");

// The only bindings whose name differs from the FHE function they forward to.
const CAST_ALIASES: Record<string, string> = {
  toBool: "asEbool",
  toU8: "asEuint8",
  toU16: "asEuint16",
  toU32: "asEuint32",
  toU64: "asEuint64",
  toU128: "asEuint128",
};

// Guards against a parser that silently matches nothing and reports success.
const MIN_LIBRARIES = 7;
const MIN_FUNCTIONS = 200;

interface Binding {
  library: string;
  name: string;
  expected: string;
  body: string;
}

function parseBindings(source: string): Binding[] {
  const lines = source.split("\n");
  const bindings: Binding[] = [];
  let currentLibrary: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const libraryMatch = /^library (Bindings\w+) \{/.exec(lines[i]);
    if (libraryMatch) {
      currentLibrary = libraryMatch[1];
      continue;
    }
    // A non-indented `}` closes the library.
    if (currentLibrary && /^\}/.test(lines[i])) {
      currentLibrary = null;
      continue;
    }
    if (!currentLibrary) continue;

    const fnMatch = /^\s*function (\w+)\(.*\) internal/.exec(lines[i]);
    if (!fnMatch) continue;

    const name = fnMatch[1];
    bindings.push({
      library: currentLibrary,
      name,
      expected: CAST_ALIASES[name] ?? name,
      body: lines[i + 1] ?? "",
    });
  }

  return bindings;
}

describe("FHE.sol binding delegation", function () {
  const bindings = parseBindings(fs.readFileSync(FHE_SOL, "utf8"));

  it("finds every Bindings library", function () {
    const libraries = new Set(bindings.map((b) => b.library));
    expect(libraries.size).to.be.at.least(MIN_LIBRARIES);
  });

  it("finds the full binding surface", function () {
    expect(bindings.length).to.be.at.least(MIN_FUNCTIONS);
  });

  it("forwards every binding to the identically-named FHE function", function () {
    const wrong = bindings
      .filter((b) => !new RegExp(`^\\s*(return )?FHE\\.${b.expected}\\(`).test(b.body))
      .map((b) => `${b.library}.${b.name} -> ${b.body.trim()}`);

    expect(wrong, `bindings not forwarding to FHE.<name>:\n${wrong.join("\n")}`).to.be.empty;
  });
});
