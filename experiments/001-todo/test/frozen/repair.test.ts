import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceTest } from "../../src/test-support/evidence.js";
import { fetchHarnessState, resetFixture, startFixture } from "../../src/fixture/server.js";
import { PromotionStore } from "../../src/repair/promotion.js";
import { TodoRunner } from "../../src/runner/runner.js";
import { validateCandidate } from "../../src/repair/validate.js";
import { verifyDelta } from "../../src/verifier/verifier.js";
import type { Task } from "../../src/shared/types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

evidenceTest("accepts only the human-authored locator repair after baseline and locator-break checks", async () => {
  const candidate = await readFile(resolve(packageRoot, "repair-candidates/human-authored/rename.ts"), "utf8");
  const result = await validateCandidate([{ path: "generated/candidate/rename.ts", content: candidate }]);
  assert.equal(result.accepted, true, result.reasons.join("; "));
  assert.match(candidate, /source: human-authored-test-candidate/);
  const ruleChange = await validateCandidate([{ path: "generated/rule-change/rename.ts", content: candidate }]);
  assert.equal(ruleChange.accepted, false);
  assert.match(ruleChange.reasons.join(" "), /not promotable/);
});

evidenceTest("rejects contract-scope changes and requires approval before promotion", async () => {
  const outsideScope = await validateCandidate([{ path: "contract/create.schema.json", content: "{}" }]);
  assert.equal(outsideScope.accepted, false);
  assert.match(outsideScope.reasons.join(" "), /outside repair scope/);

  const directory = await mkdtemp(join(tmpdir(), "pixie-promotion-"));
  try {
    const store = new PromotionStore(directory);
    await store.initialize("baseline-hash");
    const validation = { accepted: true, candidateHash: "candidate-hash" };
    await assert.rejects(store.promote("candidate-hash", undefined, validation), /approval/);
    await assert.rejects(store.promote("other-candidate", {
      approver: "offline-test-approver",
      time: new Date().toISOString(),
      candidateHash: "other-candidate"
    }, validation), /validated candidate/);
    const promoted = await store.promote("candidate-hash", {
      approver: "offline-test-approver",
      time: new Date().toISOString(),
      candidateHash: "candidate-hash"
    }, validation);
    assert.equal(promoted.activeHash, "candidate-hash");
    assert.equal(promoted.previousHash, "baseline-hash");
    const rolledBack = await store.rollback("offline-test-approver");
    assert.equal(rolledBack.activeHash, "baseline-hash");
    const log = await readFile(join(directory, "promotions.log"), "utf8");
    assert.equal(log.trim().split("\n").length, 2);
    assert.match(log, /"type":"promote"/);
    assert.match(log, /"type":"rollback"/);

    const fixture = await startFixture({ variant: "baseline" });
    const runner = new TodoRunner(":memory:");
    const seeds: Task[] = [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "outside task open", done: false, requestId: null },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "outside task done", done: true, requestId: null }
    ];
    try {
      await resetFixture(fixture.baseUrl, seeds);
      let before = await fetchHarnessState(fixture.baseUrl);
      const createInput = { title: "pixie-demo after rollback", requestId: "00000000-0000-4000-8000-000000000801" };
      const createdResult = await runner.run(fixture.baseUrl, "create", createInput);
      assert.equal(createdResult.terminal, "completed");
      assert.equal(createdResult.modelCallAttempts, 0);
      let after = await fetchHarnessState(fixture.baseUrl);
      assert.equal(verifyDelta({ op: "create", before, after, input: createInput }).accepted, true);

      before = after;
      const listedResult = await runner.run(fixture.baseUrl, "list", {});
      assert.equal(listedResult.terminal, "completed");
      assert.equal(listedResult.modelCallAttempts, 0);
      after = await fetchHarnessState(fixture.baseUrl);
      assert.equal(verifyDelta({ op: "list", before, after, input: {} }).accepted, true);

      const created = after.find((row) => row.requestId === createInput.requestId);
      assert.ok(created);
      before = after;
      const renameInput = {
        id: created.id,
        newTitle: "pixie-demo renamed after rollback",
        requestId: "00000000-0000-4000-8000-000000000802"
      };
      const renamedResult = await runner.run(fixture.baseUrl, "rename", renameInput);
      assert.equal(renamedResult.terminal, "completed");
      assert.equal(renamedResult.modelCallAttempts, 0);
      after = await fetchHarnessState(fixture.baseUrl);
      assert.equal(verifyDelta({ op: "rename", before, after, input: renameInput }).accepted, true);

      before = after;
      const deleteInput = { id: created.id, requestId: "00000000-0000-4000-8000-000000000803" };
      const deletedResult = await runner.run(fixture.baseUrl, "delete", deleteInput);
      assert.equal(deletedResult.terminal, "completed");
      assert.equal(deletedResult.modelCallAttempts, 0);
      after = await fetchHarnessState(fixture.baseUrl);
      assert.equal(verifyDelta({ op: "delete", before, after, input: deleteInput }).accepted, true);
      assert.deepEqual(after, seeds);
    } finally {
      runner.close();
      await fixture.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
