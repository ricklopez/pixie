import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AutomationDefinition } from "@gateway/definition";
import { generateAdapter } from "@gateway/adapter";
import { call, PORTAL, testApp, TOKENS } from "./helpers.js";

test("repair candidates store executed gate evidence and failed gates block approval", async () => {
  const { app, runs, db, shutdown } = await testApp({ mode: "model-down" });
  try {
    const created = await call(app, TOKENS.developer, "POST", "/studio/automations", {
      name: "Failed adapter repair",
      startUrl: `${PORTAL}/demo-portal`,
      template: "eligibility-overview"
    });
    assert.equal(created.status, 201);
    const id = created.json.id!;
    assert.equal((await call(app, TOKENS.developer, "PUT", `/studio/automations/${id}/definition`, created.json.definition)).status, 200);
    const testRun = await call(app, TOKENS.developer, "POST", `/studio/automations/${id}/test`, { accountId: "acct_demo", input: { memberId: "DEMO-1001" } });
    assert.equal(testRun.status, 202);
    await runs.waitForTerminal(testRun.json.id!);

    const definition = created.json.definition as AutomationDefinition;
    const recording = JSON.parse(readFileSync(new URL("../../../fixtures/recorded-eligibility.json", import.meta.url), "utf8"));
    const source = generateAdapter(recording, definition).source;
    const repair = await call(app, TOKENS.developer, "POST", `/studio/automations/${id}/repairs`, { runId: testRun.json.id, source });
    assert.equal(repair.status, 201);
    assert.equal(repair.json.state, "gates_failed");
    assert.equal((repair.json.gates as { passed: boolean }[]).length, 3);
    assert.ok((repair.json.gates as { passed: boolean }[]).some((gate) => !gate.passed));

    const row = db.prepare(`SELECT gate_results, gate_logs FROM repair_candidates WHERE id = ?`).get(repair.json.id) as { gate_results: string; gate_logs: string };
    const results = JSON.parse(row.gate_results) as { name: string; result: unknown }[];
    const logs = JSON.parse(row.gate_logs) as Record<string, string>;
    assert.deepEqual(results.map((gate) => gate.name), ["frozen_suite", "replay", "verifier"]);
    assert.deepEqual(Object.keys(logs).sort(), ["frozen_suite", "replay", "verifier"]);
    assert.ok(Object.values(logs).every((log) => log.length > 0));
    assert.equal((await call(app, TOKENS.developer, "POST", `/studio/repairs/${repair.json.id}/approve`)).status, 409);

    const invalidSource = source.replace("export async function run", "export const checks = [];\nexport async function run");
    const rejected = await call(app, TOKENS.developer, "POST", `/studio/automations/${id}/repairs`, { runId: testRun.json.id, source: invalidSource });
    assert.equal(rejected.status, 422);
    assert.match(rejected.json.error!, /adapter source only/);
  } finally {
    await shutdown();
  }
});
