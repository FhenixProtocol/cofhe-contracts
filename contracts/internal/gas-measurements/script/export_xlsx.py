#!/usr/bin/env python3
"""Write results/gas-measurements.xlsx (for Google Sheets) from the same data and checks as render.py.

Needs openpyxl. Run from contracts/internal/gas-measurements after render.py passes.
"""
import json
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

import render

HEADER_FONT = Font(bold=True, color="FFFFFF")
HEADER_FILL = PatternFill("solid", fgColor="1F3864")
SECTION_FONT = Font(bold=True, size=12)
GAS = "#,##0"


def header(ws, row, names):
    for col, name in enumerate(names, 1):
        c = ws.cell(row=row, column=col, value=name)
        c.font, c.fill = HEADER_FONT, HEADER_FILL
        c.alignment = Alignment(wrap_text=True, vertical="center")


def widths(ws, values):
    for col, w in enumerate(values, 1):
        ws.column_dimensions[get_column_letter(col)].width = w


def rounded(gas):
    return int(round(gas / 100.0)) * 100


def per_op_sheet(wb, rows, ops):
    ws = wb.active
    ws.title = "Gas per op"
    header(ws, 1, ["Category", "Operation", "first (gas)", "extra (gas)", "Types", "Type spread (gas)"])
    grouped = render.groups(ops)
    r = 2
    for title, entries in render.TABLES:
        for key, label, types in entries:
            ids = grouped[key]
            values = [title, label.replace("`", ""), rounded(max(rows[i]["first"] for i in ids)),
                      rounded(max(rows[i]["extra"] for i in ids)), types, render.spread(rows, ids, "first")]
            for col, v in enumerate(values, 1):
                c = ws.cell(row=r, column=col, value=v)
                if col in (3, 4, 6):
                    c.number_format = GAS
            r += 1
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = f"A1:F{r - 1}"
    widths(ws, [30, 48, 13, 13, 34, 17])


def fherc20_sheet(wb, fherc20):
    ws = wb.create_sheet("FHERC20 transfer", 0)
    commit = fherc20["sepolia"]["fherc20Commit"][:7]
    ws.cell(row=1, column=1, value=f"FHERC20 reference implementation (fhenix-confidential-contracts @ {commit}), "
                                   "whole transaction gas: 21,000 base + calldata + execution").font = SECTION_FONT
    header(ws, 2, ["Action", "Gas (full transaction)"])
    rows = fherc20["sepolia"]["rows"]
    for r, (rid, label) in enumerate(render.FHERC20_ROWS, 3):
        ws.cell(row=r, column=1, value=label.replace("`", ""))
        ws.cell(row=r, column=2, value=rounded(rows[rid])).number_format = GAS
    ws.cell(row=len(render.FHERC20_ROWS) + 4, column=1,
            value="On Arbitrum, add the L1 data fee for the calldata. Same values on both chains.")
    widths(ws, [70, 22])


def batch_sheet(wb, rows):
    ws = wb.create_sheet("Batches")
    ws.cell(row=1, column=1, value="Batch encrypted inputs (FHE.asEuint32s, one signature)").font = SECTION_FONT
    header(ws, 2, ["Inputs in batch"] + [int(n) for n in render.BATCH_SIZES])
    for i, (label, div) in enumerate([("Total gas", False), ("Gas per input", True)], 3):
        ws.cell(row=i, column=1, value=label)
        for col, n in enumerate(render.BATCH_SIZES, 2):
            gas = rows[f"inputBatch__{n}"]["first"] / (int(n) if div else 1)
            ws.cell(row=i, column=col, value=rounded(gas)).number_format = GAS
    ws.cell(row=6, column=1, value="Batch decryption results (euint32), total gas").font = SECTION_FONT
    header(ws, 7, ["Results in batch"] + [int(n) for n in render.BATCH_SIZES])
    for i, (op, fn) in enumerate([("publishDecryptBatch", "publishDecryptResultBatch"),
                                  ("verifyDecryptBatch", "verifyDecryptResultBatch"),
                                  ("verifyDecryptBatchSafe", "verifyDecryptResultBatchSafe")], 8):
        ws.cell(row=i, column=1, value=fn)
        for col, n in enumerate(render.BATCH_SIZES, 2):
            ws.cell(row=i, column=col, value=rounded(rows[f"{op}__{n}"]["first"])).number_format = GAS
    widths(ws, [34, 12, 12, 12, 12])


