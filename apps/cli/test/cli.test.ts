import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { doctorChecks, init, loadProject, main } from "../src/main.js";

interface RequestRecord {
  method: string;
  url: string;
  auth: string | undefined;
  idempotencyKey: string | undefined;
  contractVersion: string | undefined;
  body: unknown;
}

const capture = () => {
  const lines: string[] = [];
  return { lines, out: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(`ERR ${line}`) } };
};

const automation = {
  id: "auto-1",
  name: "Synthetic eligibility",
  state: "configuring",
  definition: {
    id: "auto-1",
    name: "Synthetic eligibility",
    startUrl: "http://127.0.0.1:4174/demo-portal",
    allowedOrigins: ["http://127.0.0.1:4174"]
  },
  revisions: []
};

const verification = {
  accepted: true,
  checks: Array.from({ length: 16 }, (_, index) => ({ id: `check-${index + 1}`, passed: true })),
  reasons: []
};

async function withApi(run: (baseUrl: string, requests: RequestRecord[]) => Promise<void>): Promise<void> {
  const requests: RequestRecord[] = [];
  let testPolls = 0;
  let publicRunCreated = false;
  let connectionPolls = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (raw) {
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          body = raw;
        }
      }
      const record: RequestRecord = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization,
        idempotencyKey: req.headers["idempotency-key"] as string | undefined,
        contractVersion: req.headers["pixie-contract-version"] as string | undefined,
        body
      };
      requests.push(record);
      const send = (status: number, response: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      };
      const url = new URL(record.url, "http://127.0.0.1");
      const path = url.pathname;
      if (path === "/mcp") {
        const rpc = record.body as { method?: string; id?: string | number; params?: { protocolVersion?: string } };
        if (rpc?.method === "notifications/initialized") {
          res.writeHead(202, { "mcp-session-id": "stub-session" });
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "stub-session" });
        res.end(JSON.stringify(rpc?.method === "tools/call"
          ? { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "{\"runId\":\"run-1\"}" }] } }
          : { jsonrpc: "2.0", id: rpc?.id, result: { protocolVersion: rpc?.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } }));
        return;
      }

      if (path.startsWith("/studio/") && record.auth === "Bearer client-test-token") {
        return send(403, { error: "forbidden: developer key required" });
      }
      if (path === "/studio/accounts" && record.method === "GET") {
        return send(200, [{ id: "acct_demo", name: "Demo", portalOrigin: "http://127.0.0.1:4174" }]);
      }
      if (path === "/studio/accounts" && record.method === "POST") return send(201, { id: "acct-created" });
      if (path === "/studio/connections" && record.method === "GET") return send(200, [{ id: "connection-1", accountId: "acct_demo", accountName: "Demo", environment: "production", state: "connected" }]);
      if (path === "/studio/connections" && record.method === "POST") return send(201, { id: "connection-1", accountId: "acct_demo", environment: "production", state: "disconnected" });
      if (path === "/studio/connections/connection-1/connect" && record.method === "POST") return send(201, { id: "connection-1", state: "connecting" });
      if (path === "/studio/connections/connection-1" && record.method === "GET") {
        connectionPolls += 1;
        return send(200, { id: "connection-1", state: connectionPolls > 1 ? "connected" : "connecting" });
      }
      if (path === "/studio/connections/connection-1/disconnect" && record.method === "POST") return send(200, { id: "connection-1", state: "disconnected", contextCleanup: "deleted" });
      if (path === "/studio/accounts/acct-demo/secrets" && record.method === "PUT") return send(200, { stored: ["ref"] });
      if (path === "/studio/automations" && record.method === "GET") return send(200, [automation]);
      if (path === "/studio/automations" && record.method === "POST") {
        const request = record.body as Record<string, unknown>;
        return send(201, { ...automation, name: request.name, id: "auto-created" });
      }
      if (path === "/studio/automations/auto-1" && record.method === "GET") return send(200, automation);
      if (path === "/studio/automations/auto-1/recording/start" && record.method === "POST") {
        return send(201, { id: "recording-1", state: "recording", currentUrl: "http://127.0.0.1:4174/demo-portal" });
      }
      if (path === "/studio/automations/auto-1/recording/status" && record.method === "GET") {
        return send(200, { id: "recording-1", state: "recording" });
      }
      if (path === "/studio/automations/auto-1/recording/stop" && record.method === "POST") {
        return send(200, {
          id: "recording-1",
          actionCount: 1,
          events: [{ seq: 1, kind: "click", target: { label: "Search" } }],
          warnings: [],
          suggestion: { checkpoints: [], inputs: [], unbound: [] }
        });
      }
      if (path === "/studio/automations/auto-1/definition" && record.method === "PUT") {
        return send(200, { ...automation, state: "configuring", checksum: "definition-checksum" });
      }
      if (path === "/studio/automations/auto-invalid/definition" && record.method === "PUT") {
        return send(400, { error: "definition validation failed", issues: [{ path: "workflow", message: "must contain an action" }] });
      }
      if (path === "/studio/automations/auto-1/test" && record.method === "POST") return send(202, { id: "test-run-1", state: "queued" });
      if (path === "/studio/automations/auto-2/test" && record.method === "POST") return send(202, { id: "review-run", state: "queued" });
      if (path === "/studio/runs/test-run-1" && record.method === "GET") {
        testPolls += 1;
        return send(200, {
          run: {
            id: "test-run-1",
            automationId: "auto-1",
            state: testPolls === 1 ? "running" : "completed",
            metrics: { engine: "scripted (offline)", modelCalls: 3, providerCalls: 0, estimatedCostUsd: 0, actions: 4, elapsedMs: 12 }
          },
          verification,
          data: { memberId: "DEMO-1001" },
          screenshots: [],
          timeline: [{ seq: 1, at: "now", event: { type: "action", action: "click" } }]
        });
      }
      if (path === "/studio/runs/review-run" && record.method === "GET") {
        return send(200, {
          run: { id: "review-run", state: "needs_review", failure: { reason: "verification rejected" } },
          verification: { accepted: false, checks: [{ id: "identity", passed: false, detail: "member mismatch" }], reasons: [] },
          data: null,
          screenshots: [{}]
        });
      }
      if (path === "/studio/automations/auto-1/publish" && record.method === "POST") {
        return send(201, { automationId: "auto-1", revision: 1, checksum: "published-checksum", openapiUrl: "http://127.0.0.1:4180/v1/automations/auto-1/openapi.json" });
      }
      if (path === "/studio/models" && record.method === "GET") return send(200, [{ name: "repo.get.output", major: 1, minor: 0, identityFields: ["memberId"] }]);
      if (path === "/studio/repositories" && record.method === "GET") return send(200, [{ name: "repo", operationCount: 1 }]);
      if (path === "/studio/operations" && record.method === "GET") return send(200, [{ repository: "repo", method: "get", version: "1.0", adapterRevision: 1 }]);
      if (path === "/studio/automations/auto-1/contract" && record.method === "GET") return send(200, {
        repository: "repo", method: "get", compatibility: { level: "minor", changes: [{ path: "outputs.note", kind: "optional_added" }] },
        current: { major: 1, minor: 0, adapterRevision: 1 }, next: { major: 1, minor: 1, adapterRevision: 1 }
      });
      if (path === "/studio/operations/op-1/retire" && record.method === "POST") return send(200, { operation: { repository: "repo", method: "get", version: "1.0" }, bindings: [{ major: 1 }] });
      if (path === "/studio/automations/auto-unready/publish" && record.method === "POST") {
        return send(409, { error: "only automations in state 'ready' can be published" });
      }
      if (path === "/studio/automations/auto-1/new-draft" && record.method === "POST") return send(201, { ...automation, id: "auto-draft" });
      if (path === "/studio/automations/auto-1/generated" && ["GET", "POST"].includes(record.method)) {
        return send(200, { source: "export async function run() {}", hash: "generated-hash", unsupported: [] });
      }
      if (path === "/studio/automations/auto-1/repairs" && record.method === "POST") return send(201, { id: "repair-1", state: "awaiting_approval", gates: [] });
      if (path === "/studio/automations/auto-1/repairs" && record.method === "GET") return send(200, [{ id: "repair-1", state: "awaiting_approval", gates: [] }]);
      if (path === "/studio/repairs/repair-1/approve" && record.method === "POST") return send(200, { id: "repair-1", state: "approved" });
      if (path === "/studio/repairs/repair-1/reject" && record.method === "POST") return send(200, { id: "repair-1", state: "rejected" });
      if (path === "/studio/automations/auto-1/bindings/rollback" && record.method === "POST") return send(200, { automationId: "auto-1", adapterRevisionId: "previous" });
      if (path === "/studio/automations/auto-1/openapi.json" && record.method === "GET") return send(200, { openapi: "3.1.0", paths: {} });
      if (path === "/studio/automations/auto-1/export" && record.method === "GET") return send(200, { files: { "README.md": "# export" } });
      if (path === "/studio/api-keys" && record.method === "POST") return send(201, { id: "key-1", token: "newly-created-token" });
      if (path === "/studio/runs" && record.method === "GET") {
        return send(200, [{ id: "test-run-1", automationId: "auto-1", state: "completed", kind: "test", revision: 0 }]);
      }
      if (path === "/studio/spend" && record.method === "GET") {
        return send(200, {
          rows: [{ runId: "live-run-1", at: "2026-09-25T12:00:00.000Z", providerCalls: 2, inputTokens: 25000, estimatedCostUsd: 0.00105 }],
          total: { providerCalls: 2, inputTokens: 25000, estimatedCostUsd: 0.00105 }
        });
      }
      if (path === "/studio/runs/unknown-run" && record.method === "GET") return send(404, { error: "not found" });
      if (path === "/studio/runs/test-run-1/cancel" && record.method === "POST") return send(202, { ok: true });
      if (path === "/v1/automations" && record.method === "GET") {
        return send(200, [{ id: "auto-1", revisions: [{ revision: 1 }] }]);
      }
      if (path === "/v1/automations/auto-1/runs" && record.method === "POST") {
        const reused = publicRunCreated;
        publicRunCreated = true;
        return send(reused ? 200 : 202, { id: "public-run-1", state: "queued", reused });
      }
      if (path === "/v1/automations/auto-1/runs/public-run-1" && record.method === "GET") {
        return send(200, {
          id: "public-run-1",
          automationId: "auto-1",
          state: "completed",
          metrics: { engine: "scripted", modelCalls: 3, providerCalls: 0, estimatedCostUsd: 0, actions: 4, elapsedMs: 12 }
        });
      }
      if (path === "/v1/automations/auto-1/runs/public-run-1/result" && record.method === "GET") {
        return send(200, { runId: "public-run-1", automationId: "auto-1", accepted: true, data: { memberId: "DEMO-1002" }, checks: verification.checks, observedAt: "now" });
      }
      if (path === "/v1/repositories/repo/operations/get/runs" && record.method === "POST") return send(202, { id: "contract-run", state: "queued" });
      if (path === "/v1/repositories/repo/operations/get/runs/contract-run" && record.method === "GET") return send(200, { id: "contract-run", state: "completed" });
      if (path === "/v1/repositories/repo/operations/get/runs/contract-run/result" && record.method === "GET") return send(200, { runId: "contract-run", accepted: true, data: {}, checks: verification.checks });
      return send(404, { error: "not found" });
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cwd = mkdtempSync(resolve(tmpdir(), "pixie-cli-test-"));
  writeFileSync(resolve(cwd, "pixie.json"), JSON.stringify({ apiUrl: baseUrl, accountId: "acct_test", clientToken: "client-config-token" }));
  const previousCwd = process.cwd();
  const previousEnv = {
    dev: process.env.GATEWAY_DEV_TOKEN,
    client: process.env.GATEWAY_CLIENT_TOKEN,
    browser: process.env.BROWSER
  };
  process.chdir(cwd);
  process.env.GATEWAY_DEV_TOKEN = "dev-test-token";
  process.env.GATEWAY_CLIENT_TOKEN = "client-test-token";
  delete process.env.BROWSER;
  try {
    await run(baseUrl, requests);
  } finally {
    process.chdir(previousCwd);
    if (previousEnv.dev === undefined) delete process.env.GATEWAY_DEV_TOKEN;
    else process.env.GATEWAY_DEV_TOKEN = previousEnv.dev;
    if (previousEnv.client === undefined) delete process.env.GATEWAY_CLIENT_TOKEN;
    else process.env.GATEWAY_CLIENT_TOKEN = previousEnv.client;
    if (previousEnv.browser === undefined) delete process.env.BROWSER;
    else process.env.BROWSER = previousEnv.browser;
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())));
  }
}

