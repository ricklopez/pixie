import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiKey } from "../src/auth.js";
import { call, PORTAL, publishEligibility, testApp, TOKENS } from "./helpers.js";

test("lifecycle: draft -> configuring -> testing -> ready -> published, revisions immutable", async () => {
  const { app, runs, shutdown } = await testApp();
  const { id, revision } = await publishEligibility(app, runs);
  assert.equal(revision, 1);
  const view = await call(app, TOKENS.developer, "GET", `/studio/automations/${id}`);
  assert.equal(view.json.state, "published");
  const edit = await call(app, TOKENS.developer, "PUT", `/studio/automations/${id}/definition`, view.json.definition);
  assert.equal(edit.status, 409);
  const draft = await call(app, TOKENS.developer, "POST", `/studio/automations/${id}/new-draft`);
  assert.equal(draft.status, 201);
  assert.equal(draft.json.state, "configuring");
  const premature = await call(app, TOKENS.developer, "POST", `/studio/automations/${draft.json.id}/publish`);
  assert.equal(premature.status, 409);
  await shutdown();
});

test("scripted decisions stay separate from provider calls and spend", async () => {
  const { app, runs, shutdown } = await testApp();
  const { id, testRunId } = await publishEligibility(app, runs);
  const listed = await call(app, TOKENS.developer, "GET", `/studio/runs?automationId=${id}`);
  const run = (listed.json as unknown as { id: string; metrics: Record<string, number> }[]).find((entry) => entry.id === testRunId)!;
  assert.equal(run.metrics.modelCalls, 1);
  assert.equal(run.metrics.providerCalls, 0);
  assert.equal(run.metrics.estimatedCostUsd, 0);
  const spend = await call(app, TOKENS.developer, "GET", "/studio/spend");
  assert.deepEqual(spend.json, { rows: [], browserSessionSeconds: 0, total: { providerCalls: 0, inputTokens: 0, estimatedCostUsd: 0 } });
  assert.equal((await call(app, TOKENS.client, "GET", "/studio/spend")).status, 403);
  await shutdown();
});

test("provider metrics and spend ledger are recorded once and scoped to the tenant", async () => {
  const { app, runs, shutdown, db } = await testApp({ providerCalls: 2 });
  const { id, testRunId } = await publishEligibility(app, runs);
  const listed = await call(app, TOKENS.developer, "GET", `/studio/runs?automationId=${id}`);
  const run = (listed.json as unknown as { id: string; metrics: Record<string, number> }[]).find((entry) => entry.id === testRunId)!;
  assert.equal(run.metrics.modelCalls, 1);
  assert.equal(run.metrics.providerCalls, 2);
  assert.equal(run.metrics.inputTokens, 25000);
  assert.equal(run.metrics.estimatedCostUsd, 0.00105);

  const spend = await call(app, TOKENS.developer, "GET", "/studio/spend");
  const row = (spend.json.rows as { runId: string; providerCalls: number; inputTokens: number; estimatedCostUsd: number }[])[0]!;
  assert.equal(row.runId, testRunId);
  assert.equal(row.providerCalls, 2);
  assert.equal(row.inputTokens, 25000);
  assert.equal(row.estimatedCostUsd, 0.00105);
  assert.deepEqual(spend.json.total, { providerCalls: 2, inputTokens: 25000, estimatedCostUsd: 0.00105 });

  createApiKey(db, "tenant_other", "other developer", "developer", "other-dev-token");
  const foreign = await call(app, "other-dev-token", "GET", "/studio/spend");
  assert.deepEqual(foreign.json, { rows: [], browserSessionSeconds: 0, total: { providerCalls: 0, inputTokens: 0, estimatedCostUsd: 0 } });
  await shutdown();
});

