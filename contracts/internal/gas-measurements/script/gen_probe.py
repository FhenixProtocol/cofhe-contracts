#!/usr/bin/env python3
"""Generate src/GasProbe.sol and results/ops.json from one op table.

Every probe row is `function <id>(bytes calldata args) external returns (uint256 first, uint256 extra)`:
  first = gas of the FHE call when it is the first FHE call of the transaction,
  extra = gas of the same call again in that transaction, on a different operand.
Operands load into locals before `gasleft()`, so only the FHE call is measured.
Run from contracts/internal/gas-measurements.
"""
import hashlib
import json
from pathlib import Path

U = ["euint8", "euint16", "euint32", "euint64", "euint128"]
ALL = ["ebool"] + U + ["eaddress"]
BOOLU = ["ebool"] + U
BATCH_SIZES = [1, 2, 4, 8]

UTYPE = {"ebool": 0, "euint8": 2, "euint16": 3, "euint32": 4, "euint64": 5, "euint128": 6, "eaddress": 7}
CAP = {t: t[0].upper() + t[1:] for t in ALL}  # euint8 -> Euint8
PLAIN = {"ebool": "bool", "euint8": "uint8", "euint16": "uint16", "euint32": "uint32",
         "euint64": "uint64", "euint128": "uint128", "eaddress": "address"}
# Decrypt results are all 1, so one signature over uint256(1) fits every type.
ONE = {t: ("true" if t == "ebool" else "address(1)" if t == "eaddress" else f"{PLAIN[t]}(1)") for t in ALL}

# Test-side arg kinds (see test/MeasureGas.t.sol).
K_NONE, K_INPUT, K_DECRYPT, K_INPUT_BATCH, K_DECRYPT_BATCH = 0, 1, 2, 3, 4

ALICE = "address(0xA11CE)"
VIEW_OPS = {"isAllowed", "isPubliclyAllowed", "verifyDecrypt", "verifyDecryptSafe", "getDecrypt", "getDecryptSafe",
            "verifyDecryptBatch", "verifyDecryptBatchSafe"}


BITS = {"euint8": 8, "euint16": 16, "euint32": 32, "euint64": 64, "euint128": 128, "eaddress": 160}


def salted(t, n):
    # Handles are global and derive only from their inputs, so a common plaintext (3, true) can hit
    # a handle someone already allowed on chain, which makes ACL calls cheaper. Salted plaintexts
    # keep every operand handle fresh.
    return int.from_bytes(hashlib.sha256(f"pro-575:{t}:{n}".encode()).digest(), "big") % (1 << BITS[t])


def trivial(t, n):
    if t == "ebool":
        # Only two ebool trivial handles exist; the table notes that their ACL state is shared.
        return f"FHE.asEbool({'true' if n % 2 else 'false'})"
    if t == "eaddress":
        return f"FHE.asEaddress(address(uint160({salted(t, n)})))"
    return f"FHE.as{CAP[t]}(uint256({hex(salted(t, n))}))"


def measured(t, call1, call2, pre=""):
    return f"""        {t} x = a_{t};
        {t} y = b_{t};
        {t} z = c_{t};
        {t} w = d_{t};
{pre}        uint256 g = gasleft();
        {call1};
        first = g - gasleft();
        g = gasleft();
        {call2};
        extra = g - gasleft();
        (x, y, z, w);
"""


def single(pre, call):
    return f"""{pre}        uint256 g = gasleft();
        {call};
        first = g - gasleft();
"""


class Row:
    def __init__(self, category, op, typ, body, kind=K_NONE, utype=0, size=0, fid=None):
        self.category, self.op, self.type, self.body = category, op, typ, body
        self.kind, self.utype, self.size = kind, utype, size
        self.id = fid or f"{op}__{typ}"


