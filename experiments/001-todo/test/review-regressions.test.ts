import assert from "node:assert/strict";
import { test } from "node:test";
import { startFixture, resetFixture, setFixtureFault, fetchHarnessState } from "../src/fixture/server.js";
import { TodoRunner } from "../src/runner/runner.js";

test("uncertain create never reconciles an unrelated same-title task", async () => {
  const fixture = await startFixture({ variant: "baseline" });
  const runner = new TodoRunner(":memory:");
  const input = { title: "pixie-demo uncertain review", requestId: "99999999-0000-4000-8000-000000000001" };
  try {
    await resetFixture(fixture.baseUrl, []);
    await setFixtureFault(fixture.baseUrl, "create:before-persist-fail");
    const first = await runner.run(fixture.baseUrl, "create", input);
    assert.equal(first.terminal, "outcome_unknown");
    await resetFixture(fixture.baseUrl, [{ id: "99999999-0000-4000-8000-000000000002", title: input.title, done: false, requestId: null }]);
    const replay = await runner.run(fixture.baseUrl, "create", input);
    assert.equal(replay.terminal, "outcome_unknown");
    assert.equal(replay.dispatchCount, 0);
    assert.equal(replay.result, undefined);
    assert.equal((await fetchHarnessState(fixture.baseUrl)).length, 1);
  } finally { runner.close(); await fixture.close(); }
});

test("a saved request cannot replay a result from a different fixture", async () => {
  const first = await startFixture({ variant: "baseline" });
  const second = await startFixture({ variant: "baseline" });
  const runner = new TodoRunner(":memory:");
  const input = { title: "pixie-demo scoped review", requestId: "99999999-0000-4000-8000-000000000003" };
  try {
    await resetFixture(first.baseUrl, []);
    await resetFixture(second.baseUrl, []);
    assert.equal((await runner.run(first.baseUrl, "create", input)).terminal, "completed");
    const replay = await runner.run(second.baseUrl, "create", input);
    assert.equal(replay.terminal, "conflict");
    assert.equal(replay.result, undefined);
    assert.equal(replay.dispatchCount, 0);
    assert.equal((await fetchHarnessState(second.baseUrl)).length, 0);
  } finally { runner.close(); await first.close(); await second.close(); }
});
