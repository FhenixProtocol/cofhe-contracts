# Setting the TaskManager signers as the Safe

How to set `verifierSigner` and `decryptResultSigner` on a TaskManager whose signer-manager
roles are held by the Safe, using `task:setSignersAsSafe` and the Safe app. Every command runs
from `contracts/internal/host-chain` and reads that directory's `.env`.

## Facts

- The two setters are role-gated: `setVerifierSigner` needs `VERIFIER_SIGNER_MANAGER_ROLE`,
  `setDecryptResultSigner` needs `DECRYPT_SIGNER_MANAGER_ROLE`. After the handover and
  `renounceDeployerRoles` the Safe is the only holder, so both calls are Safe transactions.
- Neither setter has a timelock. The batch can be executed as soon as it is signed.
- The values are the services' signing keys, never an admin wallet: the zk-verifier's signing
  address (`zk_signer` in the keygen ceremony output) and the teecryptor's decrypt-result signer
  (`decrypt_signer`). The TaskManager accepts input proofs and decrypt results signed by exactly
  these two keys.
- `address(0)` means debug mode: signature verification is skipped. The task refuses it, and it
  refuses the Safe's own address.
- Mainnet today holds placeholders that must be replaced before `enable()`: `0x…dEaD` on
  Ethereum, the deployer address on Arbitrum One.

## Prerequisites

- `.env` with `SAFE_ADMIN_ADDRESS` set to the Safe and the chain's keyed RPC
  (`ETHEREUM_RPC_URL` / `ARBITRUM_ONE_RPC_URL`). Leave `SAFE_OWNER_KEY` unset for a multisig.
- A funded signer key in `DEPLOYER_PRIVATE_KEY` is **not** needed: the task sends nothing itself.
- Access to the Safe app (`app.safe.global`) for that chain, and a Safe owner with their key
  (Ledger) on the machine that will sign.
- `cast` (foundry) for the checks.

## Procedure

### Step 1 — Read the current values

```bash
RPC=<keyed rpc for the chain>
TM=$(cast call 0xC0F4e00E531a2B086492Ae3DCC1515038307196b "getTm(uint256)(address)" 1 --rpc-url $RPC)
cast call $TM "verifierSigner()(address)" --rpc-url $RPC
cast call $TM "decryptResultSigner()(address)" --rpc-url $RPC
```

Check: `$TM` is the TaskManager you expect for this chain and the two values are the placeholders
you intend to replace.

### Step 2 — Write the Safe batch

```bash
npx hardhat task:setSignersAsSafe --verifier <zk_signer> --decrypt <decrypt_signer> --network <net>
```

`<net>` is `ethereum` or `arbitrumOne`. With `SAFE_OWNER_KEY` unset the task checks that the Safe
holds both roles, then writes `safe-batches/<net>-set-signers-<unix>.json` and prints the two
calls it contains with their current and target values. To change only one signer use
`task:setVerifierSignerAsSafe --address <zk_signer>` or
`task:setDecryptResultSignerAsSafe --address <decrypt_signer>`.

Check: the printed `to` is `$TM` from Step 1, the two `data` fields decode to the intended
addresses:

```bash
cast calldata-decode "setVerifierSigner(address)" <data of the first call>
cast calldata-decode "setDecryptResultSigner(address)" <data of the second call>
```

### Step 3 — Import, sign, execute in the Safe app

1. Move the JSON file to the machine that holds a Safe owner key.
2. In the Safe app select the Safe on the right chain, open Apps → Transaction Builder, and
   import the file.
3. Review the two calls against Step 2, sign with the required owners, execute. The owner who
   clicks Execute pays the gas from their own wallet.

Check: the Safe app shows the transaction as executed and Etherscan / Arbiscan shows two
`VerifierSignerChanged` / `DecryptResultSignerChanged` events on the TaskManager.

### Step 4 — Verify

```bash
npx hardhat task:setSignersAsSafe --verifier <zk_signer> --decrypt <decrypt_signer> --network <net>
```

Check: the task prints `verifier signer: already <zk_signer> - nothing to do` and the same for the
decrypt-result signer, and writes no batch. Or read them back with the `cast call`s from Step 1.

### Step 5 — Repeat for the other chain

The Safe exists at the same address on Ethereum and Arbitrum One, but each chain has its own
TaskManager state. Run Steps 1 to 4 once per chain.

## Threshold-1 Safe, or an EOA admin

With `SAFE_OWNER_KEY` set to a key that is an owner of a threshold-1 Safe, the task executes both
calls through the Safe immediately and prints `<label>: <old> -> <new>`; if the key is the admin
EOA's own key (testnets), it sends directly. No file is written. Unset it again afterwards.

## Troubleshooting

| Message | Cause | Fix |
| --- | --- | --- |
| `Safe ... does not hold VERIFIER_SIGNER_MANAGER_ROLE` | The handover did not run or was not accepted on this chain | Finish `task:acceptAdminAsSafe`, then retry |
| `No code at 0xC0F4e00E...` | Ran without `--network`, against the in-process Hardhat network | Add `--network <net>` |
| `refusing to set ... to address(0)` | A zero signer disables verification | Pass the service's real signing address |
| `refusing to set ... to the Safe` | The Safe is an admin, not a signer | Pass the service's real signing address |
| Safe app rejects with `GS026` or asks for more signatures | The signer is not an owner, or the threshold needs more owners | Sign with enough owners, then execute |
| `already ... nothing to do` on the first run | The signer was set earlier (another batch, or directly before renounce) | Nothing to do; confirm with Step 1 |