def rows():
    out = []
    for op in ["add", "sub", "mul", "div", "rem", "min", "max"]:
        for t in U:
            out.append(Row("Arithmetic", op, t, measured(t, f"FHE.{op}(x, y)", f"FHE.{op}(x, z)")))
    for t in U:
        out.append(Row("Arithmetic", "square", t, measured(t, "FHE.square(x)", "FHE.square(z)")))
    for op in ["eq", "ne"]:
        for t in ALL:
            out.append(Row("Comparison", op, t, measured(t, f"FHE.{op}(x, y)", f"FHE.{op}(x, z)")))
    for op in ["lt", "lte", "gt", "gte"]:
        for t in U:
            out.append(Row("Comparison", op, t, measured(t, f"FHE.{op}(x, y)", f"FHE.{op}(x, z)")))
    for op in ["and", "or", "xor"]:
        for t in BOOLU:
            out.append(Row("Bitwise", op, t, measured(t, f"FHE.{op}(x, y)", f"FHE.{op}(x, z)")))
    for t in BOOLU:
        out.append(Row("Bitwise", "not", t, measured(t, "FHE.not(x)", "FHE.not(z)")))
    for op in ["shl", "shr", "rol", "ror"]:
        for t in U:
            out.append(Row("Bitwise", op, t, measured(t, f"FHE.{op}(x, y)", f"FHE.{op}(x, z)")))
    # cond is d_ebool: with a_ebool the ebool row would pass one handle twice and get a warm ACL read.
    for t in ALL:
        out.append(Row("Select", "select", t, measured(
            t, "FHE.select(cond, x, y)", "FHE.select(cond, x, z)", pre="        ebool cond = d_ebool;\n")))

    for t in ALL:
        out.append(Row("Encrypt", "trivial", t, measured(t, trivial(t, 11), trivial(t, 12))))
    for t in ALL:
        pre = "        (bytes32 h1, bytes memory p1, bytes32 h2, bytes memory p2) = abi.decode(args, (bytes32, bytes, bytes32, bytes));\n"
        ext = "external" + CAP[t]
        out.append(Row("Encrypt", "input", t, measured(
            t, f"FHE.as{CAP[t]}({ext}.wrap(h1), p1)", f"FHE.as{CAP[t]}({ext}.wrap(h2), p2)", pre=pre),
            kind=K_INPUT, utype=UTYPE[t]))
    for t in U:
        out.append(Row("Encrypt", "random", t, measured(t, f"FHE.random{CAP[t]}()", f"FHE.random{CAP[t]}()")))
    for n in BATCH_SIZES:
        pre = ("        (bytes32[] memory hs, bytes memory sig) = abi.decode(args, (bytes32[], bytes));\n"
               "        externalEuint32[] memory values;\n"
               "        assembly (\"memory-safe\") {\n            values := hs\n        }\n")
        out.append(Row("BatchInput", "inputBatch", str(n), single(pre, "FHE.asEuint32s(values, sig)"),
                       kind=K_INPUT_BATCH, utype=UTYPE["euint32"], size=n))

    for src in ALL:
        for dst in ALL:
            if src == dst or dst == "eaddress":  # FHE.sol has no cast to eaddress
                continue
            out.append(Row("Cast", "cast", f"{src}__{dst}",
                           measured(src, f"FHE.as{CAP[dst]}(x)", f"FHE.as{CAP[dst]}(z)")))

    # Sharing runs before Access: allowGlobal on an operand would short-circuit later ACL checks.
    for t in ALL:
        c = CAP[t]
        out.append(Row("Sharing", "share", t, measured(
            t, f"FHE.share{c}(x, address(receiver))", f"FHE.share{c}(z, address(receiver))")))
        out.append(Row("Sharing", "receiveParam", t, f"""        shared{c} s1 = FHE.share{c}(a_{t}, address(receiver));
        first = receiver.takeParam__{t}(s1);
        shared{c} s2 = FHE.share{c}(c_{t}, address(receiver));
        extra = receiver.takeParam__{t}(s2);
"""))
        out.append(Row("Sharing", "receiveFromCall", t, f"""        first = receiver.pull__{t}(false);
        extra = receiver.pull__{t}(true);
"""))

    for t in ALL:
        out.append(Row("Access", "allow", t, measured(t, f"FHE.allow(x, {ALICE})", f"FHE.allow(z, {ALICE})")))
        # A fresh result handle, allowed only transiently, is what allowThis meets in real use.
        if t == "ebool":
            f1, f2 = "FHE.not(x)", "FHE.not(z)"
        elif t == "eaddress":
            f1, f2 = trivial(t, 101), trivial(t, 103)
        else:
            f1, f2 = "FHE.add(x, y)", "FHE.add(x, z)"
        fresh = f"        {t} f1 = {f1};\n        {t} f2 = {f2};\n"
        out.append(Row("Access", "allowThis", t, measured(t, "FHE.allowThis(f1)", "FHE.allowThis(f2)", pre=fresh)))
        out.append(Row("Access", "allowSender", t, measured(t, "FHE.allowSender(x)", "FHE.allowSender(z)")))
        out.append(Row("Access", "allowTransient", t, measured(
            t, f"FHE.allowTransient(x, {ALICE})", f"FHE.allowTransient(z, {ALICE})")))
        # allowGlobal and allowPublic write the same slot, so each gets its own operands.
        out.append(Row("Access", "allowGlobal", t, measured(t, "FHE.allowGlobal(x)", "FHE.allowGlobal(y)")))
        out.append(Row("Access", "allowPublic", t, measured(t, "FHE.allowPublic(z)", "FHE.allowPublic(w)")))
        out.append(Row("Access", "isAllowed", t, measured(
            t, f"FHE.isAllowed(x, {ALICE})", f"FHE.isAllowed(z, {ALICE})")))
        out.append(Row("Access", "isPubliclyAllowed", t, measured(t, "FHE.isPubliclyAllowed(x)", "FHE.isPubliclyAllowed(z)")))

    dec_pre = "        (bytes32 h1, bytes memory s1, bytes32 h2, bytes memory s2) = abi.decode(args, (bytes32, bytes, bytes32, bytes));\n"
    for t in ALL:
        one = ONE[t]
        for op, fn in [("publishDecrypt", "publishDecryptResult"), ("verifyDecrypt", "verifyDecryptResult"),
                       ("verifyDecryptSafe", "verifyDecryptResultSafe")]:
            out.append(Row("Decrypt", op, t, measured(
                t, f"FHE.{fn}({t}.wrap(h1), {one}, s1)", f"FHE.{fn}({t}.wrap(h2), {one}, s2)", pre=dec_pre),
                kind=K_DECRYPT, utype=UTYPE[t]))
        # Reads the results that the publishDecrypt row of the same type stored.
        get_pre = "        (bytes32 h1,, bytes32 h2,) = abi.decode(args, (bytes32, bytes, bytes32, bytes));\n"
        for op, fn in [("getDecrypt", "getDecryptResult"), ("getDecryptSafe", "getDecryptResultSafe")]:
            out.append(Row("Decrypt", op, t, measured(
                t, f"FHE.{fn}({t}.wrap(h1))", f"FHE.{fn}({t}.wrap(h2))", pre=get_pre),
                kind=K_DECRYPT, utype=UTYPE[t]))
    for n in BATCH_SIZES:
        pre = (f"        (bytes32[] memory hs, bytes[] memory sigs) = abi.decode(args, (bytes32[], bytes[]));\n"
               f"        euint32[] memory inputs;\n"
               f"        assembly (\"memory-safe\") {{\n            inputs := hs\n        }}\n"
               f"        uint32[] memory results = new uint32[](hs.length);\n"
               f"        for (uint256 i = 0; i < hs.length; i++) results[i] = 1;\n")
        for op, fn in [("publishDecryptBatch", "publishDecryptResultBatch"),
                       ("verifyDecryptBatch", "verifyDecryptResultBatch"),
                       ("verifyDecryptBatchSafe", "verifyDecryptResultBatchSafe")]:
            out.append(Row("BatchDecrypt", op, str(n), single(pre, f"FHE.{fn}(inputs, results, sigs)"),
                           kind=K_DECRYPT_BATCH, utype=UTYPE["euint32"], size=n))
    return out