test("A12/A4: published endpoint runs a different member and returns typed verified data", async () => {
  const { app, runs, shutdown } = await testApp();
  const { id, revision } = await publishEligibility(app, runs);
  const spec = await call(app, TOKENS.client, "GET", `/v1/automations/${id}/openapi.json`);
  assert.equal(spec.status, 200);
  const schemas = spec.json.components as { schemas: { RunRequest: { properties: { revision: { enum: number[] } } } } };
  assert.deepEqual(schemas.schemas.RunRequest.properties.revision.enum, [1]);

  const started = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1002" } });
  assert.equal(started.status, 202);
  const run = await runs.waitForTerminal(started.json.id!);
  assert.equal(run.state, "completed");
  const result = await call(app, TOKENS.client, "GET", `/v1/automations/${id}/runs/${run.id}/result`);
  assert.equal(result.status, 200);
  const data = result.json.data as Record<string, unknown>;
  assert.equal(data.memberId, "DEMO-1002");
  assert.equal(data.plan, "Synthetic HMO Plus");
  assert.equal(data.annualMaximum, 2000);
  assert.equal(data.deductibleRemaining, 25);
  assert.equal(data.annualMaximumPeriod, "Plan year");
  assert.equal(data.effectiveTo, "2027-02-28");
  assert.equal(typeof data.observedAt, "string");
  const evidence = await call(app, TOKENS.client, "GET", `/v1/automations/${id}/runs/${run.id}/evidence`);
  assert.equal(evidence.status, 200);
  assert.equal((evidence.json.modelDecisions as unknown[]).length, 1);
  const shot = (evidence.json.screenshots as { url: string }[])[0]!;
  const image = await app.inject({ method: "GET", url: shot.url.replace("http://gateway.test", ""), headers: { authorization: `Bearer ${TOKENS.client}` } });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/jpeg");
  const anonymous = await app.inject({ method: "GET", url: shot.url.replace("http://gateway.test", "") });
  assert.equal(anonymous.statusCode, 401);
  await shutdown();
});

test("A5/A6: wrong identity and incomplete portal results are rejected as needs_review with no data", async () => {
  const { app, runs, shutdown } = await testApp();
  const { id, revision } = await publishEligibility(app, runs);
  for (const [memberId, expectedReason] of [
    ["DEMO-2001", "identity"],
    ["DEMO-3001", "required output"]
  ] as const) {
    const started = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId } });
    const run = await runs.waitForTerminal(started.json.id!);
    assert.equal(run.state, "needs_review", memberId);
    const result = await call(app, TOKENS.client, "GET", `/v1/automations/${id}/runs/${run.id}/result`);
    assert.equal(result.status, 409);
    assert.equal(result.json.data, undefined);
    const failure = result.json.failure as { reasons: string[] };
    assert.ok(failure.reasons.some((r) => r.toLowerCase().includes(expectedReason)), JSON.stringify(failure));
  }
  await shutdown();
});

test("A7/A8: model outage fails explicitly; expired login becomes awaiting_auth", async () => {
  const down = await testApp({ mode: "model-down" });
  const pub = await call(down.app, TOKENS.developer, "POST", "/studio/automations", { name: "E", startUrl: "http://127.0.0.1:4174/demo-portal", template: "eligibility-overview" });
  await call(down.app, TOKENS.developer, "PUT", `/studio/automations/${pub.json.id}/definition`, pub.json.definition);
  const test = await call(down.app, TOKENS.developer, "POST", `/studio/automations/${pub.json.id}/test`, { accountId: "acct_demo", input: { memberId: "DEMO-1001" } });
  const run = await down.runs.waitForTerminal(test.json.id!);
  assert.equal(run.state, "failed");
  assert.match(JSON.parse(run.failure!).reason, /HTTP 503/);
  await new Promise((r) => setTimeout(r, 10));
  const after = await call(down.app, TOKENS.developer, "GET", `/studio/automations/${pub.json.id}`);
  assert.equal(after.json.state, "configuring");
  await down.shutdown();

  const { app, runs, shutdown } = await testApp();
  const { id, revision } = await publishEligibility(app, runs);
  const started = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-LOGIN" } });
  const login = await runs.waitForTerminal(started.json.id!);
  assert.equal(login.state, "awaiting_auth");
  await shutdown();
});

