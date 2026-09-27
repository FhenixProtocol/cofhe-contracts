#!/usr/bin/env python3
"""Render results/*.json into the markdown gas tables (results/gas-tables.md).

Run from contracts/internal/gas-measurements after check_deployed.py and `forge test`.
"""
import json
import statistics
from pathlib import Path

U = ["euint8", "euint16", "euint32", "euint64", "euint128"]
ALL = ["ebool"] + U + ["eaddress"]
BOOLU = ["ebool"] + U
BATCH_SIZES = ["1", "2", "4", "8"]
CHAINS = [("sepolia", "Ethereum Sepolia"), ("arbitrum-sepolia", "Arbitrum Sepolia")]
FLAT_SPREAD = 200  # gas; below this a category counts as flat across types

TABLES = [
    ("Arithmetic", U, [("add", "`add`"), ("sub", "`sub`"), ("mul", "`mul`"), ("div", "`div`"), ("rem", "`rem`"),
                       ("square", "`square`"), ("min", "`min`"), ("max", "`max`")]),
    ("Comparison", ALL, [("eq", "`eq`"), ("ne", "`ne`"), ("lt", "`lt`"), ("lte", "`lte`"), ("gt", "`gt`"),
                         ("gte", "`gte`")]),
    ("Bitwise and shift", BOOLU, [("and", "`and`"), ("or", "`or`"), ("xor", "`xor`"), ("not", "`not`"),
                                  ("shl", "`shl`"), ("shr", "`shr`"), ("rol", "`rol`"), ("ror", "`ror`")]),
    ("Select", ALL, [("select", "`select`")]),
    ("Encrypt (create a ciphertext)", ALL, [
        ("trivial", "Trivial encrypt `FHE.asEuintX(plaintext)` ¹"),
        ("input", "Encrypted input `FHE.asEuintX(InEuintX)`"),
        ("inputBytes", "Encrypted input, ABI-encoded `FHE.asEuintX(bytes)`"),
        ("random", "Random `FHE.randomEuintX()`")]),
    ("Access control", ALL, [
        ("allow", "`allow`"), ("allowThis", "`allowThis` ²"), ("allowSender", "`allowSender`"),
        ("allowTransient", "`allowTransient`"), ("allowGlobal", "`allowGlobal`"), ("allowPublic", "`allowPublic`"),
        ("isAllowed", "`isAllowed` (view) ⁵"), ("isPubliclyAllowed", "`isPubliclyAllowed` (view)")]),
    ("Sharing", ALL, [("share", "`shareX`"), ("receiveParam", "`receiveXParam` ³"),
                      ("receiveFromCall", "`receiveXFromCall` ³")]),
    ("Decryption results", ALL, [
        ("publishDecrypt", "`publishDecryptResult` ⁴"), ("verifyDecrypt", "`verifyDecryptResult` (view)"),
        ("verifyDecryptSafe", "`verifyDecryptResultSafe` (view)"), ("getDecrypt", "`getDecryptResult` (view)"),
        ("getDecryptSafe", "`getDecryptResultSafe` (view)")]),
]
# Summary category -> probe ops (from results/ops.json) it covers.
SUMMARY = [
    ("Arithmetic", "Arithmetic"), ("Comparison", "Comparison"), ("Bitwise and shift", "Bitwise"),
    ("Select", "Select"), ("Encrypt", "Encrypt"), ("Cast", "Cast"), ("Access control", "Access"),
    ("Sharing", "Sharing"), ("Decryption results", "Decrypt"),
]

FOOTNOTES = """¹ Trivial `ebool` has only two handles (`true`, `false`), shared by every contract on the chain. Their ACL state differs per chain, so these cells can differ by a few gas between chains. The same holds for the cast-to-`ebool` column, which uses the shared trivial-0 handle.
² `allowThis` is measured on a result handle created earlier in the same transaction (the normal pattern: compute, then `allowThis`). The TaskManager is already warm, so `first` and `extra` are close.
³ A receive always follows a share in the same transaction, so the TaskManager is already warm; `first` and `extra` are close.
⁴ Measured with a non-zero result. A zero result (for example `false` or an amount of 0) leaves one storage slot at zero, so it costs less.
⁵ Measured on a handle already allowed to the account, which returns early. A "not allowed" answer reads more storage, so it costs more.
"""


def r100(gas):
    return f"{int(round(gas / 100.0)) * 100:,}"


