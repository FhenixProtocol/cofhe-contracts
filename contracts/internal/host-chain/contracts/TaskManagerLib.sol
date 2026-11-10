// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity >=0.8.25 <0.9.0;

import {ACL} from "./ACL.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {FunctionId, Utils, UnsignedEncryptedInput} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";
import {TMCommon, ITaskManagerErrors as E, ITaskManagerEvents} from "./TaskManagerTypes.sol";

/// @notice TaskManager logic moved out of TaskManager to keep it under the EIP-170 size limit.
///         TaskManager reaches the external functions by delegatecall, so `msg.sender`,
///         `address(this)` and emitted events are TaskManager's. A library cannot be upgraded:
///         a change deploys a new library and a TaskManager implementation linked to it.
library TaskManagerLib {
    /// @dev TaskManager's onlyIfEnabled reads its storage; here the flag comes in as a parameter.
    modifier onlyIfEnabled(bool isEnabled) {
        if (!isEnabled) {
            revert E.CofheIsUnavailable();
        }
        _;
    }

    function sendEventCreated(uint256 ctHash, string memory operation, uint256[] memory inputs, bool isEnabled) private onlyIfEnabled(isEnabled) {
        if (inputs.length == 1) {
            emit ITaskManagerEvents.TaskCreated(ctHash, operation, inputs[0], 0, 0);
        } else if (inputs.length == 2) {
            emit ITaskManagerEvents.TaskCreated(ctHash, operation, inputs[0], inputs[1], 0);
        } else {
            emit ITaskManagerEvents.TaskCreated(ctHash, operation, inputs[0], inputs[1], inputs[2]);
        }
    }

    function checkAllowed(uint256 ctHash, ACL acl) internal view {
        if (!acl.isAllowed(ctHash, msg.sender)) revert E.ACLNotAllowed(ctHash, msg.sender);
    }

    function isUnaryOperation(FunctionId funcId) internal pure returns (bool) {
        return funcId == FunctionId.not || 
               funcId == FunctionId.square || 
               funcId == FunctionId.cast;
    }

    function isPlaintextOperation(FunctionId funcId) internal pure returns (bool) {
        return funcId == FunctionId.random || funcId == FunctionId.trivialEncrypt;
    }

    function getSecurityZone(FunctionId functionId, uint256[] memory encryptedInputs, uint256[] memory plaintextInputs) internal pure returns (int32) {
        if (isPlaintextOperation(functionId)) {
            // If inputs are plaintext (currently trivialEncrypt and random) the security zone will be the last input
            return int32(int256(plaintextInputs[plaintextInputs.length - 1]));
        }

        // First param of a function that receives some encrypted values will always be encrypted
        // Refer to: combineInput for more details
        return TMCommon.getSecurityZoneFromHash(encryptedInputs[0]);

    }

    function isValidSecurityZone(int32 _securityZone, int32 securityZoneMin, int32 securityZoneMax) internal pure returns (bool) {
        return _securityZone >= securityZoneMin && _securityZone <= securityZoneMax;
    }

    function isValidSecurityZone(uint256 _securityZone, int32 securityZoneMin, int32 securityZoneMax) internal pure returns (bool) {
        if (_securityZone > uint256(int256(type(int32).max))) {
            return false;
        }

        return isValidSecurityZone(int32(int256(_securityZone)), securityZoneMin, securityZoneMax);
    }

    function isValidType(uint8 t) internal pure returns (bool) {
        return t == Utils.EUINT8_TFHE ||
               t == Utils.EUINT16_TFHE ||
               t == Utils.EUINT32_TFHE ||
               t == Utils.EUINT64_TFHE ||
               t == Utils.EUINT128_TFHE ||
               t == Utils.EADDRESS_TFHE ||
               t == Utils.EBOOL_TFHE;
    }

    function isValidTypeUint256(uint256 t) internal pure returns (bool) {
        if (t > type(uint8).max) {
            return false;
        }

        return isValidType(uint8(t));
    }

    function validateEncryptedHashes(uint256[] memory encryptedHashes, ACL acl) internal view {
        for (uint8 i = 0; i < encryptedHashes.length; i++) {
            checkAllowed(encryptedHashes[i], acl);
        }
    }

    function validateTrivialEncryptInputs(uint256[] memory extraInputs, int32 securityZoneMin, int32 securityZoneMax) internal pure {
        if (extraInputs[1] > type(uint8).max) {
            revert E.UnsupportedType(extraInputs[1]);
        }

        if (!isValidSecurityZone(extraInputs[2], securityZoneMin, securityZoneMax)) {
            revert E.InvalidSecurityZone(int32(int256(extraInputs[2])), securityZoneMin, securityZoneMax);
        }

        uint256 valueToEncrypt = extraInputs[0];
        uint8 toType = uint8(extraInputs[1]);

        if (toType == Utils.EUINT8_TFHE) {
            if (valueToEncrypt > type(uint8).max) {
                revert E.InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else if (toType == Utils.EUINT16_TFHE) {
            if (valueToEncrypt > type(uint16).max) {
                revert E.InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else if (toType == Utils.EUINT32_TFHE) {
            if (valueToEncrypt > type(uint32).max) {
                revert E.InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else if (toType == Utils.EUINT64_TFHE) {
            if (valueToEncrypt > type(uint64).max) {
                revert E.InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else if (toType == Utils.EUINT128_TFHE) {
            if (valueToEncrypt > type(uint128).max) {
                revert E.InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else if (toType == Utils.EADDRESS_TFHE) {
            if (valueToEncrypt > type(uint160).max) {
                revert E.InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else if (toType == Utils.EBOOL_TFHE) {
            if (valueToEncrypt > 1) {
                revert E.InvalidInputForFunction("trivialEncrypt", toType);
            }
        } else {
            revert E.UnsupportedType(toType);
        }

    }

    // Verifies if a function is a function that supports all types (including select for ifTrue, ifFalse)
    function isAllTypesFunction(FunctionId funcId) internal pure returns (bool) {
        return funcId == FunctionId.select ||
               funcId == FunctionId.eq ||
               funcId == FunctionId.ne ||
               funcId == FunctionId.cast;
    }

    // Verifies if a function is receives ONLY boolean or numeral inputs
    function isBooleanAndNumeralFunction(FunctionId funcId) internal pure returns (bool) {
        return funcId == FunctionId.xor ||
               funcId == FunctionId.and ||
               funcId == FunctionId.or ||
               funcId == FunctionId.not;
    }

    function validateFunctionInputTypes(FunctionId funcId, string memory functionName, uint256[] memory inputs) internal pure {
        if (isAllTypesFunction(funcId)) {
            return;
        }

        if (isBooleanAndNumeralFunction(funcId)) {
            for (uint8 i = 0; i < inputs.length; i++) {
                uint8 inputType = TMCommon.getUintTypeFromHash(inputs[i]);
                if ((inputType ^ Utils.EADDRESS_TFHE) == 0) {
                    revert E.InvalidInputForFunction(functionName, Utils.EADDRESS_TFHE);
                }
            }
        } else {
            // In this case we expect a function that only work with numbers
            for (uint8 i = 0; i < inputs.length; i++) {
                uint8 inputType = TMCommon.getUintTypeFromHash(inputs[i]);
                if ((inputType ^ Utils.EADDRESS_TFHE) == 0 || (inputType ^ Utils.EBOOL_TFHE) == 0) {
                    revert E.InvalidInputForFunction(functionName, inputType);
                }
            }
        }
    }

    function validateEncryptedInputs(uint256[] memory encryptedHashes, FunctionId funcId, string memory functionName, ACL acl, int32 securityZoneMin, int32 securityZoneMax) internal view {

        if (encryptedHashes.length == 0) {
            if (!isPlaintextOperation(funcId)) {
                revert E.InvalidOperationInputs(functionName);
            }
            return;
        }

        if (funcId == FunctionId.select) {
            validateSelectInputs(encryptedHashes);
        } else if (isUnaryOperation(funcId)) {
            if (encryptedHashes.length != 1) {
                revert E.InvalidInputsAmount(functionName, encryptedHashes.length, 1);
            }
        } else {
            if (encryptedHashes.length != 2) {
                revert E.InvalidInputsAmount(functionName, encryptedHashes.length, 2);
            }
            if ((TMCommon.getSecAndTypeFromHash(encryptedHashes[0] ^ encryptedHashes[1])) != 0) {
                revert E.InvalidTypeOrSecurityZone(functionName);
            }
        }

        int32 securityZone = TMCommon.getSecurityZoneFromHash(encryptedHashes[0]);
        if (!isValidSecurityZone(securityZone, securityZoneMin, securityZoneMax)) {
            revert E.InvalidSecurityZone(securityZone, securityZoneMin, securityZoneMax);
        }
        validateEncryptedHashes(encryptedHashes, acl);
        validateFunctionInputTypes(funcId, functionName, encryptedHashes);
    }

    function validateSelectInputs(uint256[] memory encryptedHashes) internal pure {
        if (encryptedHashes.length != 3) {
            revert E.InvalidInputsAmount("select", encryptedHashes.length, 3);
        }
        if ((TMCommon.getSecAndTypeFromHash(encryptedHashes[1] ^ encryptedHashes[2])) != 0) {
            revert E.InvalidTypeOrSecurityZone("select");
        }

        uint8 uintType = TMCommon.getUintTypeFromHash(encryptedHashes[0]);
        if ((uintType ^ Utils.EBOOL_TFHE) != 0) {
            revert E.InvalidInputType(uintType, Utils.EBOOL_TFHE);
        }
    }

    function validateExtraInputs(uint256[] memory extraInputs, FunctionId funcId, string memory functionName, int32 securityZoneMin, int32 securityZoneMax) internal pure {
        // The amount of inputs shouldn't be validated here
        // We validate that the amount of all the inputs (encrypted and plaintext) is not greater than 3
        // And then we validate that the amount of encrypted inputs is correct
        // The above forces the amount of extra inputs to be correct

        if (funcId == FunctionId.trivialEncrypt) {
            validateTrivialEncryptInputs(extraInputs, securityZoneMin, securityZoneMax);
        } else if (funcId == FunctionId.cast) {
            if (!isValidTypeUint256(extraInputs[0])) {
                revert E.UnsupportedType(extraInputs[0]);
            }
        } else {
            revert E.InvalidOperationInputs(functionName);
        }
    }

    function createTask(
        uint8 returnType,
        FunctionId funcId,
        uint256[] memory encryptedHashes,
        uint256[] memory extraInputs,
        ACL acl,
        int32 securityZoneMin,
        int32 securityZoneMax,
        bool isEnabled
    ) external returns (uint256) {
        if (funcId == FunctionId.random) {
            revert E.RandomFunctionNotSupported();
        }

        if (funcId == FunctionId.decrypt) {
            revert E.DecryptFunctionNotSupported();
        }

        if (!isValidType(returnType)) {
            revert E.UnsupportedType(returnType);
        }

        string memory functionName = Utils.functionIdToString(funcId);
        uint256 inputsLength = encryptedHashes.length + extraInputs.length;
        if (inputsLength > 3) {
            revert E.TooManyInputs( functionName, inputsLength, 3 );
        }

        validateEncryptedInputs(encryptedHashes, funcId, functionName, acl, securityZoneMin, securityZoneMax);
        if (extraInputs.length > 0) {
            validateExtraInputs(extraInputs, funcId, functionName, securityZoneMin, securityZoneMax);
        }

        uint256[] memory inputs = TMCommon.combineInputs(encryptedHashes, extraInputs);

        int32 securityZone = getSecurityZone(funcId, encryptedHashes, extraInputs);
        uint256 ctHash = TMCommon.calcPlaceholderKey(returnType, securityZone, inputs, funcId);

        acl.allowTransient(ctHash, msg.sender, address(this));
        sendEventCreated(ctHash, functionName, inputs, isEnabled);

        return ctHash;
    }

    /// @dev Verify decrypt result signature
    /// @dev Skips verification if decryptResultSigner is address(0) (debug mode)
    /// @param shouldRevert If true, reverts on invalid signature; if false, returns false
    function _verifyDecryptResult(
        uint256 ctHash,
        uint256 result,
        bytes calldata signature,
        bool shouldRevert,
        address decryptResultSigner
    ) external view returns (bool) {
        if (decryptResultSigner == address(0)) {
            return true;
        }

        bytes32 messageHash = _computeDecryptResultHash(ctHash, result);
        // slither-disable-next-line unused-return
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(messageHash, signature);

        if (err != ECDSA.RecoverError.NoError || recovered == address(0)) {
            if (shouldRevert) revert E.InvalidSignature();
            return false;
        }
        if (recovered != decryptResultSigner) {
            if (shouldRevert) revert E.InvalidSigner(recovered, decryptResultSigner);
            return false;
        }
        return true;
    }

    /// @dev Compute message hash using assembly for gas efficiency
    /// @notice Format: result (32) || enc_type (4) || chain_id (8) || ct_hash (32) = 76 bytes
    function _computeDecryptResultHash(
        uint256 ctHash,
        uint256 result
    ) private view returns (bytes32 messageHash) {
        uint8 encryptionType = TMCommon.getUintTypeFromHash(ctHash);
        uint64 chainId = uint64(block.chainid);

        // Load constants for assembly
        uint256 shiftEncType = TMCommon.SHIFT_ENC_TYPE;
        uint256 shiftChainId = TMCommon.SHIFT_CHAIN_ID;
        uint256 offsetEncType = TMCommon.OFFSET_ENC_TYPE;
        uint256 offsetChainId = TMCommon.OFFSET_CHAIN_ID;
        uint256 offsetCtHash = TMCommon.OFFSET_CT_HASH;
        uint256 msgLength = TMCommon.MESSAGE_LENGTH;

        // Assembly for gas-efficient message construction
        // Overlapping 32-byte mstores are safe here: each subsequent mstore overwrites
        // only the tail bytes of the previous one, and the final mstore (ctHash) lands
        // exactly at the end of the 76-byte message, so all fields end up correctly placed.
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, result)                                            // bytes 0-31: result
            mstore(add(ptr, offsetEncType), shl(shiftEncType, encryptionType))  // bytes 32-35: enc_type
            mstore(add(ptr, offsetChainId), shl(shiftChainId, chainId))         // bytes 36-43: chain_id
            mstore(add(ptr, offsetCtHash), ctHash)                              // bytes 44-75: ctHash
            messageHash := keccak256(ptr, msgLength)                            // hash 76 bytes
            mstore(0x40, add(ptr, msgLength))                                   // advance free memory pointer
        }
    }

    /// @notice Verify a batch of encrypted inputs that share a single signature.
    /// @dev The only input-verification entry point: a single input is a batch of one.
    ///      The verifier signs the whole batch with one signature over
    ///      keccak256(h_0 || h_1 || ... || h_n), where each h_i is the per-input
    ///      message hash
    ///      keccak256(ctHash || utype || securityZone || sender || chainid || contractAddress).
    ///      The batch is bound to the consuming contract (`msg.sender`), so it
    ///      cannot be replayed into a different contract.
    ///      Inputs are processed in order; the returned hashes line up with `inputs`.
    ///      Emits one `InputVerified` per input, in input order — the same event
    ///      the single-input flow emitted, so the commitment relay reads a batch
    ///      as N independent verified inputs and needs no batch-aware decoding.
    /// @param inputs The encrypted inputs to verify (no per-input signature —
    ///        the batch is authenticated by the single `signature` argument).
    /// @param sender The account the inputs are bound to.
    /// @param signature The single ECDSA signature covering the whole batch.
    /// @return appendedHashes The metadata-appended ct hashes, in input order.
    function batchVerifyInputs(
        UnsignedEncryptedInput[] memory inputs,
        address sender,
        bytes memory signature,
        address verifierSigner,
        int32 securityZoneMin,
        int32 securityZoneMax,
        ACL acl
    ) external returns (uint256[] memory) {
        uint256 len = inputs.length;
        // When signer is set to 0 address we skip this logic to be able to support debug use cases.
        // In debug use cases we assume that the verifier is not necessarily running.
        if (verifierSigner != address(0)) {
            for (uint256 i = 0; i < len; i++) {
                int32 securityZone = int32(uint32(inputs[i].securityZone));
                if (!isValidSecurityZone(securityZone, securityZoneMin, securityZoneMax)) {
                    revert E.InvalidSecurityZone(securityZone, securityZoneMin, securityZoneMax);
                }
            }

            address signer = extractBatchSigner(inputs, sender, msg.sender, signature);
            if (signer != verifierSigner) {
                revert E.InvalidSigner(signer, verifierSigner);
            }
        }

        uint256[] memory appendedHashes = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            int32 securityZone = int32(uint32(inputs[i].securityZone));
            appendedHashes[i] =
                TMCommon.appendMetadata(inputs[i].ctHash, securityZone, inputs[i].utype, false);
            emit ITaskManagerEvents.InputVerified(appendedHashes[i], bytes32(inputs[i].ctHash));
        }

        acl.batchAllowTransient(appendedHashes, msg.sender, address(this));

        return appendedHashes;
    }

    /// @dev Per-input message hash folded into the batch digest:
    ///      keccak256(ctHash || utype || securityZone || sender || chainid || contractAddress).
    function inputMessageHash(
        uint256 ctHash,
        uint8 utype,
        uint8 securityZone,
        address sender,
        address contractAddress
    ) private view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                ctHash,
                utype,
                securityZone,
                sender,
                block.chainid,
                contractAddress
            )
        );
    }

    /// @dev Recover the signer of a batch from the single signature over
    ///      keccak256(h_0 || h_1 || ... || h_n), where each h_i is `inputMessageHash`.
    function extractBatchSigner(
        UnsignedEncryptedInput[] memory inputs,
        address sender,
        address contractAddress,
        bytes memory signature
    ) private view returns (address) {
        uint256 len = inputs.length;
        // One allocation of 32*len bytes, each hash written in place, so the
        // buffer is not reallocated and recopied once per input.
        bytes memory concatenatedHashes = new bytes(len * 32);
        for (uint256 i = 0; i < len; i++) {
            bytes32 h = inputMessageHash(inputs[i].ctHash, inputs[i].utype, inputs[i].securityZone, sender, contractAddress);
            assembly ("memory-safe") {
                mstore(add(add(concatenatedHashes, 32), mul(i, 32)), h)
            }
        }

        bytes32 batchHash = keccak256(concatenatedHashes);

        address signer = ECDSA.recover(batchHash, signature);
        if (signer == address(0)) {
            revert E.InvalidSignature();
        }

        return signer;
    }
}