HEADER = """// SPDX-License-Identifier: BSD-3-Clause-Clear
// GENERATED by script/gen_probe.py — do not edit.
pragma solidity 0.8.25;

// forgefmt: disable-start
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
"""


def base_contract():
    decl = "".join(f"    {t} internal {v}_{t};\n" for t in ALL for v in "abcd")
    # Only euint128 and eaddress are trivially encrypted from salted plaintexts: their handle space
    # is too large to collide. The other operands derive from them through calls no probe row makes
    # (rows cast v_euint128 itself and always put `a` first), so no row recreates an operand handle.
    init = ["euint128 n;"]
    for v, n in zip("abcd", [3, 5, 7, 9]):
        init.append(f"{v}_euint128 = {trivial('euint128', n)};")
        init.append(f"{v}_eaddress = {trivial('eaddress', n)};")
        init.append(f"n = FHE.not({v}_euint128);")
        for t in ["euint8", "euint16", "euint32", "euint64"]:
            init.append(f"{v}_{t} = FHE.as{CAP[t]}(n);")
    init += ["a_ebool = FHE.lt(b_euint64, d_euint64);", "b_ebool = FHE.gt(b_euint64, d_euint64);",
             "c_ebool = FHE.lte(b_euint64, d_euint64);", "d_ebool = FHE.gte(b_euint64, d_euint64);"]
    init += [f"FHE.allowThis({v}_{t});" for t in ALL for v in "abcd"]
    body = "".join(f"        {s}\n" for s in init)
    return f"""
abstract contract ProbeBase {{
{decl}    GasProbeReceiver internal receiver;

    constructor() {{
        receiver = new GasProbeReceiver();
    }}

    /// Creates four operands per type, persistently allowed to this contract.
    function setup() external {{
{body}    }}

"""


