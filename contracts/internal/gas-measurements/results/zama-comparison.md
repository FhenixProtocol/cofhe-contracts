# Gas comparison: Fhenix CoFHE vs Zama fhEVM

Both sides measured the same way on forks of the live contracts: a `gasleft()` delta around one FHE call (`first` = first FHE call of the transaction, `extra` = the same op again on fresh operands), and whole-transaction gas for tokens. Cells are `first / extra`, rounded to the nearest 100 gas. All numbers are `euint64`.

- Fhenix: CoFHE 0.3.0 TaskManager on Ethereum Sepolia (same code as Arbitrum Sepolia), FHE.sol 0.3.0, solc 0.8.25.
- Zama: `@fhevm/solidity` 0.11.1 and `@openzeppelin/confidential-contracts` 0.5.3 (ERC7984), solc 0.8.27. Mainnet is Zama's live deployment. The input signers were swapped for test keys with the live signer count and threshold.
- Zama also enforces an HCU (homomorphic complexity) limit per transaction. It is not gas and is not shown here.

## Zama contracts measured

| Item | Zama, Ethereum mainnet (live) | Zama, Sepolia |
|---|---|---|
| Fork block | 26,075,548 | 11,800,109 |
| FHEVMExecutor | FHEVMExecutor v0.4.0 (`0xD82385dADa1ae3E969447f20A3164F6213100e75`) | FHEVMExecutor v0.5.0 (`0x92C920834Ec8941d2C77D188936E1f7A6f49c127`) |
| ACL | ACL v0.4.0 (`0xcA2E8f1F656CD25C01F05d0b243Ab1ecd4a8ffb6`) | ACL v0.4.0 (`0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D`) |
| InputVerifier | InputVerifier v0.2.0 (`0xCe0FC2e05CFff1B719EFF7169f7D80Af770c8EA2`) | InputVerifier v0.2.0 (`0xBBC1fFCdc7C316aAAd72E807D9b0272BE8F84DA0`) |
| HCULimit | HCULimit v0.3.0 (`0x3b4da65e45Fda2CAa0285A735ab4361a44F171E2`) | HCULimit v0.3.0 (`0xa10998783c8CF88D886Bc30307e631D6686F0A22`) |
| Coprocessor signatures per input proof | 1 | 3 |

## FHE operations (euint64)

| Operation | Fhenix CoFHE | Zama, Ethereum mainnet (live) | Zama, Sepolia | Note |
|---|---|---|---|---|
| `add` | 51,600 / 31,600 | 51,400 / 19,600 | 51,400 / 19,600 |  |
| `sub` | 51,500 / 31,400 | 51,300 / 19,500 | 51,300 / 19,500 |  |
| `mul` | 52,600 / 32,600 | 51,400 / 19,500 | 51,300 / 19,500 |  |
| `min` | 53,600 / 33,600 | 51,300 / 19,500 | 51,300 / 19,500 |  |
| `max` | 53,700 / 33,700 | 51,400 / 19,500 | 51,300 / 19,500 |  |
| `square` | 48,800 / 28,800 | 49,400 / 17,500 | 49,300 / 17,500 | Zama has no `square`; measured as `mul(x, x)` |
| `eq` | 52,700 / 32,600 | 51,700 / 19,800 | 51,700 / 19,900 |  |
| `ne` | 53,000 / 32,900 | 51,600 / 19,800 | 51,600 / 19,800 |  |
| `lt` | 53,000 / 33,000 | 51,300 / 19,500 | 51,300 / 19,500 |  |
| `lte` | 52,800 / 32,800 | 51,300 / 19,500 | 51,400 / 19,600 |  |
| `gt` | 53,300 / 33,300 | 51,400 / 19,500 | 51,400 / 19,600 |  |
| `gte` | 52,800 / 32,800 | 51,300 / 19,500 | 51,300 / 19,500 |  |
| `and` | 51,600 / 31,600 | 51,500 / 19,700 | 51,500 / 19,700 |  |
| `or` | 51,900 / 31,800 | 51,500 / 19,700 | 51,500 / 19,700 |  |
| `xor` | 51,500 / 31,400 | 51,600 / 19,700 | 51,500 / 19,700 |  |
| `not` | 45,600 / 25,600 | 46,100 / 14,200 | 46,100 / 14,200 |  |
| `shl` | 52,700 / 32,700 | 64,300 / 32,500 | 64,300 / 32,500 | Not like-for-like: Zama shifts by an `euint8`, CoFHE by the operand type |
| `shr` | 52,900 / 32,900 | 64,300 / 32,500 | 64,300 / 32,500 | Not like-for-like: Zama shifts by an `euint8`, CoFHE by the operand type |
| `rol` | 54,400 / 34,400 | 64,300 / 32,500 | 64,300 / 32,500 | Not like-for-like: Zama shifts by an `euint8`, CoFHE by the operand type |
| `ror` | 54,600 / 34,600 | 64,300 / 32,500 | 64,200 / 32,400 | Not like-for-like: Zama shifts by an `euint8`, CoFHE by the operand type |
| `select` | 55,900 / 35,900 | 55,600 / 23,800 | 55,600 / 23,700 |  |
| `trivial` | 45,200 / 25,200 | 41,900 / 10,100 | 41,600 / 9,800 |  |
| `input` | 39,800 / 17,800 | 106,400 / 67,400 | 204,100 / 161,100 |  |
| `random` | 40,900 / 16,100 | 47,300 / 10,700 | 47,400 / 10,800 |  |
| `allow` | 44,700 / 28,700 | 41,700 / 28,600 | 41,700 / 28,600 |  |
| `allowThis` | 26,300 / 26,300 | 30,300 / 26,300 | 30,300 / 26,300 |  |
| `allowTransient` | 23,000 / 7,000 | 18,100 / 5,100 | 18,100 / 5,100 |  |
| `allowPublic` | 44,100 / 28,100 | 42,800 / 29,800 | 42,800 / 29,800 | Zama `makePubliclyDecryptable` vs CoFHE `allowPublic` |
| `isAllowed` | 22,200 / 6,200 | 13,100 / 4,100 | 13,100 / 4,100 |  |
| div (plaintext divisor) | — | 47,300 / 15,500 | 47,500 / 15,700 | Not like-for-like: Zama only; CoFHE divides by an encrypted value |
| rem (plaintext divisor) | — | 47,300 / 15,500 | 47,500 / 15,700 | Not like-for-like: Zama only; CoFHE divides by an encrypted value |
| add (plaintext operand) | — | 47,000 / 15,200 | 47,600 / 15,700 | Not like-for-like: Zama only; CoFHE has no plaintext operands |

## Confidential token (whole transaction)

Fhenix `FHERC20` (fhenix-confidential-contracts `5138cb8`) vs OpenZeppelin `ERC7984` on Zama. Both with an encrypted input amount. FHERC20 also keeps an ERC20-compatible indicator balance.

| Action | Fhenix FHERC20 | Zama, Ethereum mainnet (live) ERC7984 | Zama, Sepolia ERC7984 |
|---|---|---|---|
| `confidentialTransfer` to an existing holder | 421,500 | 438,300 | 537,800 |
| `confidentialTransfer`, repeated | 421,500 | 438,300 | 537,900 |
| `confidentialTransfer` to a new holder | 474,400 | 463,300 | 562,500 |
| `confidentialTransferFrom` by an operator | 424,800 | 444,300 | 543,900 |
| `setOperator` | 46,700 | 46,500 | 46,500 |
