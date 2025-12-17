import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const MODULE_NAME = "DeterministicTM";

export default buildModule(MODULE_NAME, (m) => {
  const taskManager = m.contract(MODULE_NAME, []);
  return { [MODULE_NAME]: taskManager };
});