test("A9: tenant isolation for automations, accounts, runs and evidence", async () => {
  const { app, runs, shutdown } = await testApp();
  const { id, revision } = await publishEligibility(app, runs);
  const foreign = await call(app, TOKENS.otherTenantClient, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1001" } });
  assert.equal(foreign.status, 404);
  const wrongAccount = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_other", input: { memberId: "DEMO-1001" } });
  assert.equal(wrongAccount.status, 403);
  const started = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1001" } });
  await runs.waitForTerminal(started.json.id!);
  for (const path of ["", "/result", "/evidence"]) {
    const res = await call(app, TOKENS.otherTenantClient, "GET", `/v1/automations/${id}/runs/${started.json.id}${path}`);
    assert.equal(res.status, 404, path);
  }
  const list = await call(app, TOKENS.otherTenantClient, "GET", "/v1/automations");
  assert.deepEqual(list.json, []);
  const devOnly = await call(app, TOKENS.client, "GET", "/studio/automations");
  assert.equal(devOnly.status, 403);
  await shutdown();
});

test("A10: explicit revision, idempotency scoped to caller/account/revision/body, invalid input rejected", async () => {
  const { app, runs, shutdown } = await testApp();
  const { id, revision } = await publishEligibility(app, runs);
  const noRevision = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { accountId: "acct_demo", input: { memberId: "DEMO-1001" } });
  assert.equal(noRevision.status, 400);
  const unknownRevision = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision: 7, accountId: "acct_demo", input: { memberId: "DEMO-1001" } });
  assert.equal(unknownRevision.status, 400);
  const badInput = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: 42, extra: true } });
  assert.equal(badInput.status, 400);
  assert.equal((badInput.json.details as string[]).length, 2);

  const headers = { "idempotency-key": "req-1" };
  const first = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1001" } }, headers);
  const replay = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1001" } }, headers);
  assert.equal(first.status, 202);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, first.json.id);
  const conflict = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1002" } }, headers);
  assert.equal(conflict.status, 409);
  await runs.waitForTerminal(first.json.id!);
  await shutdown();
});

test("A11: one active run per account (FIFO) and cancellation of queued/running runs", async () => {
  const { app, runs, runner, shutdown } = await testApp({ delayMs: 150 });
  const { id, revision } = await publishEligibility(app, runs);
  const a = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1001" } });
  const b = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1002" } });
  const c = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1002" } });
  assert.equal(runs.get(a.json.id!)!.state, "running");
  assert.equal(runs.get(b.json.id!)!.state, "queued");
  const cancelQueued = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs/${c.json.id}/cancel`);
  assert.equal(cancelQueued.status, 202);
  assert.equal(runs.get(c.json.id!)!.state, "cancelled");
  const cancelRunning = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs/${a.json.id}/cancel`);
  assert.equal(cancelRunning.status, 202);
  const finishedA = await runs.waitForTerminal(a.json.id!);
  assert.equal(finishedA.state, "cancelled");
  const finishedB = await runs.waitForTerminal(b.json.id!);
  assert.equal(finishedB.state, "completed");
  assert.equal(runner.commands.length, 3); // the test run plus a and b; c never started
  const again = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs/${b.json.id}/cancel`);
  assert.equal(again.status, 409);
  await shutdown();
});

test("A13: secrets are passed to the worker but never to callers or evidence", async () => {
  const { app, runs, runner, shutdown } = await testApp();
  await call(app, TOKENS.developer, "PUT", "/studio/accounts/acct_demo/secrets", { portalPassword: "synthetic-secret-value" });
  const { id, revision, testRunId } = await publishEligibility(app, runs);
  assert.equal(runner.commands[0]!.secrets.portalPassword, "synthetic-secret-value");
  const started = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1001" } });
  await runs.waitForTerminal(started.json.id!);
  for (const url of [`/v1/automations/${id}/runs/${started.json.id}/evidence`, `/studio/runs/${testRunId}`, `/studio/automations/${id}/export`]) {
    const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${url.startsWith("/v1") ? TOKENS.client : TOKENS.developer}` } });
    assert.equal(res.statusCode, 200, url);
    assert.ok(!res.body.includes("synthetic-secret-value"), url);
  }
  const accounts = await call(app, TOKENS.developer, "GET", "/studio/accounts");
  assert.ok(!JSON.stringify(accounts.json).includes("synthetic-secret-value"));
  await shutdown();
});

