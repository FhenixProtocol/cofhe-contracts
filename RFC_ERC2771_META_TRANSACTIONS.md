# RFC: ERC-2771 Meta-Transaction Support

## Summary

Add ERC-2771 meta-transaction support to `TaskManager.sol` to enable relayer patterns where encrypted inputs are created client-side but submitted via a trusted forwarder.

## Motivation

Current FHE encryption is cryptographically bound to `msg.sender`. The ZK proof embeds the wallet address, and on-chain verification requires the submitting wallet to match. This blocks relayer patterns where:

- User encrypts client-side (browser/mobile)
- Relayer submits transaction (via gas sponsorship service)

Use cases:
- Circle Gas Station integration
- Programmable Wallet abstraction
- Gasless transactions for better UX

## Technical Approach

### ERC-2771 Standard

[ERC-2771](https://eips.ethereum.org/EIPS/eip-2771) (Secure Protocol for Native Meta Transactions) is the OpenZeppelin standard for meta-transactions. The key insight is that `_msgSender()` handles both direct calls AND meta-transactions transparently:

| Call Type | `msg.sender` | `_msgSender()` |
|-----------|--------------|----------------|
| Direct | User EOA | User EOA |
| Via Forwarder | Forwarder contract | Original user (from calldata) |

### Implementation

Added to `TaskManager.sol`:

```solidity
/// @notice Trusted forwarder for ERC-2771 meta-transactions
address private _trustedForwarder;

function trustedForwarder() public view virtual returns (address) {
    return _trustedForwarder;
}

function isTrustedForwarder(address forwarder) public view virtual returns (bool) {
    return forwarder == _trustedForwarder;
}

function setTrustedForwarder(address forwarder) external onlyOwner {
    _trustedForwarder = forwarder;
}

function _msgSender() internal view virtual override returns (address) {
    uint256 calldataLength = msg.data.length;
    uint256 contextSuffixLength = _contextSuffixLength();
    if (isTrustedForwarder(msg.sender) && calldataLength >= contextSuffixLength) {
        return address(bytes20(msg.data[calldataLength - contextSuffixLength:]));
    }
    return super._msgSender();
}

function _msgData() internal view virtual override returns (bytes calldata) {
    uint256 calldataLength = msg.data.length;
    uint256 contextSuffixLength = _contextSuffixLength();
    if (isTrustedForwarder(msg.sender) && calldataLength >= contextSuffixLength) {
        return msg.data[:calldataLength - contextSuffixLength];
    }
    return super._msgData();
}

function _contextSuffixLength() internal view virtual returns (uint256) {
    return 20; // address length
}
```

All functions that previously used `msg.sender` for sender verification now use `_msgSender()`:
- `checkAllowed()`
- `createRandomTask()`
- `createTask()`
- `verifyInput()`
- `allow()`, `allowGlobal()`, `allowTransient()`, `allowForDecryption()`

## Security Considerations

1. **Trusted Forwarder Only**: Only a single owner-configurable trusted forwarder can append sender addresses to calldata
2. **Backwards Compatible**: Direct calls work exactly as before (when `msg.sender != trustedForwarder`)
3. **Signature Verification**: The trusted forwarder (e.g., OpenZeppelin's `ERC2771Forwarder`) is responsible for verifying user signatures before forwarding

## Migration

1. Deploy updated `TaskManager` implementation
2. Configure trusted forwarder address via `setTrustedForwarder()`
3. Relayers submit transactions through the forwarder contract

## References

- [ERC-2771 Specification](https://eips.ethereum.org/EIPS/eip-2771)
- [OpenZeppelin ERC2771Context](https://docs.openzeppelin.com/contracts/5.x/api/metatx#ERC2771Context)
- [OpenZeppelin ERC2771Forwarder](https://docs.openzeppelin.com/contracts/5.x/api/metatx#ERC2771Forwarder)