test("pixie init uses local synthetic defaults, never writes credentials, and refuses overwrite", () => {
  const dir = resolve(mkdtempSync(resolve(tmpdir(), "pixie-init-")), "proj");
  const { lines, out } = capture();
  assert.equal(init(dir, out), 0);
  assert.ok(existsSync(resolve(dir, "pixie.json")));
  assert.ok(!existsSync(resolve(dir, ".env")), "init must not create a secrets file");
  assert.equal(loadProject(dir).accountId, "acct_demo");
  assert.equal(loadProject(dir).portalOrigin, "http://127.0.0.1:4174");
  writeFileSync(resolve(dir, "pixie.json"), JSON.stringify({ accountId: "acct_mine" }));
  assert.equal(init(dir, out), 1);
  assert.equal(loadProject(dir).accountId, "acct_mine", "existing pixie.json untouched");
  assert.ok(lines.some((line) => line.includes("refusing")));
  assert.equal(readFileSync(resolve(dir, ".env.example"), "utf8").includes("TYPESAFE_API_KEY="), true);
});

test("generate and reviewed repair lifecycle commands use their shared API routes", async () => {
  await withApi(async (_baseUrl, requests) => {
    const recording = new URL("../../../fixtures/recorded-eligibility.json", import.meta.url);
    const generated = capture();
    assert.equal(await main(["generate", "auto-1", "--recording", recording.pathname, "--json"], generated.out), 0);
    assert.equal(JSON.parse(generated.lines[0]!).hash, "generated-hash");

    const sourceFile = resolve(process.cwd(), "repair-adapter.mjs");
    writeFileSync(sourceFile, "export async function run(page, input) { return {}; }\n");
    const repaired = capture();
    assert.equal(await main(["repair", "auto-1", "--run", "run-1", "--source", sourceFile, "--json"], repaired.out), 0);
    assert.equal(JSON.parse(repaired.lines[0]!).id, "repair-1");
    const repairs = capture();
    assert.equal(await main(["repairs", "auto-1", "--json"], repairs.out), 0);
    assert.equal(JSON.parse(repairs.lines[0]!).length, 1);
    assert.equal(await main(["approve", "repair-1", "--json"], capture().out), 0);
    assert.equal(await main(["reject", "repair-1", "--reason", "not safe", "--json"], capture().out), 0);
    assert.equal(await main(["rollback", "auto-1", "--json"], capture().out), 0);

    const generatedRequest = requests.find((request) => request.url === "/studio/automations/auto-1/generated" && request.method === "POST")!;
    assert.ok(generatedRequest.body && typeof generatedRequest.body === "object" && "recording" in generatedRequest.body);
    const repairRequest = requests.find((request) => request.url === "/studio/automations/auto-1/repairs")!;
    assert.deepEqual(repairRequest.body, { runId: "run-1", source: "export async function run(page, input) { return {}; }\n", model: false });
    const listRepairsRequest = requests.find((request) => request.url === "/studio/automations/auto-1/repairs" && request.method === "GET")!;
    assert.equal(listRepairsRequest.body, null);
    assert.ok(requests.some((request) => request.url === "/studio/repairs/repair-1/approve"));
    assert.ok(requests.some((request) => request.url === "/studio/repairs/repair-1/reject" && (request.body as { reason?: string }).reason === "not safe"));
    assert.ok(requests.some((request) => request.url === "/studio/automations/auto-1/bindings/rollback"));
  });
});

