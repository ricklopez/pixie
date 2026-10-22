import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceTest } from "../../src/test-support/evidence.js";
import { fetchHarnessState, resetFixture, setFixtureFault, startFixture } from "../../src/fixture/server.js";
import { TodoRunner } from "../../src/runner/runner.js";
import { verifyDelta, verifyFixtureDelta } from "../../src/verifier/verifier.js";
import type { Task, Variant } from "../../src/shared/types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requestUuid = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const seeds: Task[] = [
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "outside task open", done: false, requestId: null },
  { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "outside task done", done: true, requestId: null }
];

function assertAccepted(input: Parameters<typeof verifyDelta>[0] | ReturnType<typeof verifyDelta>): void {
  const result = "accepted" in input ? input : verifyDelta(input);
  assert.equal(result.accepted, true, result.reason ?? "unexpected delta verifier failure");
  assert.equal(result.preservedUnrelated, true);
}

evidenceTest("runs ten exact CRUD sequences with Unicode, punctuation, and unrelated rows", async () => {
  const fixture = await startFixture({ variant: "baseline" });
  const runner = new TodoRunner(":memory:");
  const titles = [
    "spaces matter",
    "apostrophe's task",
    "comma, and semicolon;",
    "brackets [and] braces {}",
    "accent café",
    "CJK 東京タスク",
    "emoji 🧪✅",
    "dash — and ellipsis…",
    "quotes “curly” and 'straight'",
    "mixed Ω / ñ / 漢字 / 🐙"
  ];
  try {
    for (let index = 0; index < titles.length; index += 1) {
      await resetFixture(fixture.baseUrl, seeds);
      const suffix = `${String(index).padStart(2, "0")} ${titles[index]}`;
      const createInput = { title: `pixie-demo ${suffix}`, requestId: requestUuid(index * 3 + 1) };
      const beforeCreate = await fetchHarnessState(fixture.baseUrl);
      const created = await runner.run(fixture.baseUrl, "create", createInput);
      assert.equal(created.terminal, "completed");
      assert.equal(created.dispatchCount, 1);
      assert.equal(created.modelCallAttempts, 0);
      const createVerification = await verifyFixtureDelta(fixture.baseUrl, "create", beforeCreate, createInput);
      const afterCreate = createVerification.after;
      assertAccepted(createVerification.verification);
      const createdTask = afterCreate.find((task) => task.requestId === createInput.requestId);
      assert.ok(createdTask);

      const beforeList = await fetchHarnessState(fixture.baseUrl);
      const listed = await runner.run(fixture.baseUrl, "list", {});
      assert.equal(listed.terminal, "completed");
      assert.equal(listed.modelCallAttempts, 0);
      const listVerification = await verifyFixtureDelta(fixture.baseUrl, "list", beforeList, {});
      const afterList = listVerification.after;
      assertAccepted(listVerification.verification);

      const renameInput = {
        id: createdTask.id,
        newTitle: `pixie-demo renamed ${suffix}`,
        requestId: requestUuid(index * 3 + 2)
      };
      const beforeRename = await fetchHarnessState(fixture.baseUrl);
      const renamed = await runner.run(fixture.baseUrl, "rename", renameInput);
      assert.equal(renamed.terminal, "completed");
      assert.equal(renamed.modelCallAttempts, 0);
      const renameVerification = await verifyFixtureDelta(fixture.baseUrl, "rename", beforeRename, renameInput);
      const afterRename = renameVerification.after;
      assertAccepted(renameVerification.verification);

      const deleteInput = { id: createdTask.id, requestId: requestUuid(index * 3 + 3) };
      const beforeDelete = await fetchHarnessState(fixture.baseUrl);
      const deleted = await runner.run(fixture.baseUrl, "delete", deleteInput);
      assert.equal(deleted.terminal, "completed");
      assert.equal(deleted.modelCallAttempts, 0);
      const deleteVerification = await verifyFixtureDelta(fixture.baseUrl, "delete", beforeDelete, deleteInput);
      const afterDelete = deleteVerification.after;
      assertAccepted(deleteVerification.verification);
      assert.deepEqual(afterDelete, seeds);
    }
  } finally {
    runner.close();
    await fixture.close();
  }
});

