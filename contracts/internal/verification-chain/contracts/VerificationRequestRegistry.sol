// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.25;

contract VerificationRequestRegistry {
    /*//////////////////////////////////////////////////////////////
                            TYPE DECLARATIONS
    //////////////////////////////////////////////////////////////*/

    struct VerificationRequest {
        string ipfsCid;
        bytes32[] ctHashes;
        int8 securityZone;
        uint256 chainId;
        address submitter;
    }

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 private constant MAX_CT_HASHES = 100;

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    VerificationRequest[] private s_requests;
    mapping(bytes32 => uint256) private s_ctHashToRequestId;

    /*//////////////////////////////////////////////////////////////
                            EVENTS & ERRORS
    //////////////////////////////////////////////////////////////*/

    event VerificationRequestSubmitted(
        address indexed submitter,
        string ipfsCid,
        bytes32[] ctHashes,
        int8 securityZone,
        uint256 chainId
    );

    error VerificationRequestRegistry__EmptyIPFSCid();
    error VerificationRequestRegistry__EmptyCTHashes();
    error VerificationRequestRegistry__TooManyCTHashes(uint256 length, uint256 max);
    error VerificationRequestRegistry__DuplicateCTHash(bytes32 ctHash);
    error VerificationRequestRegistry__CTHashNotFound();
    error VerificationRequestRegistry__RequestNotFound(uint256 id);

    /*//////////////////////////////////////////////////////////////
                        USER-FACING STATE-CHANGING
    //////////////////////////////////////////////////////////////*/

    function submitRequest(
        string calldata ipfsCid,
        bytes32[] calldata ctHashes,
        int8 securityZone,
        uint256 chainId
    ) external {
        if (bytes(ipfsCid).length == 0) revert VerificationRequestRegistry__EmptyIPFSCid();
        if (ctHashes.length == 0) revert VerificationRequestRegistry__EmptyCTHashes();
        if (ctHashes.length > MAX_CT_HASHES) revert VerificationRequestRegistry__TooManyCTHashes(ctHashes.length, MAX_CT_HASHES);

        s_requests.push();
        uint256 index = s_requests.length - 1;
        VerificationRequest storage req = s_requests[index];
        req.ipfsCid = ipfsCid;
        req.ctHashes = ctHashes;
        req.securityZone = securityZone;
        req.chainId = chainId;
        req.submitter = msg.sender;

        for (uint256 i = 0; i < ctHashes.length; i++) {
            if (s_ctHashToRequestId[ctHashes[i]] != 0) {
                revert VerificationRequestRegistry__DuplicateCTHash(ctHashes[i]);
            }
            s_ctHashToRequestId[ctHashes[i]] = index + 1;
        }

        emit VerificationRequestSubmitted(
            msg.sender, ipfsCid, ctHashes, securityZone, chainId
        );
    }

    /*//////////////////////////////////////////////////////////////
                          USER-FACING READ-ONLY
    //////////////////////////////////////////////////////////////*/

    function getRequestByCTHash(bytes32 ctHash)
        external view returns (VerificationRequest memory request)
    {
        uint256 stored = s_ctHashToRequestId[ctHash];
        if (stored == 0) revert VerificationRequestRegistry__CTHashNotFound();
        request = s_requests[stored - 1];
    }

    function getRequestById(uint256 id)
        external view returns (VerificationRequest memory request)
    {
        if (id >= s_requests.length) revert VerificationRequestRegistry__RequestNotFound(id);
        request = s_requests[id];
    }

    function getRequestCount() external view returns (uint256 count) {
        count = s_requests.length;
    }
}
