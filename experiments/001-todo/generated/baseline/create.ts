// pixie-template-generator@1.0.0
// trace-sha256: 1b36ca84b84eab5bba3e2b098c8075260441ebbe30efbec6b3c65e83a2b07ce4
import { locate, waitForTask } from "../../src/generator/runtime.js";
import type { Page } from "playwright";
import type { GeneratedArgs, PublicTask } from "../../src/shared/types.js";

export async function create(page: Page, args: GeneratedArgs): Promise<PublicTask | PublicTask[] | undefined> {
  await (await locate(page, {"testid":"new-task-title"})).fill(args.title!);
  await (await locate(page, {"testid":"create-task"})).click();
  return waitForTask(page, args.requestId!, args.title!);
}
