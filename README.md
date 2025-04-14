# cofhe-contracts [![NPM Package][npm-badge]][npm] [![License: MIT][license-badge]][license]

[npm]: https://www.npmjs.com/package/@fhenixprotocol/cofhe-contracts
[npm-badge]: https://img.shields.io/npm/v/@fhenixprotocol/cofhe-contracts.svg
[license]: https://opensource.org/licenses/MIT
[license-badge]: https://img.shields.io/badge/License-MIT-blue.svg

Solidity contracts for working with FHE smart contract on CoFHE.

Need help getting started? Check out the [fhenix documentation](https://docs.fhenix.io)!

These contracts are still under heavy constructions and will be changing frequently. Consider binding your contracts to a specific version, and keep an eye on the [changelog](https://github.com/FhenixProtocol/cofhe-contracts/CHANGELOG.md)

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
pragma solidity ^0.8.20;

import {FHE, euint8, inEuint8} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract Example {
    
    euint8 _output;

    function setOutput(inEuint8 calldata _encryptedNumber) public  {
        _output = FHE.asEuint8(_encryptedNumber);
    }

    function getOutputEncrypted(bytes32 publicKey) public view returns (bytes memory) {
        return _output.seal(publicKey);
    }
}
```

## License

This project is licensed under MIT.
