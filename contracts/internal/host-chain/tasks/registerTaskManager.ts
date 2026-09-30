import chalk from "chalk";
import { task, types } from "hardhat/config";

import { addressBookAddress, registeredTaskManager, taskManagerId } from "../utils/addressBook";
import { isAlreadyDeployed } from "../utils/deployCreateX";
import { updateTaskManagerAddressInJsonArtifact } from "../utils/updateTaskManagerAddress";

task(
  "task:registerTaskManager",
  "Point the address book's TaskManager id at a TaskManager that is already deployed on this chain",
)
  .addParam("address", "The existing TaskManager proxy")
  .addParam("force", "Repoint an id that already points elsewhere", false, types.boolean)
  .setAction(async function (taskArguments, hre) {
    const { ethers } = hre;
    const target = ethers.getAddress(taskArguments.address);
    const [signer] = await ethers.getSigners();
    const bookAddress = addressBookAddress();

    if (!(await isAlreadyDeployed(hre, bookAddress))) {
      throw new Error(`No CoFHEAddressBook at ${bookAddress} on ${hre.network.name}. Run task:deployAddressBook first.`);
    }
    if (!(await isAlreadyDeployed(hre, target))) {
      throw new Error(`No code at ${target} on ${hre.network.name}.`);
    }
    const taskManager: any = await ethers.getContractAt("TaskManager", target);
    try {
      await taskManager.acl();
    } catch {
      throw new Error(`${target} does not look like a TaskManager: acl() reverted.`);
    }

    const book: any = await ethers.getContractAt("CoFHEAddressBook", bookAddress);
    const owner: string = await book.owner();
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(`CoFHEAddressBook at ${bookAddress} is owned by ${owner}, not by the signer ${signer.address}.`);
    }

    const id = taskManagerId();
    const current = await registeredTaskManager(book, id);
    if (current && current.toLowerCase() === target.toLowerCase()) {
      console.log(chalk.green(`TaskManager id ${id} already points at ${target}`));
    } else {
      if (current && !taskArguments.force) {
        throw new Error(
          `TaskManager id ${id} already points at ${current}. Every FHE.sol contract on this chain uses it; ` +
            `pass --force true to repoint it at ${target}.`,
        );
      }
      const tx = await book.connect(signer).setTm(id, target);
      await tx.wait();
      console.log(chalk.green(`TaskManager id ${id} now points at ${target}`));
    }
    await updateTaskManagerAddressInJsonArtifact(target, hre);

    // The same handover `hardhat deploy` does for the book: nominate the final admin, to be accepted
    // by task:acceptAdminAsSafe. The existing TaskManager stack is left as it is.
    const finalAdmin = process.env.SAFE_ADMIN_ADDRESS?.trim();
    if (finalAdmin) {
      const nominee = ethers.getAddress(finalAdmin);
      const pending: string = await book.pendingOwner();
      if (pending.toLowerCase() === nominee.toLowerCase()) {
        console.log(chalk.green(`CoFHEAddressBook: ${nominee} is already the pending owner`));
      } else {
        const tx = await book.connect(signer).transferOwnership(nominee);
        await tx.wait();
        console.log(chalk.green(`CoFHEAddressBook: nominated ${nominee} as owner (accepted by task:acceptAdminAsSafe)`));
      }
    }
  });
