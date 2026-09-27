#!/usr/bin/env python3
"""Fail if a probe row's "extra" call reuses an operand of its "first" call.

A reused operand has a warm ACL slot, so "extra" would read as cheaper than a real second op on
stored operands. Run from contracts/internal/gas-measurements after script/gen_probe.py.
"""
import re
import sys
from pathlib import Path

ROW = re.compile(r"function (\w+__\w+)\(bytes calldata args\)[^{]*\{(.*?)\n    \}", re.S)
MEASURED = re.compile(r"uint256 g = gasleft\(\);\n\s*(.+?);\n\s*first = g - gasleft\(\);\n\s*g = gasleft\(\);\n\s*(.+?);\n", re.S)
IDENT = re.compile(r"\b\w+\b")
# Locals the generator loads operands into (see script/gen_probe.py).
LOCALS = {"x", "y", "z", "w", "cond", "cond2", "f1", "f2", "h1", "h2", "p1", "p2", "s1", "s2"}


def operands(call):
    return set(IDENT.findall(call)) & LOCALS


def main():
    src = Path("src/GasProbe.sol").read_text()
    errors = []
    for rid, body in ROW.findall(src):
        m = MEASURED.search(body)
        if not m:
            continue  # batch and receive rows make one call per measurement
        shared = operands(m.group(1)) & operands(m.group(2))
        if shared:
            errors.append(f"{rid}: extra reuses {sorted(shared)}")
    for e in errors:
        print("SHARED", e)
    print(f"{len(errors)} rows reuse an operand")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
