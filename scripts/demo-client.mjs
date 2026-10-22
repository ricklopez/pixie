#!/usr/bin/env node
// Separate HTTP client exercising a published Gateway endpoint set. Uses only the public /v1 surface.
// Usage: node scripts/demo-client.mjs <automationId> <revision> <memberId> [accountId]
const [automationId, revisionArg, memberId = "DEMO-1002", accountId = "acct_demo"] = process.argv.slice(2);
const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:4180";
const token = process.env.GATEWAY_CLIENT_TOKEN ?? "client-token-local";
if (!automationId || !revisionArg) {
  console.error("usage: demo-client.mjs <automationId> <revision> [memberId] [accountId]");
  process.exit(2);
}
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `demo-${memberId}-${Date.now()}` };
const t0 = performance.now();
const started = await fetch(`${base}/v1/automations/${automationId}/runs`, {
  method: "POST",
  headers,
  body: JSON.stringify({ revision: Number(revisionArg), accountId, input: { memberId } })
});
const run = await started.json();
console.log(`POST runs -> ${started.status} run=${run.id} state=${run.state}`);
if (!started.ok) process.exit(1);
let result;
for (;;) {
  const res = await fetch(`${base}/v1/automations/${automationId}/runs/${run.id}/result`, { headers });
  result = { status: res.status, body: await res.json() };
  if (res.status !== 202) break;
  await new Promise((r) => setTimeout(r, 500));
}
const wall = Math.round(performance.now() - t0);
console.log(`GET result -> ${result.status} after ${wall} ms`);
console.log(JSON.stringify(result.body, null, 2));
const evidence = await fetch(`${base}/v1/automations/${automationId}/runs/${run.id}/evidence`, { headers }).then((r) => r.json());
const m = evidence.run?.metrics ?? {};
console.log(`metrics: engine=${m.engine} modelCalls=${m.modelCalls} actions=${m.actions} elapsedMs=${m.elapsedMs} modelLatencyMs=${JSON.stringify(m.modelLatencyMs)} policyRejections=${m.policyRejections}`);
process.exit(result.status === 200 ? 0 : 3);
