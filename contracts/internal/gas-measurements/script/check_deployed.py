#!/usr/bin/env python3
"""Prove the deployed TaskManager and ACL run the code in this checkout.

Compiles both contracts with the host-chain compiler settings and compares the
result with the live implementation bytecode on each chain. Run from
contracts/internal/gas-measurements.
"""
import json
import subprocess
import sys

CHAINS = {
    "sepolia": "https://ethereum-sepolia-rpc.publicnode.com",
    "arbitrumSepolia": "https://arbitrum-sepolia-rpc.publicnode.com",
}
TM = "0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9"
IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"


def sh(*args):
    return subprocess.check_output(args, text=True).strip()


def strip_metadata(code):
    code = code.lower().removeprefix("0x")
    # The last 2 bytes give the CBOR metadata length; drop it and the length itself.
    return code[: -(int(code[-4:], 16) + 2) * 2]


def implementation(proxy, rpc):
    impl = "0x" + sh("cast", "storage", proxy, IMPL_SLOT, "--rpc-url", rpc)[-40:]
    return proxy if int(impl, 16) == 0 else impl


def compiled(name):
    with open(f"out/{name}.sol/{name}.json") as f:
        return strip_metadata(json.load(f)["deployedBytecode"]["object"])


def main():
    subprocess.check_call(["forge", "build", "--quiet"])
    local = {name: compiled(name) for name in ("TaskManager", "ACL")}
    ok = True
    for chain, rpc in CHAINS.items():
        proxies = {"TaskManager": TM, "ACL": sh("cast", "call", TM, "acl()(address)", "--rpc-url", rpc)}
        for name, proxy in proxies.items():
            impl = implementation(proxy, rpc)
            # UUPS stores its own address as an immutable; the compiler leaves zeros there.
            live = strip_metadata(sh("cast", "code", impl, "--rpc-url", rpc)).replace(impl[2:].lower(), "0" * 40)
            match = live == local[name]
            ok &= match
            print(f"{chain:16} {name:12} proxy={proxy} impl={impl} match={match}")
    print("commit:", sh("git", "rev-parse", "--short", "HEAD"), "| describe:", sh("git", "describe", "--tags", "--always"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
