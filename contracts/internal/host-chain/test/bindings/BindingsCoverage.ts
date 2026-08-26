/**
 * Guards the *shape* of the binding surface, where BindingsDelegation.ts guards each binding's body.
 *
 * Delegation checking alone cannot see a binding that is not there. Deleting one drops the declared
 * and parsed counts together, so the delegation suite stays green while coverage silently shrinks --
 * and a missing binding is the bug this whole area exists to prevent (cofhe-contracts#102 shipped
 * `div`/`rem` present on euint8/16/32 and absent on euint64/128).
 *
 * Three properties, each catching a different way the surface can rot:
 *   - exact counts, so a deletion has to be a deliberate edit here;
 *   - symmetry across the numeric types, which is the exact shape of #102;
 *   - the on-chain fixture naming every binding that returns a handle, so Bindings.sol cannot fall
 *     behind FHE.sol without failing.
 */

import { expect } from "chai";
import * as fs from "fs";

import {
  ACL_AND_UTIL,
  BINDINGS_SOL,
  FHE_SOL,
  LIBRARY_TYPES,
  bindingNames,
} from "./surface";

/**
 * Deliberately exact. Adding a binding should be a visible two-line act, not an invisible one --
 * cofhe-contracts#105 raises every entry by one when `allowForDecryption` lands.
 */
const EXPECTED_BINDINGS: Record<string, number> = {
  BindingsEbool: 21,
  BindingsEuint8: 37,
  BindingsEuint16: 37,
  BindingsEuint32: 37,
  BindingsEuint64: 37,
  BindingsEuint128: 37,
  BindingsEaddress: 18,
};

/** The types that share one arithmetic/comparison/bitwise surface. Casts differ per width. */
const NUMERIC_LIBRARIES = [
  "BindingsEuint8",
  "BindingsEuint16",
  "BindingsEuint32",
  "BindingsEuint64",
  "BindingsEuint128",
];

const CASTS = new Set(["toBool", "toU8", "toU16", "toU32", "toU64", "toU128"]);

describe("FHE.sol binding surface", function () {
  const names = bindingNames(fs.readFileSync(FHE_SOL, "utf8"));

  it("holds the expected number of bindings per library", function () {
    const actual = Object.fromEntries([...names].map(([lib, fns]) => [lib, fns.length]));
    expect(actual).to.deep.equal(EXPECTED_BINDINGS);
  });

  it("declares no binding twice", function () {
    const duplicated = [...names].flatMap(([library, fns]) =>
      fns.filter((fn, i) => fns.indexOf(fn) !== i).map((fn) => `${library}.${fn}`)
    );

    expect(duplicated, `bindings declared more than once:\n${duplicated.join("\n")}`).to.be.empty;
  });

  it("offers the same non-cast operations on every numeric type", function () {
    const perType = new Map(
      NUMERIC_LIBRARIES.map((library) => [
        library,
        new Set((names.get(library) ?? []).filter((fn) => !CASTS.has(fn))),
      ])
    );
    const everyOp = new Set([...perType.values()].flatMap((ops) => [...ops]));

    const missing = [...everyOp]
      .sort()
      .flatMap((op) =>
        NUMERIC_LIBRARIES.filter((library) => !perType.get(library)?.has(op)).map(
          (library) => `${library} is missing ${op}`
        )
      );

    expect(missing, `asymmetric numeric bindings:\n${missing.join("\n")}`).to.be.empty;
  });

  it("exercises every handle-returning binding in the on-chain fixture", function () {
    // Each assertion in Bindings.sol carries its subject as the revert string, e.g. "euint8.div",
    // so the fixture's own labels are the coverage manifest.
    const exercised = new Set(
      [...fs.readFileSync(BINDINGS_SOL, "utf8").matchAll(/"(\w+\.\w+)"/g)].map((m) => m[1])
    );

    const expected = [...names].flatMap(([library, fns]) =>
      fns
        .filter((fn) => !ACL_AND_UTIL.has(fn))
        .map((fn) => `${LIBRARY_TYPES[library]}.${fn}`)
    );

    const uncovered = expected.filter((label) => !exercised.has(label));
    expect(uncovered, `bindings missing from Bindings.sol:\n${uncovered.join("\n")}`).to.be.empty;
  });
});