evidenceTest("records actual baseline-script outcomes for every fixture variant", async () => {
  const variants: Variant[] = ["baseline", "cosmetic", "locator-break", "ambiguous", "rule-change"];
  const outcomes: Record<string, Record<string, {
    terminal: string;
    dispatchCount: number;
    modelCallAttempts: number;
  }>> = {};
  for (const [index, variant] of variants.entries()) {
    const fixture = await startFixture({ variant });
    const runner = new TodoRunner(":memory:");
    const targetRows: Task[] = variant === "ambiguous"
      ? [
          { id: "a0000000-0000-4000-8000-000000000001", title: "pixie-demo Duplicate-looking task", done: false, requestId: null },
          { id: "a0000000-0000-4000-8000-000000000002", title: "pixie-demo Duplicate-looking task", done: true, requestId: null }
        ]
      : [{
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          title: `pixie-demo ${variant} target`,
          done: false,
          requestId: null
        }];
    const targetId = targetRows[0]!.id;
    try {
      await resetFixture(fixture.baseUrl, targetRows);
      outcomes[variant] = {};

      const create = await runner.run(fixture.baseUrl, "create", {
        title: `pixie-demo ${variant} outcome`,
        requestId: requestUuid(100 + index * 10)
      });
      outcomes[variant]!.create = {
        terminal: create.terminal,
        dispatchCount: create.dispatchCount,
        modelCallAttempts: create.modelCallAttempts
      };
      assert.equal(create.modelCallAttempts, 0);
      assert.equal(
        create.terminal,
        variant === "rule-change" ? "contract_revision_required" : "completed"
      );
      assert.equal(create.dispatchCount, variant === "rule-change" ? 0 : 1);

      const list = await runner.run(fixture.baseUrl, "list", {});
      outcomes[variant]!.list = {
        terminal: list.terminal,
        dispatchCount: list.dispatchCount,
        modelCallAttempts: list.modelCallAttempts
      };
      assert.equal(list.terminal, "completed");
      assert.equal(list.dispatchCount, 0);
      assert.equal(list.modelCallAttempts, 0);

      const rename = await runner.run(fixture.baseUrl, "rename", {
        id: targetId,
        newTitle: `pixie-demo ${variant} renamed`,
        requestId: requestUuid(101 + index * 10)
      });
      outcomes[variant]!.rename = {
        terminal: rename.terminal,
        dispatchCount: rename.dispatchCount,
        modelCallAttempts: rename.modelCallAttempts
      };
      assert.equal(rename.modelCallAttempts, 0);
      assert.equal(
        rename.terminal,
        variant === "locator-break" ? "failed"
          : variant === "ambiguous" ? "needs_review"
            : variant === "rule-change" ? "contract_revision_required"
              : "completed"
      );
      assert.equal(rename.dispatchCount, rename.terminal === "completed" ? 1 : 0);

      const remove = await runner.run(fixture.baseUrl, "delete", {
        id: targetId,
        requestId: requestUuid(102 + index * 10)
      });
      outcomes[variant]!.delete = {
        terminal: remove.terminal,
        dispatchCount: remove.dispatchCount,
        modelCallAttempts: remove.modelCallAttempts
      };
      assert.equal(remove.modelCallAttempts, 0);
      assert.equal(
        remove.terminal,
        variant === "ambiguous" ? "needs_review"
          : variant === "rule-change" ? "contract_revision_required"
            : "completed"
      );
      assert.equal(remove.dispatchCount, remove.terminal === "completed" ? 1 : 0);

      if (variant === "rule-change") {
        const missingReason = await fetch(`${fixture.baseUrl}/__app/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": requestUuid(150) },
          body: JSON.stringify({ title: "pixie-demo short" })
        });
        assert.equal(missingReason.status, 422);
        const longTitle = await fetch(`${fixture.baseUrl}/__app/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": requestUuid(151) },
          body: JSON.stringify({ title: "pixie-demo this title is too long", reason: "required" })
        });
        assert.equal(longTitle.status, 422);
        const missingRenameReason = await fetch(`${fixture.baseUrl}/__app/tasks/${targetId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-request-id": requestUuid(152) },
          body: JSON.stringify({ newTitle: "pixie-demo new" })
        });
        assert.equal(missingRenameReason.status, 422);
      }
    } finally {
      runner.close();
      await fixture.close();
    }
  }
  await mkdir(resolve(packageRoot, "evidence"), { recursive: true });
  await writeFile(resolve(packageRoot, "evidence/variant-outcomes.json"), `${JSON.stringify(outcomes, null, 2)}\n`);
});

evidenceTest("enforces idempotency, conflict, exact target guards, and prefix rejection", async () => {
  const fixture = await startFixture({ variant: "baseline" });
  const runner = new TodoRunner(":memory:");
  try {
    await resetFixture(fixture.baseUrl, [...seeds, { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "pixie-demo target", done: true, requestId: null }]);
    const input = { title: "pixie-demo one write", requestId: requestUuid(200) };
    const first = await runner.run(fixture.baseUrl, "create", input);
    const replay = await runner.run(fixture.baseUrl, "create", input);
    assert.equal(first.terminal, "completed");
    assert.equal(replay.terminal, "completed");
    assert.equal(replay.reused, true);
    assert.equal(replay.dispatchCount, 0);
    assert.deepEqual(replay.result, first.result);
    const conflict = await runner.run(fixture.baseUrl, "create", { ...input, title: "pixie-demo changed payload" });
    assert.equal(conflict.terminal, "conflict");
    assert.equal(conflict.dispatchCount, 0);

    const missingTarget = await runner.run(fixture.baseUrl, "delete", { requestId: requestUuid(201) });
    assert.equal(missingTarget.terminal, "needs_review");
    assert.equal(missingTarget.dispatchCount, 0);
    const absentTarget = await runner.run(fixture.baseUrl, "delete", { id: "not-present", requestId: requestUuid(202) });
    assert.equal(absentTarget.terminal, "needs_review");
    assert.equal(absentTarget.dispatchCount, 0);
    const rejectedInput = { title: "not permitted", requestId: requestUuid(203) };
    const prefix = await runner.run(fixture.baseUrl, "create", rejectedInput);
    assert.equal(prefix.terminal, "rejected");
    assert.equal(prefix.dispatchCount, 0);
    const changedRejectedPayload = await runner.run(fixture.baseUrl, "create", {
      title: "pixie-demo now valid",
      requestId: rejectedInput.requestId
    });
    assert.equal(changedRejectedPayload.terminal, "conflict");
    const missingRequestId = await runner.run(fixture.baseUrl, "create", { title: "pixie-demo missing request id" });
    assert.equal(missingRequestId.terminal, "rejected");
    assert.equal(missingRequestId.dispatchCount, 0);
    const duplicate = await runner.run(fixture.baseUrl, "create", { title: "pixie-demo target", requestId: requestUuid(204) });
    assert.equal(duplicate.terminal, "needs_review");
    assert.equal(duplicate.dispatchCount, 0);
    const state = await fetchHarnessState(fixture.baseUrl);
    assert.equal(state.filter((task) => task.title === "pixie-demo one write").length, 1);
    assert.equal(state.find((task) => task.id === "cccccccc-cccc-4ccc-8ccc-cccccccccccc")?.done, true);
    const remote = await runner.run("https://example.com", "list", {});
    assert.equal(remote.terminal, "rejected");
    assert.equal(remote.dispatchCount, 0);
  } finally {
    runner.close();
    await fixture.close();
  }
});

evidenceTest("persists the idempotency ledger across runner instances", async () => {
  const fixture = await startFixture({ variant: "baseline" });
  await mkdir(resolve(packageRoot, ".data"), { recursive: true });
  const directory = await mkdtemp(join(packageRoot, ".data", "ledger-test-"));
  const ledgerPath = join(directory, "ledger.sqlite");
  let runner = new TodoRunner(ledgerPath);
  try {
    await resetFixture(fixture.baseUrl, seeds);
    const input = { title: "pixie-demo durable ledger", requestId: requestUuid(900) };
    const first = await runner.run(fixture.baseUrl, "create", input);
    assert.equal(first.terminal, "completed");
    runner.close();

    runner = new TodoRunner(ledgerPath);
    const replay = await runner.run(fixture.baseUrl, "create", input);
    assert.equal(replay.terminal, "completed");
    assert.equal(replay.reused, true);
    assert.equal(replay.dispatchCount, 0);
    assert.deepEqual(replay.result, first.result);
    const rows = await fetchHarnessState(fixture.baseUrl);
    assert.equal(rows.filter((task) => task.requestId === input.requestId).length, 1);
  } finally {
    runner.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

evidenceTest("requires harness authentication without protecting application write routes", async () => {
  const fixture = await startFixture({ variant: "baseline" });
  try {
    const state = await fetch(`${fixture.baseUrl}/__state`);
    assert.equal(state.status, 403);
    const reset = await fetch(`${fixture.baseUrl}/__reset`, { method: "POST", body: JSON.stringify({ rows: [] }) });
    assert.equal(reset.status, 403);
    const applicationWrite = await fetch(`${fixture.baseUrl}/__app/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestUuid(250) },
      body: JSON.stringify({ title: "pixie-demo unauthenticated app route" })
    });
    assert.equal(applicationWrite.status, 201);
  } finally {
    await fixture.close();
  }
});