def give_functions():
    out = ""
    for t in ALL:
        c = CAP[t]
        out += f"""
    function give__{t}(bool second) external returns (shared{c}) {{
        return FHE.share{c}(second ? c_{t} : a_{t}, msg.sender);
    }}
"""
    return out + "}\n"


def receiver_contract():
    out = "\ninterface IGiver {\n"
    for t in ALL:
        out += f"    function give__{t}(bool second) external returns (shared{CAP[t]});\n"
    out += "}\n\n/// Receives shares from ProbeBase and measures the receive call.\ncontract GasProbeReceiver {\n"
    for t in ALL:
        c = CAP[t]
        out += f"""    function takeParam__{t}(shared{c} s) external returns (uint256 used) {{
        uint256 g = gasleft();
        FHE.receive{c}Param(s);
        used = g - gasleft();
    }}

    function pull__{t}(bool second) external returns (uint256 used) {{
        shared{c} s = IGiver(msg.sender).give__{t}(second);
        uint256 g = gasleft();
        FHE.receive{c}FromCall(s, msg.sender);
        used = g - gasleft();
    }}

"""
    return out.rstrip() + "\n}\n"


def probe_contract(category, rs):
    fns = "".join(f"""
    function {r.id}(bytes calldata args) external{" view" if r.op in VIEW_OPS else ""} returns (uint256 first, uint256 extra) {{
        (args, first, extra);
{r.body}    }}
""" for r in rs)
    specs = "".join(
        f"        ids[{i}] = \"{r.id}\"; kinds[{i}] = {r.kind}; utypes[{i}] = {r.utype}; sizes[{i}] = {r.size};\n"
        for i, r in enumerate(rs))
    n = len(rs)
    return f"""
contract Probe{category} is ProbeBase {{
    function rowSpecs()
        external
        pure
        returns (string[] memory ids, uint8[] memory kinds, uint8[] memory utypes, uint8[] memory sizes)
    {{
        ids = new string[]({n});
        kinds = new uint8[]({n});
        utypes = new uint8[]({n});
        sizes = new uint8[]({n});
{specs}    }}
{fns}}}
"""


def main():
    all_rows = rows()
    categories = list(dict.fromkeys(r.category for r in all_rows))
    src = HEADER + base_contract() + give_functions() + receiver_contract()
    for c in categories:
        src += probe_contract(c, [r for r in all_rows if r.category == c])
    names = "".join(f"        list[{i}] = \"Probe{c}\";\n" for i, c in enumerate(categories))
    src += f"""
library ProbeList {{
    function names() internal pure returns (string[] memory list) {{
        list = new string[]({len(categories)});
{names}    }}
}}
// forgefmt: disable-end
"""
    Path("src/GasProbe.sol").write_text(src)
    ops = [{"id": r.id, "category": r.category, "op": r.op, "type": r.type, "contract": f"Probe{r.category}"}
           for r in all_rows]
    Path("results").mkdir(exist_ok=True)
    Path("results/ops.json").write_text(json.dumps(ops, indent=1) + "\n")
    print(f"{len(all_rows)} rows in {len(categories)} probe contracts")


if __name__ == "__main__":
    main()
