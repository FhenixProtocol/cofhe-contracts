/**
 * Static check that every Bindings<T> function body is exactly one statement forwarding to the
 * identically-named FHE function, passing its own parameters through unchanged.
 *
 * The on-chain fixture can only reach bindings that return a handle. The ACL and utility
 * forwarders return void or bool, so a slip like `allowGlobal` calling `FHE.allowThis`, or
 * `allow(ctHash, account)` calling `FHE.allow(ctHash, msg.sender)`, is invisible there -- and is
 * an access-control bug, not a compute bug. This reads FHE.sol as text and covers all of them.
 *
 * Whole-body matching matters as much as the callee name. A forwarder whose first statement is
 * correct but which then does something extra --
 *
 *     function allow(ebool ctHash, address account) internal {
 *         FHE.allow(ctHash, account);
 *         FHE.allowGlobal(ctHash);     // silently widens access
 *     }
 *
 * -- returns the same handle (or nothing at all), so no on-chain assertion can see it. Requiring
 * the body to be a single forwarding statement is what closes that.
 *
 * Two ways this file could pass while checking nothing, both guarded:
 *   1. A binding gets skipped rather than reported. `function` declarations are counted with a
 *      loose scan and every one must parse, so an unhandled shape fails instead of dropping out.
 *   2. A whole library stops matching and its functions vanish. The set of library names is
 *      asserted exactly.
 * Deletion of a binding is guarded separately, in BindingsCoverage.ts.
 */

import { expect } from "chai";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { EXPECTED_LIBRARIES, FHE_SOL, libraryBodies, matchBrace, splitNames } from "./surface";

// What solc actually compiles: pnpm copies the `file:../../` dependency rather than symlinking it.
const FHE_SOL_COMPILED = path.resolve(
  __dirname,
  "../../node_modules/@fhenixprotocol/cofhe-contracts/FHE.sol"
);

// The only bindings whose name differs from the FHE function they forward to.
const CAST_ALIASES: Record<string, string> = {
  toBool: "asEbool",
  toU8: "asEuint8",
  toU16: "asEuint16",
  toU32: "asEuint32",
  toU64: "asEuint64",
  toU128: "asEuint128",
};

/**
 * One statement, one call, no nesting. Every binding in FHE.sol matches this today; anything that
 * does not is reported rather than waved through, which is the point.
 */
const FORWARDING_STATEMENT = /^(?:return\s+)?FHE\.(\w+)\s*\(([^()]*)\)\s*;$/;

interface Binding {
  library: string;
  name: string;
  expected: string;
  params: string[];
  body: string;
  callee: string | null;
  args: string[];
}

interface ParsedLibrary {
  name: string;
  declared: number;
  bindings: Binding[];
}

function parseLibrary(name: string, body: string): ParsedLibrary {
  const declared = body.match(/\bfunction\s+\w+\s*\(/g)?.length ?? 0;
  const signature = /\bfunction\s+(\w+)\s*\(([\s\S]*?)\)\s*internal\b[^{]*\{/g;
  const bindings: Binding[] = [];

  for (let match = signature.exec(body); match !== null; match = signature.exec(body)) {
    const openBrace = match.index + match[0].length - 1;
    const { inner, end } = matchBrace(body, openBrace);
    const statement = inner.trim();
    const call = FORWARDING_STATEMENT.exec(statement);

    bindings.push({
      library: name,
      name: match[1],
      expected: CAST_ALIASES[match[1]] ?? match[1],
      params: splitNames(match[2]),
      body: statement,
      callee: call ? call[1] : null,
      args: call ? splitNames(call[2]) : [],
    });

    signature.lastIndex = end;
  }

  return { name, declared, bindings };
}

describe("FHE.sol binding delegation", function () {
  const libraries = [...libraryBodies(fs.readFileSync(FHE_SOL, "utf8"))].map(([name, body]) =>
    parseLibrary(name, body)
  );
  const bindings = libraries.flatMap((library) => library.bindings);

  it("checks the same FHE.sol that solc compiles", function () {
    const digest = (file: string) =>
      crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

    expect(
      digest(FHE_SOL_COMPILED),
      "node_modules holds a stale copy of FHE.sol -- run `pnpm install`"
    ).to.equal(digest(FHE_SOL));
  });

  it("finds every Bindings library", function () {
    expect(libraries.map((library) => library.name).sort()).to.deep.equal(
      [...EXPECTED_LIBRARIES].sort()
    );
  });

  it("parses every function it finds, so none is skipped silently", function () {
    const unparsed = libraries
      .filter((library) => library.bindings.length !== library.declared)
      .map((lib) => `${lib.name}: ${lib.declared} declared, ${lib.bindings.length} parsed`);

    expect(unparsed, `bindings that did not parse:\n${unparsed.join("\n")}`).to.be.empty;
  });

  it("is a single forwarding statement per binding, with nothing after it", function () {
    const wrong = bindings
      .filter((binding) => binding.callee === null)
      .map((binding) => `${binding.library}.${binding.name} -> ${binding.body}`);

    expect(wrong, `bindings doing more than one forwarding call:\n${wrong.join("\n")}`).to.be.empty;
  });

  it("forwards every binding to the identically-named FHE function", function () {
    const wrong = bindings
      .filter((binding) => binding.callee !== null && binding.callee !== binding.expected)
      .map((binding) => `${binding.library}.${binding.name} -> FHE.${binding.callee}`);

    expect(wrong, `bindings calling the wrong FHE function:\n${wrong.join("\n")}`).to.be.empty;
  });

  it("passes its own parameters through unchanged", function () {
    const wrong = bindings
      .filter(
        (binding) => binding.callee !== null && binding.args.join(",") !== binding.params.join(",")
      )
      .map(
        (binding) =>
          `${binding.library}.${binding.name}(${binding.params.join(", ")}) -> ` +
          `FHE.${binding.callee}(${binding.args.join(", ")})`
      );

    expect(wrong, `bindings altering their arguments:\n${wrong.join("\n")}`).to.be.empty;
  });
});
