// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {COFHE_ADDRESS_BOOK} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {FactoryRegistry} from "contracts/FactoryRegistry.sol";

// Gas measurement of FactoryRegistry with a stand-in TaskManager. Run: forge test -vv
// setUp builds each tree in its own transaction, and each test makes ONE measured call, so storage
// starts cold and unwritten as in a real transaction. Logged numbers add the 21,000 transaction base.

interface Vm {
    function prank(address) external;
    function etch(address, bytes calldata) external;
}

library console {
    address constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;

    function log(string memory s, uint256 v) internal view {
        (bool ok,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string,uint256)", s, v));
        ok;
    }
}

/// @dev Only the access-list part of the TaskManager. The role check is one storage read, the same
///      cost as AccessControl's hasRole.
contract TaskManagerStandIn {
    mapping(address => bool) public accessList;
    address public listManager;

    event AccessGranted(address indexed account);
    event AccessRevoked(address indexed account);

    function setListManager(address m) external {
        listManager = m;
    }

    function addToAccessList(address[] calldata accounts) external {
        require(msg.sender == listManager, "role");
        for (uint256 i = 0; i < accounts.length; i++) {
            require(accounts[i] != address(0), "zero");
            accessList[accounts[i]] = true;
            emit AccessGranted(accounts[i]);
        }
    }

    function removeFromAccessList(address[] calldata accounts) external {
        require(msg.sender == listManager, "role");
        for (uint256 i = 0; i < accounts.length; i++) {
            require(accounts[i] != address(0), "zero");
            accessList[accounts[i]] = false;
            emit AccessRevoked(accounts[i]);
        }
    }
}

/// @dev Etched at the fixed address-book address. The TaskManager address lives in the code, so it
///      survives the etch.
contract AddressBookStandIn {
    address immutable tm;

    constructor(address t) {
        tm = t;
    }

    function getTm(uint256) external view returns (address) {
        return tm;
    }
}

abstract contract RegistryGasBase {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant TX_BASE = 21_000;
    uint256 constant TX_CAP = 16_777_216; // EIP-7825

    TaskManagerStandIn tm;
    FactoryRegistry reg;
    address constant F = address(0xF0);

    /// @dev Sub-factories under F; 0 puts every worker directly under F.
    function managers() internal pure virtual returns (uint256) {
        return 0;
    }

    /// @dev Workers under F, or under each sub-factory.
    function workersEach() internal pure virtual returns (uint256) {
        return 0;
    }

    function addr(uint256 i) internal pure returns (address) {
        return address(uint160(0x100000 + i));
    }

    function setUp() public virtual {
        tm = new TaskManagerStandIn();
        vm.etch(COFHE_ADDRESS_BOOK, address(new AddressBookStandIn(address(tm))).code);
        FactoryRegistry impl = new FactoryRegistry();
        reg = FactoryRegistry(
            address(new ERC1967Proxy(address(impl), abi.encodeCall(FactoryRegistry.initialize, (address(this), 0))))
        );
        tm.setListManager(address(reg));
        reg.approveFactory(F);

        uint256 m = managers();
        if (m == 0) {
            _registerMany(F, 0, workersEach());
        } else {
            address[] memory subs = new address[](m);
            for (uint256 i = 0; i < m; i++) subs[i] = addr(900_000 + i);
            vm.prank(F);
            reg.register(subs);
            for (uint256 i = 0; i < m; i++) _registerMany(subs[i], (i + 1) * 10_000, workersEach());
        }
    }

    function _registerMany(address parent, uint256 offset, uint256 count) internal {
        for (uint256 done = 0; done < count; ) {
            uint256 batch = count - done > 100 ? 100 : count - done;
            address[] memory kids = new address[](batch);
            for (uint256 i = 0; i < batch; i++) kids[i] = addr(offset + done + i);
            vm.prank(parent);
            reg.register(kids);
            done += batch;
        }
    }

    function _register(uint256 n) internal returns (uint256 txGas) {
        address[] memory kids = new address[](n);
        for (uint256 i = 0; i < n; i++) kids[i] = addr(700_000 + i);
        vm.prank(F);
        uint256 g = gasleft();
        reg.register(kids);
        txGas = g - gasleft() + TX_BASE;
    }

    function _unregister(address target) internal returns (uint256 txGas) {
        uint256 g = gasleft();
        reg.unregister(target);
        txGas = g - gasleft() + TX_BASE;
        require(!tm.accessList(target), "still listed");
    }
}

