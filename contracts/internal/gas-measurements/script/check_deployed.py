#!/usr/bin/env python3
"""Prove the measured TaskManager, ACL and PlaintextsStorage run the code in this checkout.

Run after `forge test`: reads each chain's fork block and implementation addresses from
results/<chain>.json, fetches the implementation code at that block, and compares it with the
compiled sources (host-chain compiler settings). Writes results/deployed.json.
Run from contracts/internal/gas-measurements.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

# forge chain alias -> results file stem and .env variable (same RPCs as the measurement).
CHAINS = {
    "sepolia": ("sepolia", "SEPOLIA_RPC_URL"),
    "arbitrumSepolia": ("arbitrum-sepolia", "ARBITRUM_SEPOLIA_RPC_URL"),
}
TM = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9"
IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
TARGETS = {"TaskManager": ("tmImpl", None), "ACL": ("aclImpl", "acl()(address)"),
           "PlaintextsStorage": ("plaintextsStorageImpl", "plaintextsStorage()(address)")}


def sh(*args):
    return subprocess.check_output(args, text=True).strip()


def load_env():
    env = {}
    for line in Path(".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip()
    return {**env, **os.environ}


def strip_metadata(code):
    code = code.lower().removeprefix("0x")
    # The last 2 bytes give the CBOR metadata length; drop it and the length itself.
    return code[: -(int(code[-4:], 16) + 2) * 2]


def compiled(name):
    with open(f"out/{name}.sol/{name}.json") as f:
        return strip_metadata(json.load(f)["deployedBytecode"]["object"])


def main():
    subprocess.check_call(["forge", "build", "--quiet"])
    env = load_env()
    local = {name: compiled(name) for name in TARGETS}
    package_version = json.loads(Path("../../package.json").read_text())["version"]
    sources = ["../host-chain/contracts/TaskManager.sol", "../host-chain/contracts/ACL.sol",
               "../host-chain/contracts/PlaintextsStorage.sol", "../../ICofhe.sol"]
    report = {"packageVersion": package_version,
              "sourceCommit": sh("git", "log", "-1", "--format=%H", "--", *sources),
              "fheSolCommit": sh("git", "log", "-1", "--format=%H", "--", "../../FHE.sol"),
              "describe": sh("git", "describe", "--tags", "--always"), "chains": {}}
    ok = True
    for chain, (stem, rpc_var) in CHAINS.items():
        measured = json.loads(Path(f"results/{stem}.json").read_text())
        rpc, block = env[rpc_var], str(measured["forkBlock"])
        at = ("--block", block, "--rpc-url", rpc)
        report["chains"][chain] = {"forkBlock": measured["forkBlock"]}
        for name, (impl_key, getter) in TARGETS.items():
            proxy = TM if getter is None else sh("cast", "call", TM, getter, *at)
            impl = "0x" + sh("cast", "storage", proxy, IMPL_SLOT, *at)[-40:]
            if impl.lower() != measured[impl_key].lower():
                raise SystemExit(f"{chain} {name}: impl {impl} at block {block} != measured {measured[impl_key]}")
            # UUPS stores its own address as an immutable; the compiler leaves zeros there.
            live = strip_metadata(sh("cast", "code", impl, *at)).replace(impl[2:].lower(), "0" * 40)
            match = live == local[name]
            ok &= match
            report["chains"][chain][name] = {"proxy": proxy, "impl": impl, "match": match}
            print(f"{chain:16} {name:18} block={block} impl={impl} match={match}")
    print(f"cofhe-contracts {package_version}, sources last changed in {report['sourceCommit'][:7]}")
    Path("results/deployed.json").write_text(json.dumps(report, indent=1) + "\n")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
