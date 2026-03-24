import { shouldBehaveLikeCommitmentRegistry } from "./CommitmentRegistry.behavior";
import { deployCommitmentRegistryFixture } from "./CommitmentRegistry.fixture";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("CommitmentRegistry Tests", function () {
  beforeEach(async function () {
    const fixture = await loadFixture(deployCommitmentRegistryFixture);
    this.registry = fixture.registry;
    this.owner = fixture.owner;
    this.poster = fixture.poster;
    this.otherAccount = fixture.otherAccount;
  });

  describe("CommitmentRegistry", function () {
    shouldBehaveLikeCommitmentRegistry();
  });
});