evidenceTest("reconciles uncertain create writes without issuing a second create", async () => {
  const faults = [
    { fault: "create:before-persist-fail", expectedCount: 0 },
    { fault: "create:after-persist-drop", expectedCount: 1 },
    { fault: "create:after-confirm-drop", expectedCount: 1 }
  ];
  for (const [index, { fault, expectedCount }] of faults.entries()) {
    const fixture = await startFixture({ variant: "baseline" });
    const runner = new TodoRunner(":memory:");
    try {
      await resetFixture(fixture.baseUrl, seeds);
      await setFixtureFault(fixture.baseUrl, fault);
      const input = { title: `pixie-demo ${fault}`, requestId: requestUuid(300 + index) };
      const first = await runner.run(fixture.baseUrl, "create", input);
      let state = await fetchHarnessState(fixture.baseUrl);
      const firstIds = state.filter((task) => task.requestId === input.requestId).map((task) => task.id);
      assert.equal(firstIds.length, expectedCount);
      assert.deepEqual(state.filter((task) => seeds.some((seed) => seed.id === task.id)), seeds);
      assert.ok(["completed", "outcome_unknown"].includes(first.terminal));
      assert.equal(first.dispatchCount, 1);
      const second = await runner.run(fixture.baseUrl, "create", input);
      assert.equal(second.dispatchCount, 0);
      state = await fetchHarnessState(fixture.baseUrl);
      assert.deepEqual(state.filter((task) => task.requestId === input.requestId).map((task) => task.id), firstIds);
      assert.deepEqual(state.filter((task) => seeds.some((seed) => seed.id === task.id)), seeds);
    } finally {
      runner.close();
      await fixture.close();
    }
  }
});