contract FactoryRegistryRegisterGas is RegistryGasBase {
    function test_register_1() public {
        console.log("register 1 in one call: tx gas", _register(1));
    }

    function test_register_5() public {
        console.log("register 5 in one call: tx gas", _register(5));
    }

    function test_register_10() public {
        console.log("register 10 in one call: tx gas", _register(10));
    }

    function test_register_100() public {
        uint256 txGas = _register(100);
        console.log("register 100 in one call: tx gas", txGas);
        console.log("  per contract", txGas / 100);
    }
}

contract FactoryRegistryUnregisterOneGas is RegistryGasBase {
    function workersEach() internal pure override returns (uint256) {
        return 100;
    }

    function test_unregister_1() public {
        console.log("unregister 1 (swap and pop in a list of 100): tx gas", _unregister(addr(10)));
    }
}

contract FactoryRegistryUnregisterFiveGas is RegistryGasBase {
    function managers() internal pure override returns (uint256) {
        return 1;
    }

    function workersEach() internal pure override returns (uint256) {
        return 4;
    }

    function test_unregister_5() public {
        console.log("unregister 5 in one call: tx gas", _unregister(addr(900_000)));
    }
}

contract FactoryRegistryUnregisterTenGas is RegistryGasBase {
    function managers() internal pure override returns (uint256) {
        return 1;
    }

    function workersEach() internal pure override returns (uint256) {
        return 9;
    }

    function test_unregister_10() public {
        console.log("unregister 10 in one call: tx gas", _unregister(addr(900_000)));
    }
}

/// @dev The worst shape for unregister: 62 chains of depth 8 (496 contracts). Almost every node has
///      a non-empty child list to delete, which flat trees never measure.
contract FactoryRegistryDeepTreeGas is RegistryGasBase {
    function setUp() public override {
        super.setUp();
        for (uint256 c = 0; c < 62; c++) {
            address parent = F;
            for (uint256 level = 1; level <= 8; level++) {
                address child = addr(c * 16 + level);
                address[] memory one = new address[](1);
                one[0] = child;
                vm.prank(parent);
                reg.register(one);
                parent = child;
            }
        }
    }

    function test_unregister_full_deep_tree_496() public {
        uint256 txGas = _unregister(F);
        console.log("unregister 62 chains of depth 8 (496): tx gas", txGas);
        console.log("  room under the 2^24 cap", TX_CAP - txGas);
        require(txGas < TX_CAP, "exceeds Ethereum's per-transaction gas cap");
    }
}

/// @dev One batch of the suspend path: the size the revoke task sends per transaction.
contract FactoryRegistrySuspendGas is RegistryGasBase {
    function workersEach() internal pure override returns (uint256) {
        return 1_400;
    }

    function test_suspend_batch_1500() public {
        address[] memory batch = new address[](1_400);
        batch[0] = F;
        for (uint256 i = 1; i < 1_400; i++) batch[i] = addr(i);
        uint256 g = gasleft();
        reg.suspend(F, batch);
        uint256 txGas = g - gasleft() + TX_BASE + 1_400 * 368; // calldata: 20 non-zero + 12 zero bytes each
        console.log("suspend a batch of 1,400: tx gas", txGas);
        console.log("  per contract", txGas / 1_400);
        console.log("  room under the 2^24 cap", TX_CAP - txGas);
        require(txGas < TX_CAP, "exceeds Ethereum's per-transaction gas cap");
        require(!tm.accessList(addr(1_399)), "still listed");
    }
}

contract FactoryRegistryFullTreeGas is RegistryGasBase {
    function workersEach() internal pure override returns (uint256) {
        return 500;
    }

    function test_unregister_full_tree_500() public {
        uint256 txGas = _unregister(F);
        console.log("unregister a full tree of 500: tx gas", txGas);
        console.log("  room under the 2^24 cap", TX_CAP - txGas);
        require(txGas < TX_CAP, "exceeds Ethereum's per-transaction gas cap");
    }
}
