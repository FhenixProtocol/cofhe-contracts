#!/usr/bin/env python3
"""Render results/*.json into the markdown gas tables (results/gas-tables.md).

Run from contracts/internal/gas-measurements after check_deployed.py and `forge test`.
"""
import json
from pathlib import Path

BATCH_SIZES = ["1", "2", "4", "8"]
CHAINS = [("sepolia", "Ethereum Sepolia"), ("arbitrum-sepolia", "Arbitrum Sepolia")]
# One value per op is only honest while the types cost about the same; above this the renderer fails.
TYPE_SPREAD_LIMIT = 500  # gas

ALL_TYPES = "all 7 types"
UINTS = "euint8–euint128"
BOOL_UINTS = "ebool, euint8–euint128"
# (title, [(group key, label, types label)]). A group key is an op name from results/ops.json.
TABLES = [
    ("Arithmetic", [(op, f"`{op}`", UINTS) for op in ["add", "sub", "mul", "div", "rem", "square", "min", "max"]]),
    ("Comparison", [("eq", "`eq`", ALL_TYPES), ("ne", "`ne`", ALL_TYPES)]
     + [(op, f"`{op}`", UINTS) for op in ["lt", "lte", "gt", "gte"]]),
    ("Bitwise and shift", [(op, f"`{op}`", BOOL_UINTS) for op in ["and", "or", "xor", "not"]]
     + [(op, f"`{op}`", UINTS) for op in ["shl", "shr", "rol", "ror"]]),
    ("Select", [("select", "`select`", ALL_TYPES)]),
    ("Encrypt (create a ciphertext)", [
        ("trivial", "Trivial encrypt `FHE.asEuintX(plaintext)` ¹", ALL_TYPES),
        ("input", "Encrypted input `FHE.asEuintX(InEuintX)`", ALL_TYPES),
        ("inputBytes", "Encrypted input, ABI-encoded `FHE.asEuintX(bytes)`", ALL_TYPES),
        ("random", "Random `FHE.randomEuintX()`", UINTS)]),
    ("Cast", [
        ("cast", "Cast `FHE.asX(eY)`, not to `ebool`", "any → euint8–euint128"),
        ("castToEbool", "Cast to `ebool` `FHE.asEbool(eY)` ¹ ⁶", "euint8–euint128, eaddress → ebool")]),
    ("Access control", [
        ("allow", "`allow`", ALL_TYPES), ("allowThis", "`allowThis` ²", ALL_TYPES),
        ("allowSender", "`allowSender`", ALL_TYPES), ("allowTransient", "`allowTransient`", ALL_TYPES),
        ("allowGlobal", "`allowGlobal`", ALL_TYPES), ("allowPublic", "`allowPublic`", ALL_TYPES),
        ("isAllowed", "`isAllowed` (view) ⁵", ALL_TYPES),
        ("isPubliclyAllowed", "`isPubliclyAllowed` (view)", ALL_TYPES)]),
    ("Sharing", [("share", "`shareX`", ALL_TYPES), ("receiveParam", "`receiveXParam` ³", ALL_TYPES),
                 ("receiveFromCall", "`receiveXFromCall` ³", ALL_TYPES)]),
    ("Decryption results", [
        ("publishDecrypt", "`publishDecryptResult` ⁴", ALL_TYPES),
        ("verifyDecrypt", "`verifyDecryptResult` (view)", ALL_TYPES),
        ("verifyDecryptSafe", "`verifyDecryptResultSafe` (view)", ALL_TYPES),
        ("getDecrypt", "`getDecryptResult` (view)", ALL_TYPES),
        ("getDecryptSafe", "`getDecryptResultSafe` (view)", ALL_TYPES)]),
]