def cell(rows, rid):
    r = rows.get(rid)
    return "—" if r is None else f"{r100(r['first'])} / {r100(r['extra'])}"


def table(header, lines):
    out = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    out += ["| " + " | ".join(line) + " |" for line in lines]
    return "\n".join(out) + "\n"


def chain_tables(rows):
    out = []
    for title, types, ops in TABLES:
        cols = ALL if len(types) == 7 else (BOOLU if types == BOOLU else U)
        lines = [[label] + [cell(rows, f"{op}__{t}") for t in cols] for op, label in ops]
        out.append(f"### {title}\n\n" + table(["Operation"] + cols, lines))

    lines = [["Total gas"] + [r100(rows[f"inputBatch__{n}"]["first"]) for n in BATCH_SIZES],
             ["Gas per input"] + [r100(rows[f"inputBatch__{n}"]["first"] / int(n)) for n in BATCH_SIZES]]
    out.append("### Batch encrypted inputs (`FHE.asEuint32s`, one signature)\n\n"
               + table(["Inputs in batch"] + BATCH_SIZES, lines))

    lines = [[f"`{src}`"] + ["—" if src == dst or dst == "eaddress" else cell(rows, f"cast__{src}__{dst}")
                             for dst in ALL] for src in ALL]
    out.append("### Cast (`FHE.asX(eY)`) — row = from, column = to\n\n"
               "FHE.sol has no cast to `eaddress`. A cast to `ebool` is `ne(value, asEuintX(0))`: two TaskManager "
               "tasks, so it costs about 30k more than other casts.\n\n" + table(["from \\ to"] + ALL, lines))

    lines = [[f"`{fn}` total"] + [r100(rows[f"{op}__{n}"]["first"]) for n in BATCH_SIZES]
             for op, fn in [("publishDecryptBatch", "publishDecryptResultBatch"),
                            ("verifyDecryptBatch", "verifyDecryptResultBatch"),
                            ("verifyDecryptBatchSafe", "verifyDecryptResultBatchSafe")]]
    out.append("### Batch decryption results (euint32)\n\n" + table(["Results in batch"] + BATCH_SIZES, lines))
    return "\n".join(out)


def setup_table(chains, deployed):
    s, a = chains["sepolia"], chains["arbitrum-sepolia"]
    ds, da = deployed["chains"]["sepolia"], deployed["chains"]["arbitrumSepolia"]
    # check_consistency() has already required a bytecode match for every row below.
    version = f"cofhe-contracts {deployed['packageVersion']} (sources at `{deployed['sourceCommit'][:7]}`)"

    lines = [
        ["Chain ID", str(s["chainId"]), str(a["chainId"])],
        ["Fork block", f"{s['forkBlock']:,}", f"{a['forkBlock']:,}"],
        ["TaskManager proxy", f"`{ds['TaskManager']['proxy']}`", f"`{da['TaskManager']['proxy']}`"],
        ["TaskManager implementation", f"`{s['tmImpl']}`", f"`{a['tmImpl']}`"],
        ["TaskManager `getVersion()` (upgrade counter only)", str(s["tmVersion"]), str(a["tmVersion"])],
        ["TaskManager source (bytecode-verified)", version, version],
        ["ACL proxy", f"`{s['acl']}`", f"`{a['acl']}`"],
        ["ACL implementation", f"`{s['aclImpl']}`", f"`{a['aclImpl']}`"],
        ["ACL source (bytecode-verified)", version, version],
        ["PlaintextsStorage proxy", f"`{s['plaintextsStorage']}`", f"`{a['plaintextsStorage']}`"],
        ["PlaintextsStorage implementation", f"`{s['plaintextsStorageImpl']}`", f"`{a['plaintextsStorageImpl']}`"],
        ["PlaintextsStorage source (bytecode-verified)", version,
         version],
        ["FHE.sol in the measuring contract",
         f"cofhe-contracts {deployed['packageVersion']} (FHE.sol at `{deployed['fheSolCommit'][:7]}`)", "same"],
        ["Compiler", "solc 0.8.25, optimizer 800 runs, viaIR, cancun", "same"],
        ["Method", "Foundry fork; `gasleft()` delta around the single `FHE.*` call; each probe call is its own "
                   "transaction (`isolate = true`)", "same"],
    ]
    return table(["Item", "Ethereum Sepolia", "Arbitrum Sepolia"], lines)


