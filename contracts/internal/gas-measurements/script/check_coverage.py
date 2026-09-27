#!/usr/bin/env python3
"""Fail if a `library FHE` overload has no exact probe row and no documented skip.

Each overload (name + parameter types) maps to the row ids it needs in results/ops.json, so a
dropped type or a dropped row kind fails here. Run from contracts/internal/gas-measurements after
script/gen_probe.py.
"""
import json
import re
import sys
from pathlib import Path

ETYPES = ["ebool", "euint8", "euint16", "euint32", "euint64", "euint128", "eaddress"]
CAP = {t: t[0].upper() + t[1:] for t in ETYPES}
BY_CAP = {v: k for k, v in CAP.items()}
BATCH_SIZES = ["1", "2", "4", "8"]
SIMPLE = set("add sub mul div rem square min max eq ne lt lte gt gte and or xor not shl shr rol ror".split()) | \
    set("allow allowThis allowSender allowTransient allowGlobal allowPublic isAllowed isPubliclyAllowed".split())
DECRYPT = {"publishDecryptResult": "publishDecrypt", "verifyDecryptResult": "verifyDecrypt",
           "verifyDecryptResultSafe": "verifyDecryptSafe", "getDecryptResult": "getDecrypt",
           "getDecryptResultSafe": "getDecryptSafe"}
DECRYPT_BATCH = {"publishDecryptResultBatch": "publishDecryptBatch", "verifyDecryptResultBatch": "verifyDecryptBatch",
                 "verifyDecryptResultBatchSafe": "verifyDecryptBatchSafe"}


def expected(name, params):
    """Return (row ids, None) or (None, skip reason) for one overload. Raise if unknown."""
    p0 = params[0] if params else None
    if name in ("isInitialized", "unwrap") or name.startswith("wrap"):
        return None, "pure type conversion or check, no TaskManager call"
    if "int32" in params:
        return None, "security-zone variant: same TaskManager call as the zone-0 overload"
    if name in SIMPLE and p0 in ETYPES:
        return [f"{name}__{p0}"], None
    if name == "select":
        return [f"select__{params[1]}"], None
    base = name[2:] if name.startswith("as") else ""
    plural_base = base[:-2] if base.endswith("es") and base[:-2] in BY_CAP else base[:-1]
    if base in BY_CAP or plural_base in BY_CAP:
        plural = base not in BY_CAP
        dst = BY_CAP[plural_base if plural else base]
        if plural:
            if dst == "euint32" and p0 == "externalEuint32[]":
                return [f"inputBatch__{n}" for n in BATCH_SIZES], None
            return None, "batch input: same batchVerifyInputs path as asEuint32s(externalEuint32[], bytes)"
        if p0 in ETYPES:
            return [f"cast__{p0}__{dst}"], None
        if p0 == f"external{CAP[dst]}":
            return [f"input__{dst}"], None
        if p0 == "bytes":
            return [f"inputBytes__{dst}"], None
        if p0 in ("uint256", "bool", "address"):
            return [f"trivial__{dst}"], None
    m = re.fullmatch(r"random(\w+)", name)
    if m and not params:
        return [f"random__{BY_CAP[m.group(1)]}"], None
    m = re.fullmatch(r"(share|receive)(\w+?)(Param|FromCall)?", name)
    if m and m.group(2) in BY_CAP:
        t = BY_CAP[m.group(2)]
        return [f"{'share' if m.group(1) == 'share' else 'receive' + m.group(3)}__{t}"], None
    if name in DECRYPT:
        if p0 in ETYPES:
            return [f"{DECRYPT[name]}__{p0}"], None
        if p0 in ("bytes32", "uint256"):
            return None, "raw-handle overload: same TaskManager call as the typed overload"
    if name in DECRYPT_BATCH:
        if p0 == "euint32[]":
            return [f"{DECRYPT_BATCH[name]}__{n}" for n in BATCH_SIZES], None
        return None, "batch decrypt: same TaskManager loop as the euint32 batch"
    raise ValueError(f"no mapping for {name}({', '.join(params)})")


def fhe_overloads(source):
    start = source.index("library FHE {")
    body = source[start:source.index("\nlibrary ", start + 1)]
    for name, args in re.findall(r"function (\w+)\(([^)]*)\)", body):
        params = [a.split()[0] for a in args.split(",") if a.strip()]
        yield name, params


def main():
    ids = {r["id"] for r in json.loads(Path("results/ops.json").read_text())}
    errors, skipped, checked = [], 0, 0
    for name, params in fhe_overloads(Path("../../FHE.sol").read_text()):
        sig = f"{name}({', '.join(params)})"
        try:
            rows, _ = expected(name, params)
        except ValueError as e:
            errors.append(str(e))
            continue
        if rows is None:
            skipped += 1
            continue
        checked += 1
        missing = [r for r in rows if r not in ids]
        if missing:
            errors.append(f"{sig}: missing rows {missing}")
    for e in errors:
        print("MISSING", e)
    print(f"{checked} overloads measured, {skipped} skipped with a reason, {len(errors)} missing")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