TOKEN_REPO = "`FhenixProtocol/fhenix-confidential-contracts`"
# results file prefix -> (section title, what was deployed, [(row id, label)])
TOKENS = {
    "fherc20": ("FHERC20 transfer (whole transaction)", "The reference `FHERC20` (its test harness)", [
        ("transferToHolder", "`confidentialTransfer` to an existing holder"),
        ("transferAgain", "`confidentialTransfer`, repeated (same sender and recipient)"),
        ("transferToNewHolder", "`confidentialTransfer` to a new holder (no balance yet)"),
        ("transferFromByOperator", "`confidentialTransferFrom` by an operator"),
        ("setOperator", "`setOperator` (one-time approval)"),
        ("erc20TransferToHolder", "Baseline: plain OpenZeppelin ERC20 `transfer` to an existing holder"),
        ("erc20TransferToNewHolder", "Baseline: plain OpenZeppelin ERC20 `transfer` to a new holder"),
    ]),
    "erc20confidential": (
        "ERC20Confidential transfer (whole transaction)",
        "`ERC20Confidential` (hybrid public + confidential balances; its mock, linked to `ERC20ConfidentialLib`)", [
            ("confidentialTransferToHolder", "`confidentialTransfer` to an existing holder"),
            ("confidentialTransferToNewHolder", "`confidentialTransfer` to a new holder (no balance yet)"),
            ("confidentialTransferFromByOperator", "`confidentialTransferFrom` by an operator"),
            ("confidentialTransferToHolderWithObserver", "`confidentialTransfer` to an existing holder, with an observer set"),
            ("shield", "`shield` (public balance → confidential balance)"),
            ("setOperator", "`setOperator` (one-time approval)"),
            ("publicTransferToHolder", "Public ERC20 `transfer` on the same token, to an existing holder"),
            ("publicTransferToNewHolder", "Public ERC20 `transfer` on the same token, to a new holder"),
        ]),
}

FOOTNOTES = """¹ Trivial `ebool` has only two handles (`true`, `false`), shared by every contract on the chain. Their ACL state differs per chain, so these cells can differ by a few gas between chains. The same holds for a cast to `ebool`, which uses the shared trivial-0 handle.
² `allowThis` is measured on a result handle created earlier in the same transaction (the normal pattern: compute, then `allowThis`). The TaskManager is already warm, so `first` and `extra` are close.
³ A receive always follows a share in the same transaction, so the TaskManager is already warm; `first` and `extra` are close.
⁴ Measured with a non-zero result. A zero result (for example `false` or an amount of 0) leaves one storage slot at zero, so it costs less.
⁵ Measured on a handle already allowed to the account, which returns early. A "not allowed" answer reads more storage, so it costs more.
⁶ FHE.sol implements a cast to `ebool` as `ne(value, asEuintX(0))`: two TaskManager tasks instead of one.
"""


def r100(gas):
    return f"{int(round(gas / 100.0)) * 100:,}"


def groups(ops):
    """Group key -> row ids that share one published value. Batch rows are not grouped."""
    out = {}
    for o in ops:
        if o["category"] in ("BatchInput", "BatchDecrypt"):
            continue
        key = "castToEbool" if o["category"] == "Cast" and o["type"].endswith("__ebool") else o["op"]
        out.setdefault(key, []).append(o["id"])
    return out


def spread(rows, ids, field):
    values = [rows[i][field] for i in ids]
    return max(values) - min(values)


def check_type_spread(rows, ops):
    """Raise if an op's cost depends on the type more than TYPE_SPREAD_LIMIT."""
    for key, ids in groups(ops).items():
        for field in ("first", "extra"):
            if spread(rows, ids, field) > TYPE_SPREAD_LIMIT:
                raise ValueError(f"{key}.{field}: spread {spread(rows, ids, field)} gas across types")


def table(header, lines):
    out = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    out += ["| " + " | ".join(line) + " |" for line in lines]
    return "\n".join(out) + "\n"


def chain_tables(rows, ops):
    grouped = groups(ops)
    out = []
    for title, entries in TABLES:
        lines = []
        for key, label, types in entries:
            ids = grouped[key]
            lines.append([label, r100(max(rows[i]["first"] for i in ids)), r100(max(rows[i]["extra"] for i in ids)),
                          types, f"{spread(rows, ids, 'first'):,}"])
        out.append(f"### {title}\n\n" + table(["Operation", "first", "extra", "Types", "Type spread (gas)"], lines))

    lines = [["Total gas"] + [r100(rows[f"inputBatch__{n}"]["first"]) for n in BATCH_SIZES],
             ["Gas per input"] + [r100(rows[f"inputBatch__{n}"]["first"] / int(n)) for n in BATCH_SIZES]]
    out.append("### Batch encrypted inputs (`FHE.asEuint32s`, one signature)\n\n"
               + table(["Inputs in batch"] + BATCH_SIZES, lines))

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


