import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { fetchHarnessState, resetFixture, startFixture } from "../fixture/server.js";
import { TodoRunner } from "../runner/runner.js";
import { verifyDelta } from "../verifier/verifier.js";
import type { Task, Variant } from "../shared/types.js";

export interface HumanRenameCandidate {
  (page: Page, args: { id: string; newTitle: string; requestId: string }): Promise<unknown>;
}

const unrelated: Task[] = [
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "external open task", done: false, requestId: null },
  { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "external completed task", done: true, requestId: null }
];
const target: Task = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  title: "pixie-demo repair target",
  done: false,
  requestId: null
};

export async function runFrozenCandidateSuite(candidate: HumanRenameCandidate): Promise<boolean> {
  for (const [index, variant] of (["baseline", "locator-break"] satisfies Variant[]).entries()) {
    const fixture = await startFixture({ variant });
    const runner = new TodoRunner(":memory:");
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      await resetFixture(fixture.baseUrl, [...unrelated, target]);
      let currentRequestId = "";
      const context = await browser.newContext();
      await context.route("**/__app/**", (route) => route.continue({
        headers: { ...route.request().headers(), "x-request-id": currentRequestId }
      }));
      const page = await context.newPage();

      let before = await fetchHarnessState(fixture.baseUrl);
      const createInput = { title: "pixie-demo candidate sequence", requestId: `00000000-0000-4000-8000-${String(500 + index).padStart(12, "0")}` };
      const created = await runner.run(fixture.baseUrl, "create", createInput);
      assert.equal(created.terminal, "completed");
      let after = await fetchHarnessState(fixture.baseUrl);
      assert.equal(verifyDelta({ op: "create", before, after, input: createInput }).accepted, true);

      before = after;
      const listed = await runner.run(fixture.baseUrl, "list", {});
      assert.equal(listed.terminal, "completed");
      after = await fetchHarnessState(fixture.baseUrl);
      assert.equal(verifyDelta({ op: "list", before, after, input: {} }).accepted, true);

      currentRequestId = `00000000-0000-4000-8000-${String(600 + index).padStart(12, "0")}`;
      await page.goto(fixture.baseUrl);
      before = await fetchHarnessState(fixture.baseUrl);
      const renameInput = { id: target.id, newTitle: "pixie-demo repaired title", requestId: currentRequestId };
      await candidate(page, renameInput);
      after = await fetchHarnessState(fixture.baseUrl);
      assert.equal(verifyDelta({ op: "rename", before, after, input: renameInput }).accepted, true);

      const createdRow = after.find((row) => row.requestId === createInput.requestId);
      assert.ok(createdRow);
      before = after;
      const deleteInput = { id: createdRow.id, requestId: `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}` };
      const deleted = await runner.run(fixture.baseUrl, "delete", deleteInput);
      assert.equal(deleted.terminal, "completed");
      after = await fetchHarnessState(fixture.baseUrl);
      assert.equal(verifyDelta({ op: "delete", before, after, input: deleteInput }).accepted, true);
      assert.equal(created.modelCallAttempts + listed.modelCallAttempts + deleted.modelCallAttempts, 0);
      await context.close();
    } finally {
      runner.close();
      await browser?.close();
      await fixture.close();
    }
  }
  return true;
}
