#!/usr/bin/env python3
"""Generate src/ZamaProbe.sol: Zama fhEVM ops on euint64, measured like the CoFHE probe.

Every row is `function <id>(bytes calldata args) external returns (uint256 first, uint256 extra)`:
first = the op as the first FHE call of the transaction, extra = the same op again on operands the
first call did not use. Operands load into locals before `gasleft()`. Run from the zama/ folder.
"""
import hashlib
import json
from pathlib import Path

K_NONE, K_INPUT = 0, 1
ALICE = "address(0xA11CE)"


def salted(n, bits=64):
    # Handles are global and derive only from their inputs; salted plaintexts keep them fresh.
    return int.from_bytes(hashlib.sha256(f"pro-575-zama:{n}".encode()).digest(), "big") % (1 << bits)


def measured(call1, call2, pre=""):
    return f"""        euint64 x = a;
        euint64 y = b;
        euint64 z = c;
        euint64 w = d;
{pre}        uint256 g = gasleft();
        {call1};
        first = g - gasleft();
        g = gasleft();
        {call2};
        extra = g - gasleft();
        (x, y, z, w);
"""


# (row id, category, like-for-like with CoFHE?, body, kind)
def rows():
    out = []
    for op in ["add", "sub", "mul", "min", "max"]:
        out.append((op, "Arithmetic", True, measured(f"FHE.{op}(x, y)", f"FHE.{op}(z, w)"), K_NONE))
    out.append(("square", "Arithmetic", True, measured("FHE.mul(x, x)", "FHE.mul(z, z)"), K_NONE))
    for op, zop in [("eq", "eq"), ("ne", "ne"), ("lt", "lt"), ("lte", "le"), ("gt", "gt"), ("gte", "ge")]:
        out.append((op, "Comparison", True, measured(f"FHE.{zop}(x, y)", f"FHE.{zop}(z, w)"), K_NONE))
    for op in ["and", "or", "xor"]:
        out.append((op, "Bitwise", True, measured(f"FHE.{op}(x, y)", f"FHE.{op}(z, w)"), K_NONE))
    out.append(("not", "Bitwise", True, measured("FHE.not(x)", "FHE.not(z)"), K_NONE))
    # Zama shift amounts are euint8; CoFHE shifts by the operand's own type.
    for op, zop in [("shl", "shl"), ("shr", "shr"), ("rol", "rotl"), ("ror", "rotr")]:
        out.append((op, "Bitwise", False, measured(f"FHE.{zop}(x, s1)", f"FHE.{zop}(z, s2)",
                                                   pre="        euint8 s1 = sa;\n        euint8 s2 = sb;\n"), K_NONE))
    out.append(("select", "Select", True, measured(
        "FHE.select(cond, x, y)", "FHE.select(cond2, z, w)",
        pre="        ebool cond = ea;\n        ebool cond2 = eb;\n"), K_NONE))
    out.append(("trivial", "Encrypt", True, measured(
        f"FHE.asEuint64(uint64({salted(11)}))", f"FHE.asEuint64(uint64({salted(12)}))"), K_NONE))
    out.append(("input", "Encrypt", True, measured(
        "FHE.fromExternal(externalEuint64.wrap(h1), p1)", "FHE.fromExternal(externalEuint64.wrap(h2), p2)",
        pre="        (bytes32 h1, bytes memory p1, bytes32 h2, bytes memory p2) = "
            "abi.decode(args, (bytes32, bytes, bytes32, bytes));\n"), K_INPUT))
    out.append(("random", "Encrypt", True, measured("FHE.randEuint64()", "FHE.randEuint64()"), K_NONE))
    out.append(("allow", "Access", True, measured(f"FHE.allow(x, {ALICE})", f"FHE.allow(z, {ALICE})"), K_NONE))
    out.append(("allowThis", "Access", True, measured(
        "FHE.allowThis(f1)", "FHE.allowThis(f2)",
        pre="        euint64 f1 = FHE.add(x, y);\n        euint64 f2 = FHE.add(z, w);\n"), K_NONE))
    out.append(("allowTransient", "Access", True, measured(
        f"FHE.allowTransient(x, {ALICE})", f"FHE.allowTransient(z, {ALICE})"), K_NONE))
    # Zama's closest match to CoFHE allowPublic / allowGlobal.
    out.append(("allowPublic", "Access", True, measured("FHE.makePubliclyDecryptable(x)",
                                                        "FHE.makePubliclyDecryptable(y)"), K_NONE))
    out.append(("isAllowed", "Access", True, measured(f"FHE.isAllowed(x, {ALICE})", f"FHE.isAllowed(z, {ALICE})"),
                K_NONE))
    # Zama-only: plaintext operands. CoFHE has no scalar overloads and divides by an encrypted value.
    out.append(("div (plaintext divisor)", "Zama only", False,
                measured("FHE.div(x, uint64(7))", "FHE.div(z, uint64(9))"), K_NONE))
    out.append(("rem (plaintext divisor)", "Zama only", False,
                measured("FHE.rem(x, uint64(7))", "FHE.rem(z, uint64(9))"), K_NONE))
    out.append(("add (plaintext operand)", "Zama only", False,
                measured("FHE.add(x, uint64(7))", "FHE.add(z, uint64(9))"), K_NONE))
    return out


