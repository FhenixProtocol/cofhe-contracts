import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import type { IgnitionModuleBuilder } from "@nomicfoundation/ignition-core";

const MODULE_NAME = "ERC1967Proxy";

export default buildModule(MODULE_NAME, (m: IgnitionModuleBuilder) => {
  const implementation = m.getParameter("implementation");
  const data = m.getParameter("data");
  const erc1967Proxy = m.contract(MODULE_NAME, [implementation, data]);
  return { [MODULE_NAME]: erc1967Proxy };
});
