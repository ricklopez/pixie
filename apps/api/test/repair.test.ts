import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generateAdapter } from "@gateway/adapter";
import { requestModelRepair, sourceWithinAdapterScope } from "../src/repair.js";
import { call, publishEligibility, testApp, TOKENS } from "./helpers.js";

const candidate = `import { locate, checkpoint, extractOutputs } from "@gateway/adapter/runtime";
export async function run(page, input) {
  return await extractOutputs(page, [], {});
}`;

test("Fireworks repair request is capped and contains only the adapter failure context", async () => {
  let requestBody = "";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requestBody = Buffer.concat(chunks).toString("utf8");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: candidate } }], usage: { prompt_tokens: 120, completion_tokens: 20 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const repaired = await requestModelRepair({
      source: candidate,
      failureEvents: [{ type: "script_failure", reason: "label not found" }],
      domExcerpt: "Subscriber ID",
      apiKey: "unit-test-secret",
      endpoint: `http://127.0.0.1:${address.port}`,
      fetcher: fetch
    });
    const body = JSON.parse(requestBody) as { max_tokens: number; messages: { content: string }[] };
    assert.equal(body.max_tokens, 4000);
    assert.match(body.messages[1]?.content ?? "", /failingAdapterSource/);
    assert.doesNotMatch(body.messages[1]?.content ?? "", /verifierChecks|frozen_suite|unit-test-secret/);
    assert.equal(repaired.inputTokens, 120);
    assert.ok(repaired.estimatedCostUsd > 0);
    await assert.rejects(requestModelRepair({
      source: candidate, failureEvents: [], domExcerpt: "", apiKey: "x", priorCalls: 3,
      endpoint: `http://127.0.0.1:${address.port}`
    }), /call cap/);
    await assert.rejects(requestModelRepair({
      source: "x".repeat(70_000), failureEvents: [], domExcerpt: "", apiKey: "x",
      endpoint: `http://127.0.0.1:${address.port}`
    }), /input-token cap/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("adapter scope rejects candidates that edit checks or include other modules", () => {
  assert.equal(sourceWithinAdapterScope(candidate), true);
  assert.equal(sourceWithinAdapterScope(candidate.replace("return await", "const checks = []; return await")), false);
  assert.equal(sourceWithinAdapterScope(candidate.replace('from "@gateway/adapter/runtime"', 'from "node:fs"')), false);
});

test("model repair records spend and never sends verifier checks to Fireworks", async () => {
  let requestBody = "";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requestBody = Buffer.concat(chunks).toString("utf8");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: candidate } }], usage: { prompt_tokens: 90, completion_tokens: 15 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const { app, runs, db, shutdown } = await testApp({}, {
    fireworksApiKey: "fake-fireworks-key",
    fireworksEndpoint: `http://127.0.0.1:${address.port}`
  });
  try {
    const { id, testRunId } = await publishEligibility(app, runs);
    const definition = JSON.parse((db.prepare(`SELECT definition FROM automations WHERE id = ?`).get(id) as { definition: string }).definition);
    const recording = JSON.parse(readFileSync(new URL("../../../fixtures/recorded-eligibility.json", import.meta.url), "utf8"));
    const source = generateAdapter(recording, definition).source;
    const original = db.prepare(`SELECT * FROM adapter_revisions WHERE automation_id = ? ORDER BY revision DESC LIMIT 1`).get(id) as Record<string, unknown>;
    const revision = (db.prepare(`SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM adapter_revisions WHERE automation_id = ?`).get(id) as { n: number }).n;
    const activeAdapterId = randomUUID();
    db.prepare(`INSERT INTO adapter_revisions (id, operation_version_id, revision, definition_hash, engine, engine_revision, generator, source, automation_id, automation_revision, hash) VALUES (?, ?, ?, ?, ?, ?, 'recorded', ?, ?, ?, ?)`)
      .run(activeAdapterId, original.operation_version_id, revision, original.definition_hash, "script", "recorded-adapter-v1", source, id, original.automation_revision, createHash("sha256").update(source).digest("hex"));
    db.prepare(`UPDATE publication_bindings SET adapter_revision_id = ? WHERE operation_version_id = ?`)
      .run(activeAdapterId, original.operation_version_id);

    const failedRunId = testRunId;
    const seq = (db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM run_events WHERE run_id = ?`).get(failedRunId) as { n: number }).n;
    db.prepare(`UPDATE runs SET state = 'failed', failure = 'label mismatch' WHERE id = ?`).run(failedRunId);
    db.prepare(`INSERT INTO run_events (run_id, seq, at, event) VALUES (?, ?, ?, ?)`).run(
      failedRunId, seq, new Date().toISOString(), JSON.stringify({ type: "script_failure", reason: "label mismatch token=unit-test-secret-123", domExcerpt: "Subscriber ID DEMO-1001 Bearer unit-test-secret-123" })
    );
    const repair = await call(app, TOKENS.developer, "POST", `/studio/automations/${id}/repairs`, { runId: failedRunId, model: true });
    assert.equal(repair.status, 201);
    const body = JSON.parse(requestBody) as { max_tokens: number; messages: { content: string }[] };
    assert.equal(body.max_tokens, 4000);
    assert.match(body.messages[1]?.content ?? "", /failingAdapterSource/);
    assert.match(body.messages[1]?.content ?? "", /Subscriber ID/);
    assert.doesNotMatch(body.messages[1]?.content ?? "", /verifierChecks|frozen_suite|fake-fireworks-key|unit-test-secret-123|DEMO-1001/);
    const spend = db.prepare(`SELECT provider_calls, input_tokens, output_tokens, estimated_cost_usd FROM spend_ledger WHERE run_id = ?`).get(failedRunId) as {
      provider_calls: number; input_tokens: number; output_tokens: number; estimated_cost_usd: number;
    };
    assert.equal(spend.provider_calls, 1);
    assert.equal(spend.input_tokens, 90);
    assert.equal(spend.output_tokens, 15);
    assert.ok(spend.estimated_cost_usd > 0);
    const usage = db.prepare(`SELECT calls FROM repair_model_usage WHERE run_id = ?`).get(failedRunId) as { calls: number };
    assert.equal(usage.calls, 1);
  } finally {
    await shutdown();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
