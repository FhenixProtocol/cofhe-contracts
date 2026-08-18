// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;

/// @notice Returned when a migration re-initializer is called by anyone other than the owner
///         recorded in the abandoned Ownable storage namespace.
/// @param caller       The caller.
/// @param legacyOwner  The owner the pre-roles implementation left behind.
error NotLegacyOwner(address caller, address legacyOwner);

/**
 * @title  LegacyOwnable
 * @notice Reads the owner left behind in the `openzeppelin.storage.Ownable` ERC-7201 namespace by
 *         a pre-roles `Ownable*Upgradeable` implementation.
 * @dev    `initializeV2` cannot be gated with `onlyRole` - it exists precisely because the
 *         AccessControl namespace is still empty, so there is no role holder to check against.
 *         The inherited `AccessControlDefaultAdminRules._grantRole` guard only reverts once
 *         `defaultAdmin() != address(0)`, which is exactly the state `initializeV2` has yet to
 *         create. The legacy owner is the only authority that exists in that window, and it is
 *         the same account the old `_authorizeUpgrade` (`onlyOwner`) required, so gating on it
 *         adds no new key to the upgrade procedure.
 *
 *         A sibling copy of this logic lives in
 *         `registry-chain/contracts/commitment-registry/LegacyOwnable.sol` - the two projects have
 *         no shared package. Keep them identical.
 */
library LegacyOwnable {
    /// @dev keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Ownable")) - 1)) & ~bytes32(uint256(0xff))
    ///      Matches `OwnableUpgradeable.OwnableStorageLocation` in OpenZeppelin 5.2.0.
    bytes32 internal constant OWNABLE_STORAGE_SLOT =
        0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300;

    /// @dev Returns the owner recorded by the pre-roles implementation, or address(0) when the
    ///      proxy never ran one (a fresh deployment through `initialize`).
    function owner() internal view returns (address legacyOwner) {
        bytes32 slot = OWNABLE_STORAGE_SLOT;
        // slither-disable-next-line assembly
        assembly {
            legacyOwner := sload(slot)
        }
    }

    /// @dev Reverts unless `caller` is the legacy owner. A zero legacy owner can never be matched,
    ///      so freshly deployed proxies reject the migration path outright.
    function requireLegacyOwner(address caller) internal view {
        address legacyOwner = owner();
        if (caller != legacyOwner || legacyOwner == address(0)) {
            revert NotLegacyOwner(caller, legacyOwner);
        }
    }
}
