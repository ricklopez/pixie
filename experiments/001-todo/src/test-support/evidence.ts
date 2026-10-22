import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as nodeTest } from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidencePath = resolve(packageRoot, "evidence/test-attempts.jsonl");

export function evidenceTest(name: string, run: () => Promise<void>): void {
  nodeTest(name, async () => {
    const startedAt = new Date().toISOString();
    let outcome: "passed" | "failed" = "passed";
    let errorMessage: string | undefined;
    try {
      await run();
    } catch (error) {
      outcome = "failed";
      errorMessage = error instanceof Error ? error.message : "test failed with a non-Error value";
      throw error;
    } finally {
      await mkdir(dirname(evidencePath), { recursive: true });
      const record = {
        startedAt,
        finishedAt: new Date().toISOString(),
        name,
        outcome,
        ...(errorMessage ? { error: errorMessage } : {})
      };
      await appendFile(evidencePath, `${JSON.stringify(record)}\n`);
    }
  });
}
