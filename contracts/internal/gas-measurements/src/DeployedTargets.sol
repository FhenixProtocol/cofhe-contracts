// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity 0.8.25;

// Pulls the host-chain contracts into the build, so script/check_deployed.py can
// compare their artifacts with the deployed bytecode.
import {TaskManager} from "@host-chain/TaskManager.sol";
import {ACL} from "@host-chain/ACL.sol";
import {PlaintextsStorage} from "@host-chain/PlaintextsStorage.sol";