def fn_name(rid):
    return "r_" + "".join(ch if ch.isalnum() else "_" for ch in rid)


def main():
    rs = rows()
    fns = "".join(f"""
    function {fn_name(rid)}(bytes calldata args) external{" view" if rid == "isAllowed" else ""} returns (uint256 first, uint256 extra) {{
        (args, first, extra);
{body}    }}
""" for rid, _, _, body, _ in rs)
    specs = "".join(f'        ids[{i}] = "{rid}"; fns[{i}] = "{fn_name(rid)}"; kinds[{i}] = {kind};\n'
                    for i, (rid, _, _, _, kind) in enumerate(rs))
    init = "".join(f"        {v} = FHE.asEuint64(uint64({salted(n)}));\n        FHE.allowThis({v});\n"
                   for v, n in zip("abcd", [3, 5, 7, 9]))
    src = f"""// SPDX-License-Identifier: BSD-3-Clause-Clear
// GENERATED by gen_probe.py — do not edit.
pragma solidity 0.8.27;

// forgefmt: disable-start
import {{FHE, ebool, euint8, euint64, externalEuint64}} from "@fhevm/solidity/lib/FHE.sol";
import {{ZamaEthereumConfig}} from "@fhevm/solidity/config/ZamaConfig.sol";

contract ZamaProbe is ZamaEthereumConfig {{
    euint64 internal a;
    euint64 internal b;
    euint64 internal c;
    euint64 internal d;
    euint8 internal sa;
    euint8 internal sb;
    ebool internal ea;
    ebool internal eb;

    /// Creates the operands, persistently allowed to this contract.
    function setup() external {{
{init}        // Casts of fresh euint64 values: an euint8 trivial handle has only 256 values and may be shared.
        sa = FHE.asEuint8(b);
        sb = FHE.asEuint8(d);
        // Conditions come from comparisons no row makes (rows put a or c first).
        ea = FHE.lt(b, d);
        eb = FHE.gt(d, b);
        FHE.allowThis(sa);
        FHE.allowThis(sb);
        FHE.allowThis(ea);
        FHE.allowThis(eb);
    }}

    function rowSpecs() external pure returns (string[] memory ids, string[] memory fns, uint8[] memory kinds) {{
        ids = new string[]({len(rs)});
        fns = new string[]({len(rs)});
        kinds = new uint8[]({len(rs)});
{specs}    }}
{fns}}}
// forgefmt: disable-end
"""
    Path("src/ZamaProbe.sol").write_text(src)
    meta = [{"id": rid, "category": cat, "likeForLike": like} for rid, cat, like, _, _ in rs]
    Path("results").mkdir(exist_ok=True)
    Path("results/zama-ops.json").write_text(json.dumps(meta, indent=1) + "\n")
    print(f"{len(rs)} rows")


if __name__ == "__main__":
    main()
