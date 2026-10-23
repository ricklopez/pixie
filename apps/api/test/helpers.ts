import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { bootstrap, buildApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import type { FinishedEvent, WorkerCommand, WorkerEvent, WorkerHandle, WorkerRunner } from "../src/worker.js";

export const TOKENS = { developer: "test-dev-token", client: "test-client-token", otherTenantClient: "test-other-token" };
export const PORTAL = "http://127.0.0.1:4174";

/** Synthetic member directory mirroring apps/portal fixtures, keyed by the typed member id. */
const PORTAL_VIEW: Record<string, Record<string, string | null> | "login"> = {
  "DEMO-1001": { memberId: "DEMO-1001", eligibilityStatus: "Active", plan: "Synthetic PPO Basic", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", portalAsOf: "2026-09-25", annualMaximum: "$1,500.00", annualMaximumRemaining: "$1,120.00", annualMaximumPeriod: "Calendar year", deductible: "$50.00", deductibleRemaining: "$0.00", deductibleNetwork: "In network" },
  "DEMO-1002": { memberId: "DEMO-1002", eligibilityStatus: "Active", plan: "Synthetic HMO Plus", effectiveFrom: "2026-03-01", effectiveTo: "2027-02-28", portalAsOf: "2026-09-24", annualMaximum: "$2,000.00", annualMaximumRemaining: "$650.00", annualMaximumPeriod: "Plan year", deductible: "$75.00", deductibleRemaining: "$25.00", deductibleNetwork: "In network" },
  "DEMO-2001": { memberId: "DEMO-2002", eligibilityStatus: "Active", plan: "Synthetic PPO Basic", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", portalAsOf: "2026-09-25", annualMaximum: "$1,500.00", annualMaximumRemaining: "$1,500.00", annualMaximumPeriod: "Calendar year", deductible: "$50.00", deductibleRemaining: "$50.00", deductibleNetwork: "In network" },
  "DEMO-3001": { memberId: "DEMO-3001", eligibilityStatus: null, plan: "Synthetic PPO Basic", effectiveFrom: "2026-01-01", effectiveTo: null, portalAsOf: "2026-09-25", annualMaximum: "$1,500.00", annualMaximumRemaining: "$900.00", annualMaximumPeriod: "Calendar year", deductible: null, deductibleRemaining: null, deductibleNetwork: null },
  "DEMO-LOGIN": "login"
};

export interface FakeRunnerOptions {
  /** Delay before the worker finishes, to observe queued/running/cancel behaviour. */
  delayMs?: number;
  mode?: "portal" | "model-down";
  providerCalls?: number;
}

/**
 * In-process stand-in for the Python worker that speaks the same NDJSON event protocol. It exists so the
 * gateway's lifecycle, verification and authorization can be tested offline; it is not a browser or model.
 */
export class FakeRunner implements WorkerRunner {
  commands: WorkerCommand[] = [];
  constructor(private readonly options: FakeRunnerOptions = {}) {}

  start(command: WorkerCommand, onEvent: (event: WorkerEvent) => void): WorkerHandle {
    this.commands.push(command);
    let cancelled = false;
    const finished = new Promise<FinishedEvent>((resolve) => {
      const done = (event: FinishedEvent) => {
        onEvent(event);
        resolve(event);
      };
      setTimeout(() => {
        onEvent({ type: "started", runId: command.runId, engine: command.engine });
        for (let i = 0; i < (this.options.providerCalls ?? 0); i += 1) onEvent({ type: "provider_call", provider: "typesafe" });
        if (cancelled) return done({ type: "finished", outcome: "cancelled", reason: "Cancellation requested", elapsedMs: 1, modelCalls: 0, providerCalls: this.options.providerCalls ?? 0, actions: 0 });
        if (this.options.mode === "model-down") {
          return done({ type: "finished", outcome: "failed", reason: "RuntimeError: Model provider returned HTTP 503; no action executed.", elapsedMs: 5, modelCalls: 1, providerCalls: this.options.providerCalls ?? 0, actions: 0 });
        }
        const memberId = String(command.input.memberId);
        const view = PORTAL_VIEW[memberId];
        onEvent({ type: "checkpoint", id: "search-form", status: "started" });
        onEvent({ type: "observation", url: `${PORTAL}/demo-portal`, actionCount: 2, fingerprint: "fake-1", elapsedMs: 1 });
        onEvent({ type: "model_call", checkpointId: "search-form", model: "fake", latencyMs: 7, operation: "TYPE_TEXT", target: "1", choice: "e1", confidence: 1, usage: this.options.providerCalls ? { input_tokens: 25000, output_tokens: 2 } : {}, elapsedMs: 1 });
        onEvent({ type: "policy_allowed", checkpointId: "search-form", action: "Member ID", kind: "fill", boundInput: "memberId" });
        onEvent({ type: "action", checkpointId: "search-form", step: 1, action: "Member ID", kind: "fill", boundInput: "memberId", page_changed: true, url: `${PORTAL}/demo-portal`, typedLength: memberId.length });
        mkdirSync(command.evidenceDir, { recursive: true });
        writeFileSync(join(command.evidenceDir, "search-form-after.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        onEvent({ type: "screenshot", checkpointId: "search-form", label: "after", ref: "search-form-after.jpg" });
        if (view === "login") {
          onEvent({ type: "auth_required", signal: { kind: "urlMatches", pattern: "/demo-portal/login" }, url: `${PORTAL}/demo-portal/login` });
          return done({ type: "finished", outcome: "auth_required", reason: "Login required detected at checkpoint 'search-form'", elapsedMs: 9, modelCalls: 1, providerCalls: this.options.providerCalls ?? 0, actions: 1 });
        }
        if (!view) {
          onEvent({ type: "checkpoint", id: "search-form", status: "failed", reason: "action budget exhausted" });
          // Like a real worker, the free-text reason may quote page content, including whatever the caller typed.
          return done({ type: "finished", outcome: "blocked", reason: `Checkpoint 'search-form' action budget exhausted; page shows "No member ${memberId}"`, elapsedMs: 9, modelCalls: 1, providerCalls: this.options.providerCalls ?? 0, actions: 1 });
        }
        onEvent({ type: "checkpoint", id: "search-form", status: "passed", actions: 1, elapsedMs: 3 });
        const outputs = Object.fromEntries(
          command.definition.outputs
            .filter((o) => o.extractor.kind !== "observedAt")
            .map((o) => [o.name, { value: view[o.name] ?? null, source: `label '${o.name}'`, checkpointId: "benefits-overview" }])
        );
        onEvent({ type: "extraction", outputs, observedAt: new Date().toISOString(), finalUrl: `${PORTAL}/demo-portal/members/${view.memberId}/benefits` });
        done({ type: "finished", outcome: "extracted", reason: null, elapsedMs: 12, modelCalls: 1, providerCalls: this.options.providerCalls ?? 0, actions: 1 });
      }, this.options.delayMs ?? 0);
    });
    return { finished, cancel: () => (cancelled = true) };
  }
}

export async function testApp(runnerOptions: FakeRunnerOptions = {}, overrides: { fireworksApiKey?: string; fireworksEndpoint?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gateway-api-test-"));
  const db = openDatabase(":memory:");
  bootstrap(db, TOKENS, PORTAL);
  const runner = new FakeRunner(runnerOptions);
  const built = buildApp({
    db,
    runner,
    evidenceRoot: join(dir, "evidence"),
    cdpUrl: async () => {
      throw new Error("no browser in offline tests");
    },
    allowLoopback: true,
    publicBaseUrl: "http://gateway.test",
    selectEngine: () => ({ engine: runnerOptions.providerCalls ? "live" : "scripted", script: [] }),
    ...overrides
  });
  await built.app.ready();
  return { ...built, runner, db };
}

export async function call(app: FastifyInstance, token: string, method: "GET" | "POST" | "PUT", url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...headers }, ...(body !== undefined ? { payload: body } : {}) });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, json: json as Record<string, unknown> & { id?: string; state?: string; error?: string; revision?: number } & Record<string, unknown>, raw: res };
}

/** Creates the reference automation, injects a fake recording, tests it and publishes revision 1. */
export async function publishEligibility(app: FastifyInstance, runs: { waitForTerminal(id: string): Promise<unknown> }) {
  const created = await call(app, TOKENS.developer, "POST", "/studio/automations", { name: "Eligibility overview", startUrl: `${PORTAL}/demo-portal`, template: "eligibility-overview" });
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.json)}`);
  const id = created.json.id!;
  // Recording requires a browser; offline tests skip straight to review and confirm the definition as-is.
  const reviewed = await call(app, TOKENS.developer, "PUT", `/studio/automations/${id}/definition`, created.json.definition);
  if (reviewed.status !== 200) throw new Error(`review failed: ${JSON.stringify(reviewed.json)}`);
  const test = await call(app, TOKENS.developer, "POST", `/studio/automations/${id}/test`, { accountId: "acct_demo", input: { memberId: "DEMO-1001" } });
  if (test.status !== 202) throw new Error(`test failed: ${JSON.stringify(test.json)}`);
  await runs.waitForTerminal(test.json.id!);
  await new Promise((r) => setTimeout(r, 10));
  const published = await call(app, TOKENS.developer, "POST", `/studio/automations/${id}/publish`);
  if (published.status !== 201) throw new Error(`publish failed: ${JSON.stringify(published.json)}`);
  return { id, revision: published.json.revision as number, testRunId: test.json.id! };
}
