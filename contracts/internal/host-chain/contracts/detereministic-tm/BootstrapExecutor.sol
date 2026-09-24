// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;

/**
 * @title  BootstrapExecutor
 * @notice EIP-7702 delegate for the canonical bootstrap owner, so the whole TaskManager bootstrap
 *         runs in one transaction paid for by someone else.
 *
 * @dev    The canonical TaskManager proxy address derives from init code that embeds
 *         `DeterministicTM.initialize(BOOTSTRAP_OWNER)`, where BOOTSTRAP_OWNER is an
 *         intentionally-public dev key. The address cannot be kept without that account being the
 *         proxy's initial owner, and only that account can move ownership on.
 *
 *         Funding it is not an option: a hostile EIP-7702 delegation on mainnet forwards any
 *         incoming value straight out, so a plain transfer is swept inside the funding
 *         transaction itself. Instead the bootstrap key signs an *authorization* - free, offline,
 *         no balance required - naming this contract, and the sponsor sends the transaction.
 *         Delegated code executes with `msg.sender == BOOTSTRAP_OWNER`, which is all the
 *         `onlyOwner` checks require.
 *
 *         Doing both steps here rather than as separate transactions also removes the window the
 *         direct path cannot close: the proxy is created and migrated off the Ownable stub in one
 *         transaction, so it is never observable as a live proxy owned by a public key.
 *
 *         The sponsor check is hygiene, not a security boundary - anyone can already act as
 *         BOOTSTRAP_OWNER by signing with the published key. It exists so a stray call cannot
 *         drive this contract with arguments of its own choosing while the delegation is
 *         installed.
 */
contract BootstrapExecutor {
    /// @notice Thrown when someone other than the configured sponsor calls `bootstrap`.
    error NotSponsor(address caller);
    /// @notice Thrown when the CreateX deployment reverts; carries CreateX's own revert data.
    error CreationFailed(bytes reason);
    /// @notice Thrown when CreateX reports success but the canonical address still has no code.
    error ProxyMissing(address proxy);
    /// @notice Thrown when `upgradeToAndCall` reverts; carries the proxy's own revert data.
    error UpgradeFailed(bytes reason);

    /// @notice The only account allowed to drive this executor.
    address public immutable sponsor;

    /// @param initialSponsor The only account allowed to call `bootstrap`; normally the deployer.
    constructor(address initialSponsor) {
        sponsor = initialSponsor;
    }

    /**
     * @notice Creates the canonical proxy (if it does not exist yet) and migrates it off the
     *         bootstrap stub, both as BOOTSTRAP_OWNER.
     *
     * @dev    Idempotent on the creation half: a proxy already at `proxy` is left alone, so a run
     *         that died after creation can be completed. The upgrade half is not idempotent -
     *         `initializeV2` is a `reinitializer(2)` and reverts on a second run - so the caller
     *         is expected to skip this entirely once the proxy reports a default admin.
     *
     * @param createX        CreateX factory address.
     * @param salt           Deterministic salt; deployer-agnostic, so it produces the canonical
     *                       address regardless of who sends the transaction.
     * @param initCode       ERC1967Proxy creation code with its constructor arguments.
     * @param proxy          The canonical address `initCode` is expected to land on.
     * @param implementation The role-based TaskManager implementation to upgrade to.
     * @param migrationData  Encoded `initializeV2(admin, delay)` call, run inside the upgrade.
     */
    function bootstrap(
        address createX,
        bytes32 salt,
        bytes calldata initCode,
        address proxy,
        address implementation,
        bytes calldata migrationData
    ) external {
        if (msg.sender != sponsor) {
            revert NotSponsor(msg.sender);
        }

        if (proxy.code.length == 0) {
            // Low-level on purpose, here and below: there is no interface worth importing for a
            // single call, and the raw return data is what makes a failure diagnosable - CreateX
            // and the proxy both revert with information the operator needs.
            // solhint-disable-next-line avoid-low-level-calls
            (bool created, bytes memory creationReason) = createX.call(
                abi.encodeWithSignature("deployCreate2(bytes32,bytes)", salt, initCode)
            );
            if (!created) {
                revert CreationFailed(creationReason);
            }
            if (proxy.code.length == 0) {
                revert ProxyMissing(proxy);
            }
        }

        // Runs as BOOTSTRAP_OWNER, satisfying both `DeterministicTM._authorizeUpgrade` (onlyOwner)
        // and `TaskManager.initializeV2`'s legacy-owner check in the same call.
        // solhint-disable-next-line avoid-low-level-calls
        (bool upgraded, bytes memory upgradeReason) = proxy.call(
            abi.encodeWithSignature("upgradeToAndCall(address,bytes)", implementation, migrationData)
        );
        if (!upgraded) {
            revert UpgradeFailed(upgradeReason);
        }
    }
}
