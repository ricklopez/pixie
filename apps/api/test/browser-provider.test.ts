import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BrowserbaseProvider, type BrowserbaseSession } from "../src/browser-provider.js";
import { SubprocessRunner, type WorkerCommand, type WorkerEvent } from "../src/worker.js";

async function withFakeBrowserbase(run: (provider: BrowserbaseProvider, state: { sessions: Map<string, BrowserbaseSession>; requests: { method: string; path: string; body: Record<string, unknown> }[] }) => Promise<void>) {
  const sessions = new Map<string, BrowserbaseSession>();
  const contexts = new Set<string>();
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  let next = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url ?? "/";
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      requests.push({ method: req.method ?? "GET", path, body });
      const send = (status: number, value?: unknown) => {
        res.writeHead(status, value === undefined ? {} : { "content-type": "application/json" });
        res.end(value === undefined ? "" : JSON.stringify(value));
      };
      if (req.method === "POST" && path === "/v1/contexts") {
        const id = `context-${++next}`;
        contexts.add(id);
        return send(201, { id });
      }
      if (req.method === "DELETE" && path.startsWith("/v1/contexts/")) {
        contexts.delete(decodeURIComponent(path.split("/").at(-1)!));
        return send(204);
      }
      if (req.method === "POST" && path === "/v1/sessions") {
        const id = `session-${++next}`;
        const context = body.browserSettings as { context?: { id?: string } };
        const session: BrowserbaseSession = {
          id,
          status: "RUNNING",
          contextId: context.context?.id,
          userMetadata: body.userMetadata as Record<string, unknown>,
          connectUrl: `wss://secret.invalid/${id}?token=private`
        };
        sessions.set(id, session);
        return send(201, session);
      }
      if (req.method === "POST" && path.startsWith("/v1/sessions/")) {
        const session = sessions.get(decodeURIComponent(path.split("/").at(-1)!));
        if (!session) return send(404, { error: "not found" });
        session.status = "COMPLETED";
        return send(200, session);
      }
      if (req.method === "GET" && path.startsWith("/v1/sessions/")) {
        const session = sessions.get(decodeURIComponent(path.split("/").at(-1)!));
        return session ? send(200, session) : send(404, { error: "not found" });
      }
      if (req.method === "GET" && path.startsWith("/v1/sessions?status=RUNNING")) {
        return send(200, [...sessions.values()].filter((session) => session.status === "RUNNING"));
      }
      send(404, { error: "unknown endpoint" });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const provider = new BrowserbaseProvider({
    apiKey: "fake-api-key",
    projectId: "fake-project",
    baseUrl: `http://127.0.0.1:${address.port}`,
    maxSessionSeconds: 300,
    pollIntervalMs: 1,
    releaseWaitMs: 100
  });
  try {
    await run(provider, { sessions, requests });
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("Browserbase sessions are tagged and released, and the sweeper leaves untagged sessions alone", async () => {
  await withFakeBrowserbase(async (provider, { sessions, requests }) => {
    const contextId = await provider.createContext("test");
    const lease = await provider.acquireSession({ accountId: "acct_a", environment: "test", contextId, runId: "run-a" });
    assert.equal(lease.cdpUrl.includes("private"), true);
    const created = [...sessions.values()][0]!;
    assert.deepEqual(created.userMetadata, { pixie: "1", runId: "run-a" });
    assert.equal(await lease.release() >= 0, true);

    sessions.set("untagged", { id: "untagged", status: "RUNNING", userMetadata: { source: "other" } });
    sessions.set("tagged", { id: "tagged", status: "RUNNING", userMetadata: { pixie: "1", connectionId: "orphan" } });
    assert.equal(await provider.sweepOrphans(), 1);
    assert.equal(sessions.get("tagged")?.status, "COMPLETED");
    assert.equal(sessions.get("untagged")?.status, "RUNNING");
    assert.ok(requests.some((request) => request.method === "POST" && request.path === "/v1/sessions" && request.body.timeout === 300));
  });
});

test("Browserbase serializes sessions per context until the first lease releases", async () => {
  await withFakeBrowserbase(async (provider, { sessions }) => {
    const first = await provider.acquireSession({ accountId: "acct_a", environment: "test", contextId: "shared", runId: "run-a" });
    let secondReady = false;
    const secondPromise = provider.acquireSession({ accountId: "acct_b", environment: "test", contextId: "shared", runId: "run-b" }).then((lease) => {
      secondReady = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sessions.size, 1);
    assert.equal(secondReady, false);
    await first.release();
    const second = await secondPromise;
    assert.equal(secondReady, true);
    assert.equal(sessions.size, 2);
    await second.release();
  });
});

test("remote CDP URL is passed only through worker environment and redacted from events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pixie-fake-uv-"));
  const executable = join(directory, "uv");
  const envCapture = join(directory, "env.txt");
  const argsCapture = join(directory, "args.txt");
  const cdpUrl = "wss://browserbase.invalid/connect?token=private-sentinel";
  writeFileSync(executable, `#!/bin/sh
printf '%s' "$BU_CDP_URL" > "$CDP_ENV_CAPTURE"
printf '%s' "$*" > "$CDP_ARGS_CAPTURE"
IFS= read -r command
printf '{"type":"observation","url":"%s","actionCount":0,"fingerprint":null,"elapsedMs":1}\\n' "$BU_CDP_URL"
printf '{"type":"finished","outcome":"extracted","reason":null,"elapsedMs":1,"modelCalls":0,"providerCalls":0,"actions":0}\\n'
`);
  chmodSync(executable, 0o755);
  const runner = new SubprocessRunner({
    workerDir: directory,
    cdpUrl: async () => { throw new Error("URL override was not used"); },
    env: { PATH: directory, CDP_ENV_CAPTURE: envCapture, CDP_ARGS_CAPTURE: argsCapture }
  });
  const events: WorkerEvent[] = [];
  const command = {
    type: "run", runId: "remote-test", accountId: "acct_test", engine: "scripted",
    definition: {}, input: {}, secrets: {}, evidenceDir: directory, deadlineMs: 1000, cancelOnStdinClose: true
  } as unknown as WorkerCommand;
  const finished = await runner.start(command, (event) => events.push(event), cdpUrl).finished;
  assert.equal(finished.outcome, "extracted");
  assert.equal(readFileSync(envCapture, "utf8"), cdpUrl);
  assert.doesNotMatch(readFileSync(argsCapture, "utf8"), /browserbase\.invalid|private-sentinel/);
  assert.doesNotMatch(JSON.stringify(events), /browserbase\.invalid|private-sentinel/);
  assert.match(JSON.stringify(events), /redacted browser connection/);
});
