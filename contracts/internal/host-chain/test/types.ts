import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

type Fixture<T> = () => Promise<T>;

declare module "mocha" {
  export interface Context {
    loadFixture: <T>(fixture: Fixture<T>) => Promise<T>;
    signers: Signers;
  }
}

export interface Signers {
  admin: HardhatEthersSigner;
}
