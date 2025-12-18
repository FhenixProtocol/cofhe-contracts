import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const MODULE_NAME = "ACL";

export default buildModule(MODULE_NAME, m => {
  const acl = m.contract(MODULE_NAME);
  return { [MODULE_NAME]: acl };
});