# results file stem -> chain name in results/deployed.json
DEPLOYED_NAME = {"sepolia": "sepolia", "arbitrum-sepolia": "arbitrumSepolia"}
IMPL_KEYS = {"TaskManager": "tmImpl", "ACL": "aclImpl", "PlaintextsStorage": "plaintextsStorageImpl"}


def check_consistency(chains, deployed):
    """Raise unless deployed.json verified the exact block and implementations that were measured."""
    for key, _ in CHAINS:
        measured, verified = chains[key], deployed["chains"][DEPLOYED_NAME[key]]
        if measured["forkBlock"] != verified["forkBlock"]:
            raise ValueError(f"{key}: measured block {measured['forkBlock']}, verified {verified['forkBlock']}")
        for name, impl_key in IMPL_KEYS.items():
            if measured[impl_key].lower() != verified[name]["impl"].lower():
                raise ValueError(f"{key} {name}: measured {measured[impl_key]}, verified {verified[name]['impl']}")
            if not verified[name]["match"]:
                raise ValueError(f"{key} {name}: bytecode does not match the sources")


def summaries(chains, ops):
    by_cat = {}
    for o in ops:
        if o["category"] in ("BatchInput", "BatchDecrypt"):
            continue
        # A cast to ebool is rewritten as ne(x, 0), a different op; it would swamp the type spread.
        if o["category"] == "Cast" and o["type"].endswith("__ebool"):
            continue
        by_cat.setdefault(o["category"], []).append(o)

    lines = []
    for label, cat in SUMMARY:
        spreads = []
        for key, _ in CHAINS:
            rows = chains[key]["rows"]
            per_op = {}
            for o in by_cat[cat]:
                per_op.setdefault(o["op"], []).append(rows[o["id"]]["first"])
            spreads.append(max(max(v) - min(v) for v in per_op.values()))
        flat = "yes" if max(spreads) <= FLAT_SPREAD else "no"
        lines.append([label, flat] + [f"{x:,}" for x in spreads])
    type_table = table(["Category", "Flat across types?", "Max spread across types, Sepolia",
                        "Max spread across types, Arb Sepolia"], lines)

    lines = []
    for label, cat in SUMMARY:
        meds = [statistics.median(chains[key]["rows"][o["id"]]["first"] for o in by_cat[cat]) for key, _ in CHAINS]
        lines.append([label, r100(meds[0]), r100(meds[1]), f"{int(meds[1] - meds[0]):+,}"])
    chain_table = table(["Category", "Sepolia median `first`", "Arb Sepolia median `first`", "Delta (raw gas)"], lines)
    return type_table, chain_table


def main():
    ops = json.loads(Path("results/ops.json").read_text())
    chains = {key: json.loads(Path(f"results/{key}.json").read_text()) for key, _ in CHAINS}
    deployed = json.loads(Path("results/deployed.json").read_text())
    check_consistency(chains, deployed)
    type_table, chain_table = summaries(chains, ops)

    out = ["# FHE operation gas costs\n",
           "Cell format: `first / extra`, rounded to the nearest 100 gas. `—` = the type does not support the op.\n",
           "- **first** — gas of the FHE call when it is the first FHE call in the transaction "
           "(cold TaskManager and ACL access).",
           "- **extra** — gas of the same op again in the same transaction. The second call reuses no operand "
           "of the first, so the TaskManager is warm but the operands' ACL entries are cold.\n",
           "## Measurement setup\n", setup_table(chains, deployed),
           "Arbitrum note: the numbers are L2 execution gas. Arbitrum also charges an L1 data fee for the calldata "
           "of the user's transaction. An FHE op inside a contract adds no calldata, so the fee does not change "
           "per op. Encrypted inputs (`FHE.asEuintX(InEuintX)`) do add calldata.\n"]
    for key, title in CHAINS:
        out += ["---\n", f"## {title} (TaskManager v{chains[key]['tmVersion']})\n", chain_tables(chains[key]["rows"])]
    out += ["---\n", "## Notes\n", FOOTNOTES, "## Type dependence summary\n",
            f"Spread = max − min of `first` across types for one op; the table shows the largest op spread in the "
            f"category. Flat = spread ≤ {FLAT_SPREAD} gas. Casts to `ebool` are left out (see the cast table).\n", type_table,
            "## Chain difference summary\n", chain_table]
    Path("results/gas-tables.md").write_text("\n".join(out))
    print("wrote results/gas-tables.md")


if __name__ == "__main__":
    main()
