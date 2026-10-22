// pixie-template-generator@1.0.0
// trace-sha256: c7159125e56265619726e3e8d705b595c1eb2a222adc6d30f951cd681ae815f3
import { locate, taskRow, waitForTask } from "../../src/generator/runtime.js";
import type { Page } from "playwright";
import type { GeneratedArgs, PublicTask } from "../../src/shared/types.js";

export async function rename(page: Page, args: GeneratedArgs): Promise<PublicTask | PublicTask[] | undefined> {
  await (await locate(taskRow(page, args.id!), {"testid":"rename-task"})).click();
  await (await locate(taskRow(page, args.id!), {"testid":"rename-input"})).fill(args.newTitle!);
  await (await locate(taskRow(page, args.id!), {"testid":"save-rename"})).click();
  return waitForTask(page, args.requestId!, args.newTitle!, args.id!);
}
