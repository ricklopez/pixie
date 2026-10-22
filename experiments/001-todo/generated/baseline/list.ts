// pixie-template-generator@1.0.0
// trace-sha256: 80910627d2ae1bd6a9611f5a2bfe26ebf2ab2d2dda6accc7f1a4c2c460b2e4e2
import { readVisibleTasks } from "../../src/generator/runtime.js";
import type { Page } from "playwright";
import type { GeneratedArgs, PublicTask } from "../../src/shared/types.js";

export async function list(page: Page, args: GeneratedArgs): Promise<PublicTask | PublicTask[] | undefined> {
  return await readVisibleTasks(page);
}
