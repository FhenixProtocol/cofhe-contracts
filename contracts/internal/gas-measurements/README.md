# FHE gas measurements

Measures the onchain gas of every `FHE.sol` operation, per encrypted type, against the
deployed TaskManager and ACL on Ethereum Sepolia and Arbitrum Sepolia. It runs on local forks:
no transaction is sent, no wallet or key is needed.

Output: `results/gas-tables.md` (tables for the docs) and the raw numbers in `results/*.json`.

## Run

```sh
(cd ../host-chain && pnpm install --frozen-lockfile)   # OpenZeppelin for FHE.sol and TaskManager
forge install foundry-rs/forge-std --no-git
cp .env.example .env                                     # public RPCs; override if rate-limited

python3 script/check_deployed.py   # deployed TM/ACL bytecode == sources in this checkout
python3 script/gen_probe.py        # regenerates src/GasProbe.sol and results/ops.json
python3 script/check_coverage.py   # every FHE.sol function has a probe row or a documented skip
forge test                         # measures on both forks, writes results/<chain>.json (~4 min)
python3 script/render.py           # writes results/gas-tables.md
```

The Arbitrum RPC must keep a few thousand blocks of state. `sepolia-rollup.arbitrum.io/rpc` works;
the publicnode endpoint prunes too fast for the run.

## What the numbers mean

Each probe row calls one `FHE.*` function twice in one transaction and measures each call with a
`gasleft()` delta. Operands are loaded before the measurement, so only the FHE call is counted.

- `first`: the first FHE call of the transaction (cold TaskManager and ACL).
- `extra`: the same call again, on a different operand (warm).

`isolate = true` in `foundry.toml` makes each probe call its own transaction, so `first` starts cold.

The probe uses a throwaway signer inside the fork (`vm.store` on the TaskManager signer slots),
so it can sign encrypted inputs and decrypt results. The gas path is unchanged: one signer SLOAD
plus `ecrecover`.

Operand handles derive from salted plaintexts. Handles are global and depend only on their inputs,
so a common plaintext can hit a handle someone already allowed on chain, which makes ACL calls cheaper.
