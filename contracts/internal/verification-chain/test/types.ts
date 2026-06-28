import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Contract } from "ethers";

type Fixture<T> = () => Promise<T>;

declare module "mocha" {
  export interface Context {
    loadFixture: <T>(fixture: Fixture<T>) => Promise<T>;
    signers: Signers;
    verificationRegistry?: Contract;
    owner?: HardhatEthersSigner;
    otherAccount?: HardhatEthersSigner;
  }
}

export interface Signers {
  admin: HardhatEthersSigner;
}
