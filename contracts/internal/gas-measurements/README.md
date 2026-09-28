# FHE gas measurements

Measures the onchain gas of every `FHE.sol` operation, per encrypted type, against the
deployed TaskManager and ACL on Ethereum Sepolia and Arbitrum Sepolia. It runs on local forks:
no transaction is sent, no wallet or key is needed.

Output: `results/gas-tables.md` (tables for the docs) and the raw numbers in `results/*.json`.

## Run

```sh
(cd ../host-chain && pnpm install --frozen-lockfile)   # OpenZeppelin for FHE.sol and TaskManager
forge install foundry-rs/forge-std --no-git
forge install FhenixProtocol/fhenix-confidential-contracts@5138cb8644b19b24a75caf3f383a17457e823e16 --no-git
cp .env.example .env                                     # public RPCs; override if rate-limited

python3 script/gen_probe.py        # regenerates src/GasProbe.sol and results/ops.json
python3 script/check_coverage.py   # every FHE.sol overload has an exact probe row or a documented skip
python3 script/check_probe.py      # no "extra" call reuses an operand of its "first" call
forge test                         # measures on both forks: results/<chain>.json, fherc20-<chain>.json, erc20confidential-<chain>.json (~5 min)
python3 script/check_deployed.py   # TM/ACL/PlaintextsStorage at the measured block == sources here
REPLAY_EXPORT=true forge test --match-contract ReplayExport   # exports every row as a replayable eth_call
python3 script/replay.py           # replays them on real Ethereum/Arbitrum nodes (needs requests), fails on any difference
python3 script/render.py           # writes results/gas-tables.md; refuses unverified results
python3 script/test_render.py      # renderer unit tests
PYTHONPATH=script python3 script/export_xlsx.py   # results/gas-measurements.xlsx for Google Sheets (needs openpyxl)
```

The Arbitrum RPC must keep a few thousand blocks of state. `sepolia-rollup.arbitrum.io/rpc` works;
the publicnode endpoint prunes too fast for the run.

## What the numbers mean

Each probe row calls one `FHE.*` function twice in one transaction and measures each call with a
`gasleft()` delta. Operands are loaded before the measurement, so only the FHE call is counted.

- `first`: the first FHE call of the transaction (cold TaskManager and ACL).
- `extra`: the same op again, on operands the first call did not use (warm TaskManager, cold operand ACL entries).

`isolate = true` in `foundry.toml` makes each probe call its own transaction, so `first` starts cold.

The probe uses a throwaway signer inside the fork (`vm.store` on the TaskManager signer slots),
so it can sign encrypted inputs and decrypt results. The gas path is unchanged: one signer SLOAD
plus `ecrecover`.

Operand handles derive from salted plaintexts. Handles are global and depend only on their inputs,
so a common plaintext can hit a handle someone already allowed on chain, which makes ACL calls cheaper.
