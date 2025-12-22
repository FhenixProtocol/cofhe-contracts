import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import type { IgnitionModuleBuilder } from "@nomicfoundation/ignition-core";

const MODULE_NAME = "DeterministicTM";

export default buildModule(MODULE_NAME, (m: IgnitionModuleBuilder) => {
  const taskManager = m.contract(MODULE_NAME, []);
  return { [MODULE_NAME]: taskManager };
});
