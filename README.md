# cofhe-contracts [![NPM Package][npm-badge]][npm] [![License: MIT][license-badge]][license]

[npm]: https://www.npmjs.com/package/@fhenixprotocol/cofhe-contracts
[npm-badge]: https://img.shields.io/npm/v/@fhenixprotocol/cofhe-contracts.svg
[license]: https://opensource.org/licenses/MIT
[license-badge]: https://img.shields.io/badge/License-MIT-blue.svg

Solidity contracts for working with FHE smart contracts on CoFHE.

Need help getting started? Check out the [Fhenix documentation](https://cofhe-docs.fhenix.zone)!

These contracts are still under heavy construction and will be changing frequently. Consider binding your contracts to a specific version

## Install

```
npm install @fhenixprotocol/cofhe-contracts
```

## Usage

Import `FHE.sol` or any of the helper contracts

```solidity
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
```

## Example

```solidity
pragma solidity ^0.8.25;

import {FHE, euint8, externalEuint8} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract Example {
    euint8 _output;

    function setOutput(externalEuint8 encryptedNumber, bytes calldata inputProof) public {
        _output = FHE.asEuint8(encryptedNumber, inputProof);
        FHE.allowThis(_output);
    }
}
```

## License

This project is licensed under MIT.
