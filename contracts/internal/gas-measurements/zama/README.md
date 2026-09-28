# Zama fhEVM gas measurements

The Zama side of `../results/zama-comparison.md`. Same method as the CoFHE harness in the parent folder:
forks of the live chains, a `gasleft()` delta around one FHE call per row (`first` / `extra`), and
whole-transaction gas for an OpenZeppelin `ERC7984` token. No transaction is sent.

The fork swaps Zama's coprocessor input signers for test keys with `defineNewContext` (as the ACL owner),
keeping the live signer count and threshold, so every proof carries as many signatures as on the real chain.

```sh
npm install
cp .env.example .env
python3 gen_probe.py   # regenerates src/ZamaProbe.sol and results/zama-ops.json
forge test             # writes results/zama-mainnet.json and results/zama-sepolia.json
```

forge-std comes from `../lib` (install it there first). Then run `python3 script/render.py` in the parent folder.
