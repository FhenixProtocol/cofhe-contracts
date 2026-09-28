// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

/**
 * @title  CoFHEAddressBook
 * @notice The one fixed CoFHE address on every chain. Maps a TaskManager id to the TaskManager
 *         proxy that FHE.sol releases pinned to that id talk to, so TaskManager versions can
 *         coexist on one chain and a version can be retired by unsetting its id.
 */
contract CoFHEAddressBook is Initializable, UUPSUpgradeable, Ownable2StepUpgradeable {
    /// @custom:storage-location erc7201:cofhe.storage.AddressBook
    struct AddressBookStorage {
        mapping(uint256 id => address tm) taskManagers;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("cofhe.storage.AddressBook")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ADDRESS_BOOK_SLOT =
        0x5550948566c8f8ba2bf3a272ef3a15db4f9d75ecc8ac4f5ceb62099809570600;

    /// @notice          Emitted when an id is set or unset (`current == address(0)`).
    /// @param id        TaskManager id.
    /// @param previous  Address the id resolved to before, zero if it was unset.
    /// @param current   Address the id resolves to now, zero if it was unset.
    event TaskManagerSet(uint256 indexed id, address indexed previous, address indexed current);

    /// @notice     Returned when an id resolves to nothing.
    /// @param id   TaskManager id.
    error TaskManagerNotSet(uint256 id);

    /// @notice Returned when setting an id to the zero address.
    error InvalidAddress();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param initialOwner  The account allowed to set ids and upgrade the book.
    function initialize(address initialOwner) external initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
    }

    /// @notice     Resolves an id to its TaskManager.
    /// @param id   TaskManager id.
    /// @return tm  The TaskManager address; reverts with {TaskManagerNotSet} when unset.
    function getTm(uint256 id) external view returns (address tm) {
        tm = _s().taskManagers[id];
        if (tm == address(0)) {
            revert TaskManagerNotSet(id);
        }
    }

    /// @notice     Points an id at a TaskManager, replacing any previous target.
    /// @param id   TaskManager id.
    /// @param tm   TaskManager address.
    function setTm(uint256 id, address tm) external onlyOwner {
        if (tm == address(0)) {
            revert InvalidAddress();
        }
        AddressBookStorage storage $ = _s();
        emit TaskManagerSet(id, $.taskManagers[id], tm);
        $.taskManagers[id] = tm;
    }

    /// @notice     Retires an id: every FHE.sol build pinned to it reverts from then on.
    /// @param id   TaskManager id.
    function unsetTm(uint256 id) external onlyOwner {
        AddressBookStorage storage $ = _s();
        address previous = $.taskManagers[id];
        if (previous == address(0)) {
            revert TaskManagerNotSet(id);
        }
        emit TaskManagerSet(id, previous, address(0));
        delete $.taskManagers[id];
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function _s() private pure returns (AddressBookStorage storage $) {
        bytes32 slot = ADDRESS_BOOK_SLOT;
        // slither-disable-next-line assembly
        assembly {
            $.slot := slot
        }
    }
}