test("MCP CLI config uses an environment reference and call sends the client token", async () => {
  await withApi(async (baseUrl, requests) => {
    const config = capture();
    assert.equal(await main(["mcp", "config", "--client-token-env", "PIXIE_CLIENT"], config.out), 0);
    assert.match(config.lines.join("\n"), new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/mcp`));
    assert.match(config.lines.join("\n"), /\$\{PIXIE_CLIENT\}/);
    assert.doesNotMatch(config.lines.join("\n"), /client-config-token|client-test-token/);
    const called = capture();
    assert.equal(await main(["mcp", "call", "list_operations", "--args", "{}"], called.out), 0);
    assert.match(called.lines[0] ?? "", /runId/);
    const mcpRequests = requests.filter((request) => request.url === "/mcp");
    assert.ok(mcpRequests.length >= 3);
    assert.ok(mcpRequests.some((request) => (request.body as { method?: string })?.method === "tools/call"));
    assert.ok(mcpRequests.every((request) => request.auth === "Bearer client-test-token"));
  });
});

test("pixie doctor reports a missing live model variable and unreachable services", async () => {
  const project = { ...loadProject("/nonexistent"), apiUrl: "http://127.0.0.1:1", studioUrl: "http://127.0.0.1:1" };
  const checks = await doctorChecks(project, { PATH: process.env.PATH }, mkdtempSync(resolve(tmpdir(), "pixie-empty-")));
  const byName = (prefix: string) => checks.find((check) => check.name.startsWith(prefix))!;
  assert.deepEqual([byName("TYPESAFE_API_KEY").ok, byName("TYPESAFE_API_KEY").level], [false, "fail"]);
  assert.equal(byName("worker environment").ok, false);
  assert.equal(byName("gateway built").ok, false);
  assert.deepEqual([byName("API at").ok, byName("API at").level], [false, "warn"]);
  const scripted = await doctorChecks({ ...project, engine: "scripted" }, { PATH: process.env.PATH });
  assert.deepEqual([byName("TYPESAFE_API_KEY").level, scripted.find((check) => check.name.startsWith("TYPESAFE"))!.ok], ["fail", true]);
});

test("all required command shapes reject missing arguments with usage exit code 2", async () => {
  await withApi(async (_baseUrl, requests) => {
    const invalid: string[][] = [
      ["accounts", "add"],
      ["accounts", "secret", "acct-demo"],
      ["create"],
      ["create", "Demo"],
      ["show"],
      ["record"],
      ["record", "start"],
      ["record", "status"],
      ["record", "stop"],
      ["definition"],
      ["definition", "get"],
      ["definition", "set", "auto-1"],
      ["draft"],
      ["test"],
      ["publish"],
      ["run"],
      ["cancel"],
      ["invoke", "auto-1"],
      ["openapi"],
      ["export"],
      ["keys"],
      ["keys", "create"],
      ["keys", "create", "name"]
    ];
    for (const args of invalid) {
      const { lines, out } = capture();
      assert.equal(await main(args, out), 2, args.join(" "));
      assert.ok(lines.some((line) => line.startsWith("ERR usage:")), args.join(" "));
    }
    const unknown = capture();
    assert.equal(await main(["create", "Demo", "--unknown"], unknown.out), 2);
    assert.ok(unknown.lines.some((line) => line.includes("pixie create:")));
    assert.equal(requests.length, 0);
  });
});

test("Studio commands use the developer token, JSON output is API JSON, and unsafe secrets are not printed", async () => {
  await withApi(async (_baseUrl, requests) => {
    const cases: string[][] = [
      ["--json", "accounts", "list"],
      ["accounts", "add", "--name", "Demo account", "--origin", "http://127.0.0.1:4174", "--id", "acct-demo", "--json"],
      ["create", "Synthetic eligibility", "--url", "http://127.0.0.1:4174/demo-portal", "--template", "eligibility-overview", "--allowed-origin", "http://127.0.0.1:4174", "--json"],
      ["show", "auto-1", "--json"],
      ["record", "start", "auto-1", "--json"],
      ["record", "status", "auto-1", "--json"],
      ["record", "stop", "auto-1", "--json"],
      ["definition", "get", "auto-1", "--json"],
      ["definition", "set", "auto-1", "definition.json", "--json"],
      ["draft", "auto-1", "--json"],
      ["test", "auto-1", "--follow", "--json"],
      ["publish", "auto-1", "--json"],
      ["runs", "--automation", "auto-1", "--json"],
      ["spend", "--json"],
      ["run", "test-run-1", "--events", "--json"],
      ["cancel", "test-run-1", "--json"],
      ["openapi", "auto-1", "--json"],
      ["export", "auto-1", "--json"],
      ["open", "auto-1", "--json"],
      ["open", "test-run-1", "--json"]
    ];
    writeFileSync(resolve(process.cwd(), "definition.json"), JSON.stringify(automation.definition));
    for (const args of cases) {
      const { lines, out } = capture();
      const code = await main(args, out);
      assert.equal(code, 0, args.join(" "));
      assert.equal(lines.length, 1, args.join(" "));
      assert.doesNotThrow(() => JSON.parse(lines[0]!), args.join(" "));
    }
    const create = requests.find((request) => request.method === "POST" && request.url === "/studio/automations")!;
    assert.deepEqual(create.body, {
      name: "Synthetic eligibility",
      startUrl: "http://127.0.0.1:4174/demo-portal",
      template: "eligibility-overview",
      allowedOrigins: ["http://127.0.0.1:4174"]
    });
    assert.ok(requests.every((request) => !request.url.startsWith("/studio/") || request.auth === "Bearer dev-test-token"));
    const { lines: keyLines, out: keyOut } = capture();
    assert.equal(await main(["keys", "create", "one-time", "--role", "client"], keyOut), 0);
    assert.equal(keyLines.join("\n").split("newly-created-token").length - 1, 1);
    assert.doesNotMatch(keyLines.join("\n"), /dev-test-token|client-test-token/);
    const jsonKey = capture();
    assert.equal(await main(["keys", "create", "json-key", "--role", "developer", "--json"], jsonKey.out), 0);
    assert.ok(jsonKey.lines.some((line) => line.includes("shown once")));
    const jsonKeyBody = jsonKey.lines.find((line) => line.startsWith("{"))!;
    const jsonKeyResult = JSON.parse(jsonKeyBody) as { token: string };
    assert.equal(jsonKeyResult.token, "newly-created-token");
  });
});

test("test --follow reports state, verification, and API-labelled scripted decisions", async () => {
  await withApi(async (_baseUrl, requests) => {
    const { lines, out } = capture();
    assert.equal(await main(["test", "auto-1", "--account", "acct_demo", "--input", "{\"memberId\":\"DEMO-1001\"}", "--follow"], out), 0);
    assert.ok(lines.some((line) => line === "state: completed"));
    assert.ok(lines.some((line) => line.includes("verification: accepted (16/16 checks passed)")));
    assert.ok(lines.some((line) => line.includes("scripted decisions=3")));
    assert.ok(lines.some((line) => line.includes("providerCalls=0 estimatedCostUsd=$0.000000")));
    const start = requests.find((request) => request.url === "/studio/automations/auto-1/test")!;
    assert.deepEqual(start.body, { accountId: "acct_demo", input: { memberId: "DEMO-1001" } });
  });
});

test("spend prints the API ledger and preserves raw JSON output", async () => {
  await withApi(async (_baseUrl, requests) => {
    const { lines, out } = capture();
    assert.equal(await main(["spend"], out), 0);
    assert.ok(lines.some((line) => line.includes("total estimated spend: $0.001050 (2 provider calls, 25000 input tokens)")));
    assert.ok(lines.some((line) => line.includes("run=live-run-1") && line.includes("estimatedCostUsd=$0.001050")));

    const json = capture();
    assert.equal(await main(["--json", "spend"], json.out), 0);
    assert.deepEqual(JSON.parse(json.lines[0]!), {
      rows: [{ runId: "live-run-1", at: "2026-09-25T12:00:00.000Z", providerCalls: 2, inputTokens: 25000, estimatedCostUsd: 0.00105 }],
      total: { providerCalls: 2, inputTokens: 25000, estimatedCostUsd: 0.00105 }
    });
    const request = requests.find((item) => item.url === "/studio/spend")!;
    assert.equal(request.auth, "Bearer dev-test-token");
  });
});

test("test --follow returns nonzero for needs_review and never prints unaccepted data", async () => {
  await withApi(async () => {
    const { lines, out } = capture();
    assert.equal(await main(["test", "auto-2", "--follow"], out), 1);
    assert.ok(lines.some((line) => line === "state: needs_review"));
    assert.ok(lines.some((line) => line.includes("verification: rejected")));
    assert.ok(!lines.some((line) => line.startsWith("data:")));
  });
});

test("negative cases surface API validation, role rejection, unknown runs, and invalid definition files", async () => {
  await withApi(async (_baseUrl, requests) => {
    const previousDevToken = process.env.GATEWAY_DEV_TOKEN;
    process.env.GATEWAY_DEV_TOKEN = "client-test-token";
    const rejected = capture();
    assert.equal(await main(["accounts", "list"], rejected.out), 1);
    assert.ok(rejected.lines.some((line) => line.includes("HTTP 403")));
    assert.doesNotMatch(rejected.lines.join("\n"), /client-test-token/);
    if (previousDevToken === undefined) delete process.env.GATEWAY_DEV_TOKEN;
    else process.env.GATEWAY_DEV_TOKEN = previousDevToken;

    const unknownRun = capture();
    assert.equal(await main(["run", "unknown-run"], unknownRun.out), 1);
    assert.ok(unknownRun.lines.some((line) => line.includes("HTTP 404: not found")));

    const invalidFile = resolve(process.cwd(), "invalid-definition.json");
    writeFileSync(invalidFile, "{");
    const invalid = capture();
    assert.equal(await main(["definition", "set", "auto-1", invalidFile], invalid.out), 1);
    assert.ok(invalid.lines.some((line) => line.includes("cannot read definition file")));
    assert.ok(!requests.some((request) => request.url.endsWith("/definition")));

    const file = resolve(process.cwd(), "bad-schema.json");
    writeFileSync(file, JSON.stringify({ invalid: true }));
    const validation = capture();
    assert.equal(await main(["definition", "set", "auto-invalid", file], validation.out), 1);
    assert.ok(validation.lines.some((line) => line.includes("definition validation failed")));
    assert.ok(validation.lines.some((line) => line.includes("workflow: must contain an action")));
  });
});

test("invoke uses the client token, follows accepted results, and reuses an idempotency key", async () => {
  await withApi(async (_baseUrl, requests) => {
    const args = [
      "invoke", "auto-1", "--input", "{\"memberId\":\"DEMO-1002\"}", "--account", "acct_demo",
      "--revision", "1", "--idempotency-key", "same-key", "--follow", "--json"
    ];
    for (let index = 0; index < 2; index += 1) {
      const { lines, out } = capture();
      assert.equal(await main(args, out), 0);
      const result = JSON.parse(lines[0]!) as { runId: string; accepted: boolean; checks: unknown[] };
      assert.equal(result.runId, "public-run-1");
      assert.equal(result.accepted, true);
      assert.equal(result.checks.length, 16);
    }
    const invokes = requests.filter((request) => request.method === "POST" && request.url === "/v1/automations/auto-1/runs");
    assert.equal(invokes.length, 2);
    assert.equal(invokes[0]!.idempotencyKey, "same-key");
    assert.equal(invokes[1]!.idempotencyKey, "same-key");
    assert.ok(invokes.every((request) => request.auth === "Bearer client-test-token"));
    assert.deepEqual(invokes[0]!.body, { revision: 1, accountId: "acct_demo", input: { memberId: "DEMO-1002" } });
  });
});

test("client token can come from project config, and human key output reveals only the new token once", async () => {
  await withApi(async (_baseUrl, requests) => {
    const previous = process.env.GATEWAY_CLIENT_TOKEN;
    delete process.env.GATEWAY_CLIENT_TOKEN;
    const { out } = capture();
    assert.equal(await main(["invoke", "auto-1", "--input", "{}", "--revision", "1"], out), 0);
    assert.equal(requests.at(-1)?.auth, "Bearer client-config-token");
    if (previous === undefined) delete process.env.GATEWAY_CLIENT_TOKEN;
    else process.env.GATEWAY_CLIENT_TOKEN = previous;

    const key = capture();
    assert.equal(await main(["keys", "create", "one-time", "--role", "developer"], key.out), 0);
    assert.equal(key.lines.join("\n").split("newly-created-token").length - 1, 1);
    assert.ok(key.lines.some((line) => line.includes("shown once")));
  });
});

test("Browserbase account, connection, connect handoff, and disconnect commands use the Studio API", async () => {
  await withApi(async (_baseUrl, requests) => {
    const account = capture();
    assert.equal(await main(["accounts", "add", "--name", "Hosted", "--origin", "https://portal.example.test", "--provider", "browserbase", "--environment", "production"], account.out), 0);
    const addRequest = requests.find((request) => request.method === "POST" && request.url === "/studio/accounts");
    assert.deepEqual(addRequest?.body, {
      name: "Hosted", portalOrigin: "https://portal.example.test", provider: "browserbase", environment: "production"
    });

    const list = capture();
    assert.equal(await main(["connections"], list.out), 0);
    assert.ok(list.lines.some((line) => line.includes("connection-1") && line.includes("production")));

    const connect = capture();
    assert.equal(await main(["connect", "acct_demo", "--env", "production"], connect.out), 0);
    assert.ok(connect.lines.some((line) => line.includes("/#/connections/connection-1")));
    assert.equal(connect.lines.at(-1), "connected");
    const created = requests.find((request) => request.method === "POST" && request.url === "/studio/connections");
    assert.deepEqual(created?.body, { accountId: "acct_demo", environment: "production" });

    const disconnect = capture();
    assert.equal(await main(["disconnect", "connection-1"], disconnect.out), 0);
    assert.ok(disconnect.lines[0]?.includes("context cleanup"));
    assert.ok(requests.some((request) => request.method === "POST" && request.url === "/studio/connections/connection-1/disconnect"));

    const json = capture();
    assert.equal(await main(["--json", "connections"], json.out), 0);
    assert.deepEqual(JSON.parse(json.lines[0]!), [{ id: "connection-1", accountId: "acct_demo", accountName: "Demo", environment: "production", state: "connected" }]);
  });
});

test("contract listing, diff, retirement, and repository invocation commands use the shared APIs", async () => {
  await withApi(async (_baseUrl, requests) => {
    for (const args of [["models"], ["repos"], ["ops"], ["ops", "repo"], ["diff", "auto-1"], ["retire", "op-1"]] as string[][]) {
      const result = capture();
      assert.equal(await main(args, result.out), 0, args.join(" "));
      assert.ok(result.lines.length > 0);
    }
    const invoked = capture();
    assert.equal(await main([
      "invoke", "--repo", "repo", "--method", "get", "--version", "1", "--input", "{\"memberId\":\"DEMO-1001\"}", "--follow"
    ], invoked.out), 0);
    assert.ok(invoked.lines.some((line) => line.includes("contract-run")));
    const request = requests.find((item) => item.method === "POST" && item.url === "/v1/repositories/repo/operations/get/runs");
    assert.equal(request?.contractVersion, "1");
  });
});
