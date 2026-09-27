#!/usr/bin/env python3
"""Fail if a public `library FHE` function has no probe row and no documented skip.

Run from contracts/internal/gas-measurements after script/gen_probe.py.
"""
import json
import re
import sys
from pathlib import Path

# FHE.sol name -> probe op name(s) in results/ops.json.
COVERED = {
    **{n: [n] for n in "add sub mul div rem square min max eq ne lt lte gt gte and or xor not shl shr rol ror select".split()},
    **{f"as{t}": ["trivial", "input", "cast"] for t in ["Ebool", "Euint8", "Euint16", "Euint32", "Euint64", "Euint128"]},
    "asEaddress": ["trivial", "input"],
    "asEuint32s": ["inputBatch"],
    **{f"randomEuint{b}": ["random"] for b in [8, 16, 32, 64, 128]},
    **{n: [n] for n in "allow allowThis allowSender allowTransient allowGlobal allowPublic isAllowed isPubliclyAllowed".split()},
    **{f"share{t}": ["share"] for t in ["Ebool", "Euint8", "Euint16", "Euint32", "Euint64", "Euint128", "Eaddress"]},
    **{f"receive{t}Param": ["receiveParam"] for t in ["Ebool", "Euint8", "Euint16", "Euint32", "Euint64", "Euint128", "Eaddress"]},
    **{f"receive{t}FromCall": ["receiveFromCall"] for t in ["Ebool", "Euint8", "Euint16", "Euint32", "Euint64", "Euint128", "Eaddress"]},
    "publishDecryptResult": ["publishDecrypt"],
    "verifyDecryptResult": ["verifyDecrypt"],
    "verifyDecryptResultSafe": ["verifyDecryptSafe"],
    "getDecryptResult": ["getDecrypt"],
    "getDecryptResultSafe": ["getDecryptSafe"],
    "publishDecryptResultBatch": ["publishDecryptBatch"],
    "verifyDecryptResultBatch": ["verifyDecryptBatch"],
    "verifyDecryptResultBatchSafe": ["verifyDecryptBatchSafe"],
}
SKIP = {
    "isInitialized": "pure handle != 0 check, no TaskManager call",
    "unwrap": "type conversion, no TaskManager call",
    # Same TaskManager call as asEuint32s; one batch type is measured.
    **{f"as{t}s": "same batchVerifyInputs path as asEuint32s"
       for t in ["Ebool", "Euint8", "Euint16", "Euint64", "Euint128"]},
    "asEaddresses": "same batchVerifyInputs path as asEuint32s",
    **{f"wrap{t}": "pure type conversion, no TaskManager call"
       for t in ["Ebool", "Euint8", "Euint16", "Euint32", "Euint64", "Euint128", "Eaddress"]},
}


def fhe_library_functions(source):
    start = source.index("library FHE {")
    end = source.index("\nlibrary ", start + 1)
    return set(re.findall(r"function (\w+)\(", source[start:end]))


def main():
    ops = {r["op"] for r in json.loads(Path("results/ops.json").read_text())}
    names = fhe_library_functions(Path("../../FHE.sol").read_text())
    errors = []
    for name in sorted(names):
        if name in SKIP:
            continue
        if name not in COVERED:
            errors.append(f"{name}: not in COVERED or SKIP")
        elif not any(op in ops for op in COVERED[name]):
            errors.append(f"{name}: no probe row for {COVERED[name]}")
    for e in errors:
        print("MISSING", e)
    print(f"{len(names)} FHE functions, {len(errors)} missing")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
