// pixie-template-generator@1.0.0
// trace-sha256: 9d3c9e69745c0850d77cf402581df3b18268889576d2b1ddcbf66bbabd3b9a45
import { locate, taskRow, waitForTaskRemoval } from "../../src/generator/runtime.js";
import type { Page } from "playwright";
import type { GeneratedArgs, PublicTask } from "../../src/shared/types.js";

export async function removeTask(page: Page, args: GeneratedArgs): Promise<PublicTask | PublicTask[] | undefined> {
  await (await locate(taskRow(page, args.id!), {"testid":"delete-task"})).click();
  await waitForTaskRemoval(page, args.id!);
  return undefined;
}

export { removeTask as delete };