test("A14: review export carries definitions, schemas, assertions, synthetic tests and OpenAPI, never runtime values, identities or browser state", async () => {
  const { app, runs, shutdown } = await testApp();
  await call(app, TOKENS.developer, "PUT", "/studio/accounts/acct_demo/secrets", { portalPassword: "synthetic-secret-value" });
  const draft = await call(app, TOKENS.developer, "POST", "/studio/automations", { name: "unpublished", startUrl: `${PORTAL}/login` });
  assert.equal((await call(app, TOKENS.developer, "GET", `/studio/automations/${draft.json.id}/export`)).status, 409);

  const { id, revision, testRunId } = await publishEligibility(app, runs);
  const ok = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1002" } }, { "idempotency-key": "export-key-1" });
  await runs.waitForTerminal(ok.json.id!);
  const rejected = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-2001" } }, { "idempotency-key": "export-key-2" });
  await runs.waitForTerminal(rejected.json.id!);
  // Canaries: a caller input carrying PII/secret-looking values, whose run fails with a message quoting that input.
  const canaryInput = "SSN 123-45-6789 jane.doe@example.com sk-live-CANARY";
  const canary = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: canaryInput } }, { "idempotency-key": "export-key-3" });
  assert.equal(canary.status, 202);
  await runs.waitForTerminal(canary.json.id!);
  const canaryRun = await call(app, TOKENS.client, "GET", `/v1/automations/${id}/runs/${canary.json.id}`);
  assert.equal(canaryRun.json.state, "needs_review");
  assert.ok(JSON.stringify(canaryRun.json).includes("123-45-6789"), "precondition: the run's own failure message quotes the caller input");

  const res = await call(app, TOKENS.developer, "GET", `/studio/automations/${id}/export`);
  assert.equal(res.status, 200);
  const files = res.json.files as Record<string, string>;
  const dir = `automations/${id}/revision-${revision}`;
  for (const name of [`${dir}/definition.json`, `${dir}/input.schema.json`, `${dir}/output.schema.json`, `${dir}/assertions.json`, `${dir}/REVISION.md`, `automations/${id}/REVIEW.md`, `tests/${id}/revision-${revision}.synthetic.json`, `openapi/${id}.json`]) {
    assert.ok(files[name], name);
  }
  const revisionRow = (await call(app, TOKENS.developer, "GET", `/studio/automations/${id}`)).json.revisions as { checksum: string; publishedBy?: string }[];
  assert.ok(files[`${dir}/REVISION.md`]!.includes(revisionRow[0]!.checksum));
  const tests = JSON.parse(files[`tests/${id}/revision-${revision}.synthetic.json`]!) as {
    fixture: Record<string, unknown>;
    outcomes: { runId: string; kind: string; state: string; accepted: boolean; checks: { id: string; passed: boolean }[] }[];
  };
  assert.deepEqual(tests.fixture, { memberId: "synthetic-memberId" }, "fixture is derived from the schema, not from any run");
  const gate = tests.outcomes.find((c) => c.runId === testRunId)!;
  assert.equal(gate.kind, "publication-gate");
  assert.equal(gate.accepted, true);
  assert.equal(tests.outcomes.find((c) => c.runId === rejected.json.id)!.accepted, false);
  assert.ok(tests.outcomes.find((c) => c.runId === ok.json.id)!.checks.length > 0);
  const canaryOutcome = tests.outcomes.find((c) => c.runId === canary.json.id)!;
  assert.deepEqual(Object.keys(canaryOutcome).sort(), ["accepted", "checks", "kind", "runId", "state"], "no input, failure or message fields per outcome");
  assert.ok(files[`automations/${id}/REVIEW.md`]!.includes("No automated code review"));

  const whole = JSON.stringify(res.json);
  for (const forbidden of [
    "123-45-6789",
    "jane.doe@example.com",
    "sk-live-CANARY",
    "No member",
    "DEMO-1002",
    "DEMO-2001",
    "synthetic-secret-value",
    "export-key-1",
    "export-key-2",
    "export-key-3",
    "search-form-after.jpg",
    "studio developer",
    "published_by",
    "publishedBy",
    TOKENS.client,
    TOKENS.developer
  ]) {
    assert.ok(!whole.includes(forbidden), `export leaked ${forbidden}`);
  }
  const body = JSON.stringify(Object.fromEntries(Object.entries(files).filter(([name]) => !name.endsWith(".md"))));
  for (const forbidden of ["/evidence/", "cdpUrl", "userDataDir", "cookie", "localStorage"]) {
    assert.ok(!body.includes(forbidden), `export leaked ${forbidden}`);
  }
  for (const forbidden of ["reason", "message", "failure", "input", "detail"]) {
    assert.ok(!files[`tests/${id}/revision-${revision}.synthetic.json`]!.includes(`"${forbidden}"`), `synthetic tests carry ${forbidden}`);
  }
  assert.equal((await call(app, TOKENS.otherTenantClient, "GET", `/studio/automations/${id}/export`)).status, 403);
  await shutdown();
});

test("origin policy: non-loopback HTTP and private destinations cannot become automations", async () => {
  const { app, shutdown } = await testApp();
  const insecure = await call(app, TOKENS.developer, "POST", "/studio/automations", { name: "x", startUrl: "http://portal.example.com/login" });
  assert.equal(insecure.status, 400);
  const metadata = await call(app, TOKENS.developer, "POST", "/studio/automations", { name: "x", startUrl: "https://169.254.169.254/latest" });
  assert.equal(metadata.status, 400);
  await shutdown();
});
