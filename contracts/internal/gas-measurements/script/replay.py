#!/usr/bin/env python3
"""Replay the exported probe calls on real nodes and compare their gas with the Sepolia fork.

Each row from test/ReplayExport.t.sol is sent as an eth_call to a live RPC node, with the row's
accounts and pre-call storage as a state override. The node's own EVM (geth, Arbitrum Nitro)
executes it; the probe measures itself with gasleft() and returns the numbers. No transaction is
sent and no key is needed. Needs `requests`. Run from contracts/internal/gas-measurements after
`REPLAY_EXPORT=true forge test --match-contract ReplayExport`.
"""
import glob
import json
import sys
import time
from pathlib import Path

import requests

CHAINS = [  # (name, chain id, RPC)
    ("Ethereum mainnet", 1, "https://ethereum-rpc.publicnode.com"),
    ("Arbitrum One", 42161, "https://arb1.arbitrum.io/rpc"),
    ("Ethereum Sepolia", 11155111, "https://ethereum-sepolia-rpc.publicnode.com"),
    ("Arbitrum Sepolia", 421614, "https://sepolia-rollup.arbitrum.io/rpc"),
]
CALL_GAS = hex(30_000_000)


def load():
    """Rows with the code map of their own export file: each export test runs on its own fork, so
    different probe contracts share one deploy address across files."""
    rows = []
    for rows_file in sorted(glob.glob("results/replay/rows-*.jsonl")):
        codes = {}
        for line in Path(rows_file.replace("/rows-", "/codes-")).read_text().splitlines():
            c = json.loads(line)
            codes[c["address"].lower()] = c["code"]
        rows += [(json.loads(line), codes) for line in Path(rows_file).read_text().splitlines()]
    if not rows:
        sys.exit("no exported rows: run REPLAY_EXPORT=true forge test --match-contract ReplayExport")
    return rows


def override(row, codes):
    state = {}
    for account in row["accounts"]:
        a = account.lower()
        state.setdefault(a, {})
        if a in codes:
            state[a]["code"] = codes[a]
    for account, slot, value in row["storage"]:
        state.setdefault(account.lower(), {}).setdefault("stateDiff", {})[slot] = value
    return state


def decode(hexdata):
    raw = bytes.fromhex(hexdata[2:])
    return [int.from_bytes(raw[i:i + 32], "big") for i in range(0, len(raw), 32)]


def call(rpc, body):
    for attempt in range(8):
        try:
            r = requests.post(rpc, json=body, timeout=60)
            if r.status_code == 429:
                raise RuntimeError("rate limited")
            reply = r.json()
            if "error" in reply and "rate" in str(reply["error"]).lower():
                raise RuntimeError(reply["error"])
            return reply
        except (requests.RequestException, RuntimeError, ValueError):
            time.sleep(2 ** attempt)
    raise SystemExit(f"{rpc}: no answer after retries")


def main():
    rows = load()
    # Reference: the isolated fork measurement of the same rows (test/MeasureGas.t.sol).
    fork = json.loads(Path("results/sepolia.json").read_text())["rows"]
    report = {"rows": len(rows), "chains": {}}
    per_chain = {}
    for name, chain_id, rpc in CHAINS:
        results = {}
        for row, codes in rows:
            body = {"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                    "params": [{"from": row["from"], "to": row["to"], "data": row["data"][str(chain_id)],
                                "gas": CALL_GAS}, "latest", override(row, codes)]}
            reply = call(rpc, body)
            if "error" in reply:
                raise SystemExit(f"{name} {row['id']}: {reply['error']}")
            results[row["id"]] = decode(reply["result"])[:2]
        per_chain[name] = results
        vs_fork = [rid for rid, got in results.items() if rid in fork and got != [fork[rid]["first"], fork[rid]["extra"]]]
        report["chains"][name] = {"chainId": chain_id, "rpc": rpc, "notEqualToFork": vs_fork, "results": results}
        print(f"{name:18} {len(results)} calls; {len(vs_fork)} probe rows differ from the fork measurement")
    base_name = CHAINS[0][0]
    for name, results in per_chain.items():
        diff = [rid for rid in results if results[rid] != per_chain[base_name][rid]]
        report["chains"][name]["notEqualToEthereumMainnet"] = diff
        print(f"{name:18} vs {base_name}: {len(results) - len(diff)}/{len(results)} identical {diff[:5]}")
    Path("results/replay/replayed.json").write_text(json.dumps(report, indent=1) + "\n")
    if any(c["notEqualToFork"] or c["notEqualToEthereumMainnet"] for c in report["chains"].values()):
        sys.exit("gas differs between engines, see results/replay/replayed.json")


if __name__ == "__main__":
    main()
