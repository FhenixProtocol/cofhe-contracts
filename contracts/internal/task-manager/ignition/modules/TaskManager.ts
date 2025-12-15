import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const MODULE_NAME = "TaskManager";

export default buildModule(MODULE_NAME, m => {
  const taskManager = m.contract(MODULE_NAME, []);
  return { [MODULE_NAME]: taskManager };
});