def check_chains_match(chains):
    """Raise if any published (rounded) value differs between chains; return (exact, total) raw matches.

    The docs show one table set for both chains, which is only true while this holds.
    """
    base, other = (chains[key]["rows"] for key, _ in CHAINS)
    exact = 0
    for rid, r in base.items():
        for field in ("first", "extra"):
            if r100(r[field]) != r100(other[rid][field]):
                raise ValueError(f"{rid}.{field}: {r[field]} vs {other[rid][field]} differ after rounding")
        exact += r == other[rid]
    return exact, len(base)


def check_tokens(tokens, deployed):
    """Raise unless each token run used the verified implementations and agrees across chains."""
    for name, (_, _, token_rows) in TOKENS.items():
        runs = tokens[name]
        for key, _ in CHAINS:
            verified = deployed["chains"][DEPLOYED_NAME[key]]
            for contract, impl_key in IMPL_KEYS.items():
                if runs[key][impl_key].lower() != verified[contract]["impl"].lower() or not verified[contract]["match"]:
                    raise ValueError(f"{name} {key} {contract}: {runs[key][impl_key]} is not the verified implementation")
        base, other = (runs[key]["rows"] for key, _ in CHAINS)
        for rid, _ in token_rows:
            if r100(base[rid]) != r100(other[rid]):
                raise ValueError(f"{name} {rid}: {base[rid]} vs {other[rid]} differ after rounding")


def token_tables(tokens):
    out = []
    for name, (title, what, token_rows) in TOKENS.items():
        rows = tokens[name]["sepolia"]["rows"]
        commit = tokens[name]["sepolia"]["sourceCommit"][:7]
        out.append(f"### {title}\n\n{what} from {TOKEN_REPO} at `{commit}`, deployed on each fork, with an "
                   "encrypted input amount (`InEuint64`) where the call takes one. Gas is the full transaction: "
                   "21,000 base + calldata + execution. On Arbitrum, add the L1 data fee for the calldata.\n\n"
                   + table(["Action", "Gas (full transaction)"], [[label, r100(rows[rid])] for rid, label in token_rows]))
    return "\n".join(out)


def load_tokens():
    return {name: {key: json.loads(Path(f"results/{name}-{key}.json").read_text()) for key, _ in CHAINS}
            for name in TOKENS}


def main():
    ops = json.loads(Path("results/ops.json").read_text())
    chains = {key: json.loads(Path(f"results/{key}.json").read_text()) for key, _ in CHAINS}
    deployed = json.loads(Path("results/deployed.json").read_text())
    tokens = load_tokens()
    check_consistency(chains, deployed)
    check_tokens(tokens, deployed)
    exact, total = check_chains_match(chains)
    rows = chains["sepolia"]["rows"]
    check_type_spread(rows, ops)

    out = ["# FHE operation gas costs\n",
           "One value per op: the cost barely depends on the encrypted type, because the FHE math runs offchain. "
           "Each value is the highest across the listed types, rounded to the nearest 100 gas. Type spread = "
           "highest − lowest raw `first` across those types.\n",
           "- **first** — gas of the FHE call when it is the first FHE call in the transaction "
           "(cold TaskManager and ACL access).",
           "- **extra** — gas of the same op again in the same transaction. The second call reuses no operand "
           "of the first, so the TaskManager is warm but the operands' ACL entries are cold.\n",
           "## Measurement setup\n", setup_table(chains, deployed),
           "Both chains run the same cofhe-contracts code and were measured separately. Every published value is "
           f"equal on both chains (Arbitrum Sepolia: {exact} of {total} rows equal Sepolia to the gas unit; the rest differ "
           "by less than the rounding).\n",
           "Arbitrum note: the numbers are L2 execution gas. Arbitrum also charges an L1 data fee for the calldata "
           "of the user's transaction. An FHE op inside a contract adds no calldata, so the fee does not change "
           "per op. Encrypted inputs (`FHE.asEuintX(InEuintX)`) do add calldata.\n",
           "---\n", "## Ethereum Sepolia and Arbitrum Sepolia\n", token_tables(tokens), chain_tables(rows, ops),
           "---\n", "## Notes\n", FOOTNOTES]
    Path("results/gas-tables.md").write_text("\n".join(out))
    print("wrote results/gas-tables.md")


if __name__ == "__main__":
    main()
