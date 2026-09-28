// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";

interface IExecutor {
    function getInputVerifierAddress() external view returns (address);
    function getACLAddress() external view returns (address);
    function getHCULimitAddress() external view returns (address);
    function getVersion() external view returns (string memory);
}

interface IOwnable {
    function owner() external view returns (address);
}

interface IInputVerifier {
    function getCoprocessorSigners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function defineNewContext(address[] memory newSignersSet, uint256 newThreshold) external;
    function eip712Domain()
        external
        view
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory);
}

bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
uint8 constant UINT64 = 5; // FheType.Uint64

/// Forks a Zama host chain and swaps the coprocessor input signers for throwaway keys, keeping the
/// live signer count and threshold, so each proof carries as many signatures as on the real chain.
abstract contract ZamaForkBase is Test {
    IExecutor internal executor;
    IInputVerifier internal verifier;
    address internal acl;
    uint256 internal forkBlock;
    uint256[] internal signerKeys;
    uint256 internal threshold;
    uint256 internal nonce;

    function _fork(string memory chain, address executorAddress) internal {
        bytes memory latest = vm.rpc(chain, "eth_blockNumber", "[]");
        forkBlock = uint256(bytes32(latest)) >> (8 * (32 - latest.length));
        vm.createSelectFork(chain, forkBlock);
        executor = IExecutor(executorAddress);
        verifier = IInputVerifier(executor.getInputVerifierAddress());
        acl = executor.getACLAddress();
    }

    function _takeOverSigners() internal {
        uint256 count = verifier.getCoprocessorSigners().length;
        threshold = verifier.getThreshold();
        require(count > 0 && threshold > 0, "no live signers");
        address[] memory signers = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            signerKeys.push(uint256(keccak256(abi.encode("pro-575-zama-signer", i))));
            signers[i] = vm.addr(signerKeys[i]);
        }
        vm.prank(IOwnable(acl).owner());
        verifier.defineNewContext(signers, threshold);
        assertEq(verifier.getCoprocessorSigners()[0], signers[0]);
    }

    /// A fresh euint64 input handle and its proof: [1 handle][threshold signatures][handle][sigs][extraData].
    function _input(address user, address consumer) internal returns (bytes32 handle, bytes memory proof) {
        bytes32 hash21 = keccak256(abi.encode("pro-575-zama-input", nonce++));
        handle = (hash21 & ~bytes32(uint256(type(uint88).max))) | bytes32(uint256(uint64(block.chainid)) << 16)
            | bytes32(uint256(UINT64) << 8);
        bytes memory extraData = hex"00";
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = handle;
        bytes32 digest = _digest(handles, user, consumer, extraData);
        proof = abi.encodePacked(uint8(1), uint8(threshold), handle);
        for (uint256 i = 0; i < threshold; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKeys[i], digest);
            proof = abi.encodePacked(proof, r, s, v);
        }
        proof = abi.encodePacked(proof, extraData);
    }

    // Mirrors InputVerifier._hashEIP712InputVerification with the live EIP-712 domain.
    function _digest(bytes32[] memory handles, address user, address consumer, bytes memory extraData)
        internal
        view
        returns (bytes32)
    {
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = verifier.eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "CiphertextVerification(bytes32[] ctHandles,address userAddress,address contractAddress,uint256 contractChainId,bytes extraData)"
                ),
                keccak256(abi.encodePacked(handles)),
                user,
                consumer,
                block.chainid,
                keccak256(extraData)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _impl(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
    }
}
