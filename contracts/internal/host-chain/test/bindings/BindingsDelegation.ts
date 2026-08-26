/**
 * Static check that every Bindings<T> function forwards to the identically-named FHE function,
 * passing its own parameters through unchanged.
 *
 * The on-chain fixture can only reach bindings that return a handle. The ACL and utility
 * forwarders return void or bool, so a slip like `allowGlobal` calling `FHE.allowThis`, or
 * `allow(ctHash, account)` calling `FHE.allow(ctHash, msg.sender)`, is invisible there -- and is
 * an access-control bug, not a compute bug. This reads FHE.sol as text and covers all of them.
 *
 * Two failure modes this file has to avoid, because both would pass green while checking nothing:
 *
 *   1. A binding that does not match the expected shape gets skipped rather than reported. Guarded
 *      by counting `function` declarations loosely and requiring that every one of them parsed --
 *      a wrapped signature becomes a failure, never a silent drop.
 *   2. A whole library stops matching and its functions vanish. Guarded by asserting the exact set
 *      of library names.
 *
 * Checking the callee name alone is not enough, so the forwarded argument list is compared to the
 * binding's own parameter list, in order.
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

// One per encrypted type. A new type is a deliberate event that should update this list.
const EXPECTED_LIBRARIES = [
  "BindingsEbool",
  "BindingsEuint8",
  "BindingsEuint16",
  "BindingsEuint32",
  "BindingsEuint64",
  "BindingsEuint128",
  "BindingsEaddress",
];

interface Binding {
  library: string;
  name: string;
  expected: string;
  params: string[];
  callee: string;
  args: string[];
}

interface ParsedLibrary {
  name: string;
  declared: number; // `function` declarations found by a loose scan
  bindings: Binding[]; // those that parsed completely
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function splitNames(list: string): string[] {
  return list
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(/\s+/).pop() as string);
}

/** Body of `library <name> { ... }`, found by brace matching so nested braces are safe. */
function libraryBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const header = /library\s+(Bindings\w+)\s*\{/g;

  for (let match = header.exec(source); match !== null; match = header.exec(source)) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;

    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }

    bodies.set(match[1], source.slice(start, i - 1));
  }

  return bodies;
}

function parseLibrary(name: string, body: string): ParsedLibrary {
  const declared = body.match(/\bfunction\s+\w+\s*\(/g)?.length ?? 0;

  // Tolerates wrapped signatures and wrapped bodies; captures the first statement.
  const full = /\bfunction\s+(\w+)\s*\(([\s\S]*?)\)\s*internal\b[^{]*\{\s*([\s\S]*?);/g;
  const bindings: Binding[] = [];

  for (let match = full.exec(body); match !== null; match = full.exec(body)) {
    const [, fnName, paramList, statement] = match;
    const call = /^(?:return\s+)?FHE\.(\w+)\s*\(([\s\S]*)\)$/.exec(statement.trim());
    if (!call) continue;

    bindings.push({
      library: name,
      name: fnName,
      expected: CAST_ALIASES[fnName] ?? fnName,
      params: splitNames(paramList),
      callee: call[1],
      args: splitNames(call[2]),
    });
  }

  return { name, declared, bindings };
}

describe("FHE.sol binding delegation", function () {
  const source = stripComments(fs.readFileSync(FHE_SOL, "utf8"));
  const libraries = [...libraryBodies(source)].map(([name, body]) => parseLibrary(name, body));
  const bindings = libraries.flatMap((library) => library.bindings);

  it("finds every Bindings library", function () {
    expect(libraries.map((library) => library.name).sort()).to.deep.equal(
      [...EXPECTED_LIBRARIES].sort()
    );
  });

  it("parses every function it finds, so none is skipped silently", function () {
    const unparsed = libraries
      .filter((library) => library.bindings.length !== library.declared)
      .map(
        (library) =>
          `${library.name}: ${library.declared} declared, ${library.bindings.length} parsed`
      );

    expect(unparsed, `bindings that did not parse:\n${unparsed.join("\n")}`).to.be.empty;
  });

  it("forwards every binding to the identically-named FHE function", function () {
    const wrong = bindings
      .filter((binding) => binding.callee !== binding.expected)
      .map((binding) => `${binding.library}.${binding.name} -> FHE.${binding.callee}`);

    expect(wrong, `bindings calling the wrong FHE function:\n${wrong.join("\n")}`).to.be.empty;
  });

  it("passes its own parameters through unchanged", function () {
    const wrong = bindings
      .filter((binding) => binding.args.join(",") !== binding.params.join(","))
      .map(
        (binding) =>
          `${binding.library}.${binding.name}(${binding.params.join(", ")}) -> ` +
          `FHE.${binding.callee}(${binding.args.join(", ")})`
      );

    expect(wrong, `bindings altering their arguments:\n${wrong.join("\n")}`).to.be.empty;
  });
});