def raw_sheet(wb, chains, ops):
    ws = wb.create_sheet("Per type (raw)")
    header(ws, 1, ["Category", "Operation", "Type", "Sepolia first", "Sepolia extra",
                   "Arb Sepolia first", "Arb Sepolia extra"])
    s, a = chains["sepolia"]["rows"], chains["arbitrum-sepolia"]["rows"]
    for r, o in enumerate(ops, 2):
        values = [o["category"], o["op"], o["type"].replace("__", " → "),
                  s[o["id"]]["first"], s[o["id"]]["extra"], a[o["id"]]["first"], a[o["id"]]["extra"]]
        for col, v in enumerate(values, 1):
            c = ws.cell(row=r, column=col, value=v)
            if col >= 4:
                c.number_format = GAS
    ws.freeze_panes = "D2"
    ws.auto_filter.ref = f"A1:G{len(ops) + 1}"
    widths(ws, [14, 24, 22, 14, 14, 17, 17])


def setup_sheet(wb, chains, deployed, exact, total):
    ws = wb.create_sheet("Setup")
    lines = [line.strip("|").split("|") for line in render.setup_table(chains, deployed).splitlines()]
    lines = [lines[0]] + lines[2:]  # drop the markdown separator row
    header(ws, 1, [c.strip() for c in lines[0]])
    for r, line in enumerate(lines[1:], 2):
        for col, v in enumerate(line, 1):
            ws.cell(row=r, column=col, value=v.strip().replace("`", "")).alignment = Alignment(wrap_text=True)
    r = len(lines) + 2
    ws.cell(row=r, column=1, value=f"Both chains run the same code; Arbitrum Sepolia: {exact} of {total} rows "
                                   "equal Sepolia to the gas unit, the rest differ by less than the rounding.")
    widths(ws, [44, 50, 50])


def notes_sheet(wb):
    ws = wb.create_sheet("Notes")
    notes = [
        "first: gas of the FHE call when it is the first FHE call in the transaction (cold TaskManager and ACL).",
        "extra: gas of the same op again in the same transaction, on operands the first call did not use "
        "(warm TaskManager, cold operand ACL entries).",
        "Gas per op: the highest value across the listed types, rounded to the nearest 100 gas. "
        "Type spread = highest − lowest raw first across those types.",
        "Arbitrum: the numbers are L2 execution gas. Arbitrum also charges an L1 data fee for the calldata of the "
        "user's transaction; encrypted inputs add calldata, FHE ops inside a contract do not.",
        "",
    ] + render.FOOTNOTES.strip().splitlines()
    for r, text in enumerate(notes, 1):
        ws.cell(row=r, column=1, value=text).alignment = Alignment(wrap_text=True)
    widths(ws, [140])


def main():
    ops = json.loads(Path("results/ops.json").read_text())
    chains = {key: json.loads(Path(f"results/{key}.json").read_text()) for key, _ in render.CHAINS}
    deployed = json.loads(Path("results/deployed.json").read_text())
    render.check_consistency(chains, deployed)
    exact, total = render.check_chains_match(chains)
    rows = chains["sepolia"]["rows"]
    render.check_type_spread(rows, ops)
    fherc20 = {key: json.loads(Path(f"results/fherc20-{key}.json").read_text()) for key, _ in render.CHAINS}
    render.check_fherc20(fherc20, deployed)

    wb = Workbook()
    per_op_sheet(wb, rows, ops)
    batch_sheet(wb, rows)
    fherc20_sheet(wb, fherc20)
    raw_sheet(wb, chains, ops)
    setup_sheet(wb, chains, deployed, exact, total)
    notes_sheet(wb)
    wb.save("results/gas-measurements.xlsx")
    print("wrote results/gas-measurements.xlsx")


if __name__ == "__main__":
    main()
