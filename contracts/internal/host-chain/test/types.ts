import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Contract, Wallet } from "ethers";

type Fixture<T> = () => Promise<T>;

declare module "mocha" {
  export interface Context {
    loadFixture: <T>(fixture: Fixture<T>) => Promise<T>;
    signers: Signers;
    // DecryptResult test context
    taskManager?: Contract;
    plaintextsStorage?: Contract;
    owner?: HardhatEthersSigner;
    testSigner?: Wallet;
    otherAccount?: HardhatEthersSigner;
    originalSigner?: string;
  }
}

export interface Signers {
  admin: HardhatEthersSigner;
}
