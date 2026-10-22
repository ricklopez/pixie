import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  inputJsonSchema,
  sha256Hex,
  validateInput,
  verifyExtraction,
  type AutomationDefinition,
  type JsonValue,
  type VerificationResult
} from "@gateway/definition";
import { now, type RunRow, type RunState } from "./db.js";
import type { FinishedEvent, WorkerCommand, WorkerEvent, WorkerRunner } from "./worker.js";

export type EngineSelection = Pick<WorkerCommand, "engine" | "script">;

export interface RunManagerOptions {
  db: DatabaseSync;
  runner: WorkerRunner;
  evidenceRoot: string;
  /** Chooses the engine per run. Production uses live; offline tests use the scripted substitute and say so in metadata. */
  selectEngine: (definition: AutomationDefinition, input: Record<string, string | number | boolean>) => EngineSelection;
}

export interface CreateRunParams {
  tenantId: string;
  automationId: string;
  revision: number;
  definition: AutomationDefinition;
  accountId: string;
  callerId: string;
  kind: "test" | "endpoint";
  input: unknown;
  idempotencyKey?: string | null;
}

export type CreateRunResult =
  | { ok: true; run: RunRow; reused: boolean }
  | { ok: false; status: 400 | 409; error: string; details?: string[] };

export interface RunMetrics {
  engine: string;
  engineRevision: string;
  modelCalls: number;
  actions: number;
  elapsedMs: number;
  modelLatencyMs: number[];
  inputTokens: number;
  outputTokens: number;
  policyRejections: number;
}

const TERMINAL: RunState[] = ["completed", "needs_review", "awaiting_auth", "failed", "cancelled"];
export const isTerminal = (state: RunState) => TERMINAL.includes(state);

interface Active {
  handle: ReturnType<WorkerRunner["start"]> | null;
  cancelRequested: boolean;
}

/**
 * Owns the run lifecycle: validation, idempotency, per-account FIFO serialization, worker supervision,
 * independent verification and evidence bookkeeping. Nothing here trusts the worker's DONE claim.
 */
export class RunManager {
  private readonly queues = new Map<string, string[]>();
  private readonly active = new Map<string, Active>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly options: RunManagerOptions) {
    // Runs left non-terminal by a previous process can never finish; they are failed explicitly rather than
    // shown as running forever.
    const orphans = this.db.prepare(`SELECT id FROM runs WHERE state IN ('queued', 'running', 'verifying')`).all() as { id: string }[];
    for (const { id } of orphans) {
      this.finish(id, "failed", { reason: "gateway process restarted before the run finished" }, null);
    }
  }

  get db() {
    return this.options.db;
  }

  async create(params: CreateRunParams): Promise<CreateRunResult> {
    const schema = inputJsonSchema(params.definition);
    const errors = validateInput(schema, params.input);
    if (errors.length) return { ok: false, status: 400, error: "invalid input", details: errors };
    const input = params.input as Record<string, JsonValue>;
    const requestHash = await sha256Hex(canonicalJson({ revision: params.revision, accountId: params.accountId, input }));

    if (params.idempotencyKey) {
      const existing = this.db
        .prepare(
          `SELECT * FROM runs WHERE caller_id = ? AND account_id = ? AND automation_id = ? AND revision = ? AND idempotency_key = ?`
        )
        .get(params.callerId, params.accountId, params.automationId, params.revision, params.idempotencyKey) as unknown as RunRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          return { ok: false, status: 409, error: "idempotency key was already used with a different request body" };
        }
        return { ok: true, run: existing, reused: true };
      }
    }

    const run: RunRow = {
      id: randomUUID(),
      tenant_id: params.tenantId,
      automation_id: params.automationId,
      revision: params.revision,
      account_id: params.accountId,
      caller_id: params.callerId,
      kind: params.kind,
      state: "queued",
      input: JSON.stringify(input),
      idempotency_key: params.idempotencyKey ?? null,
      request_hash: requestHash,
      result: null,
      failure: null,
      metrics: null,
      created_at: now(),
      started_at: null,
      finished_at: null
    };
    this.db
      .prepare(
        `INSERT INTO runs (id, tenant_id, automation_id, revision, account_id, caller_id, kind, state, input, idempotency_key, request_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(run.id, run.tenant_id, run.automation_id, run.revision, run.account_id, run.caller_id, run.kind, run.state, run.input, run.idempotency_key, run.request_hash, run.created_at);
    this.recordEvent(run.id, { type: "queued", position: (this.queues.get(run.account_id)?.length ?? 0) + (this.active.has(run.account_id) ? 1 : 0) });
    this.enqueue(run.account_id, run.id, params.definition);
    return { ok: true, run, reused: false };
  }

  get(runId: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as unknown as RunRow | undefined;
  }

  events(runId: string): { seq: number; at: string; event: Record<string, unknown> }[] {
    const rows = this.db.prepare(`SELECT seq, at, event FROM run_events WHERE run_id = ? ORDER BY seq`).all(runId) as { seq: number; at: string; event: string }[];
    return rows.map((r) => ({ seq: r.seq, at: r.at, event: JSON.parse(r.event) as Record<string, unknown> }));
  }

  cancel(runId: string): { ok: boolean; state: RunState | null } {
    const run = this.get(runId);
    if (!run) return { ok: false, state: null };
    if (isTerminal(run.state)) return { ok: false, state: run.state };
    if (run.state === "queued") {
      const queue = this.queues.get(run.account_id) ?? [];
      this.queues.set(run.account_id, queue.filter((id) => id !== runId));
      this.finish(runId, "cancelled", { reason: "cancelled before start" }, null);
      return { ok: true, state: "cancelled" };
    }
    const active = this.active.get(run.account_id);
    if (active) {
      active.cancelRequested = true;
      active.handle?.cancel();
    }
    return { ok: true, state: run.state };
  }

  /** Resolves when the run reaches a terminal state (used by tests and the studio test flow). */
  waitForTerminal(runId: string, timeoutMs = 180_000): Promise<RunRow> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const run = this.get(runId);
        if (run && isTerminal(run.state)) {
          clearTimeout(timer);
          this.waiters.get(runId)?.delete(check);
          resolve(run);
        }
      };
      const timer = setTimeout(() => {
        this.waiters.get(runId)?.delete(check);
        reject(new Error(`run ${runId} did not finish within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      if (!this.waiters.has(runId)) this.waiters.set(runId, new Set());
      this.waiters.get(runId)!.add(check);
      check();
    });
  }

  // -- internals -----------------------------------------------------------------------------------------

  private enqueue(accountId: string, runId: string, definition: AutomationDefinition) {
    const queue = this.queues.get(accountId) ?? [];
    queue.push(runId);
    this.queues.set(accountId, queue);
    this.definitions.set(runId, definition);
    void this.drain(accountId);
  }

  private readonly definitions = new Map<string, AutomationDefinition>();

  private async drain(accountId: string) {
    if (this.active.has(accountId)) return;
    const queue = this.queues.get(accountId) ?? [];
    const runId = queue.shift();
    if (!runId) return;
    const active: Active = { handle: null, cancelRequested: false };
    this.active.set(accountId, active);
    try {
      await this.execute(runId, active);
    } finally {
      this.active.delete(accountId);
      this.definitions.delete(runId);
      void this.drain(accountId);
    }
  }

  private async execute(runId: string, active: Active) {
    const run = this.get(runId);
    const definition = this.definitions.get(runId);
    if (!run || !definition || run.state !== "queued") return;
    const secrets = Object.fromEntries(
      (this.db.prepare(`SELECT ref, value FROM account_secrets WHERE account_id = ?`).all(run.account_id) as { ref: string; value: string }[]).map((r) => [r.ref, r.value])
    );
    const input = JSON.parse(run.input) as Record<string, string | number | boolean>;
    const selection = this.options.selectEngine(definition, input);
    const command: WorkerCommand = {
      type: "run",
      runId,
      accountId: run.account_id,
      engine: selection.engine,
      ...(selection.script ? { script: selection.script } : {}),
      definition,
      input,
      secrets,
      evidenceDir: join(this.options.evidenceRoot, runId),
      deadlineMs: definition.limits.deadlineMs,
      cancelOnStdinClose: true
    };
    this.setState(runId, "running", { started_at: now() });
    this.recordEvent(runId, { type: "engine_selected", engine: selection.engine, live: selection.engine === "live" });

    const metrics: RunMetrics = {
      engine: selection.engine === "live" ? `${definition.engine}@${definition.engineRevision.slice(0, 12)}` : `${selection.engine} (offline substitute, not a model)`,
      engineRevision: definition.engineRevision,
      modelCalls: 0,
      actions: 0,
      elapsedMs: 0,
      modelLatencyMs: [],
      inputTokens: 0,
      outputTokens: 0,
      policyRejections: 0
    };
    let extraction: Extract<WorkerEvent, { type: "extraction" }> | null = null;

    const handle = this.options.runner.start(command, (event) => {
      if (event.type === "model_call") {
        metrics.modelCalls += 1;
        if (typeof event.latencyMs === "number") metrics.modelLatencyMs.push(event.latencyMs);
        metrics.inputTokens += event.usage?.input_tokens ?? 0;
        metrics.outputTokens += event.usage?.output_tokens ?? 0;
      }
      if (event.type === "action") metrics.actions += 1;
      if (event.type === "policy_rejected") metrics.policyRejections += 1;
      if (event.type === "screenshot") {
        this.db
          .prepare(`INSERT OR REPLACE INTO evidence (run_id, name, path, content_type) VALUES (?, ?, ?, ?)`)
          .run(runId, event.ref, join(command.evidenceDir, event.ref), "image/jpeg");
      }
      if (event.type === "extraction") extraction = event;
      if (event.type !== "finished") this.recordEvent(runId, event as unknown as Record<string, unknown>);
    });
    active.handle = handle;
    if (active.cancelRequested) handle.cancel();

    const hardStop = setTimeout(() => handle.cancel(), definition.limits.deadlineMs + 15_000);
    hardStop.unref();
    const finished: FinishedEvent = await handle.finished;
    clearTimeout(hardStop);
    metrics.elapsedMs = finished.elapsedMs;
    this.recordEvent(runId, { ...finished });

    switch (finished.outcome) {
      case "extracted": {
        this.setState(runId, "verifying");
        const observed = extraction as Extract<WorkerEvent, { type: "extraction" }> | null;
        if (!observed) {
          this.finish(runId, "needs_review", { reason: "worker finished without an extraction" }, metrics);
          return;
        }
        const verification: VerificationResult = verifyExtraction(definition, command.input, observed.outputs, observed.observedAt, observed.mutations ?? []);
        this.recordEvent(runId, { type: "verification", accepted: verification.accepted, checks: verification.checks, reasons: verification.reasons });
        const result = { data: verification.data, checks: verification.checks, observedAt: observed.observedAt, finalUrl: observed.finalUrl, rawExtraction: observed.outputs };
        if (verification.accepted) {
          this.finish(runId, "completed", null, metrics, result);
        } else {
          this.finish(runId, "needs_review", { reason: "independent verification rejected the extracted result", reasons: verification.reasons }, metrics, result);
        }
        return;
      }
      case "auth_required":
        this.finish(runId, "awaiting_auth", { reason: finished.reason ?? "login required" }, metrics);
        return;
      case "blocked":
        this.finish(runId, "needs_review", { reason: finished.reason ?? "checkpoint not satisfied" }, metrics);
        return;
      case "cancelled":
        this.finish(runId, "cancelled", { reason: finished.reason ?? "cancelled" }, metrics);
        return;
      default:
        this.finish(runId, "failed", { reason: finished.reason ?? "worker failure" }, metrics);
    }
  }

  private setState(runId: string, state: RunState, extra: Partial<Pick<RunRow, "started_at">> = {}) {
    if (extra.started_at) this.db.prepare(`UPDATE runs SET state = ?, started_at = ? WHERE id = ?`).run(state, extra.started_at, runId);
    else this.db.prepare(`UPDATE runs SET state = ? WHERE id = ?`).run(state, runId);
    this.recordEvent(runId, { type: "state", state });
  }

  private finish(runId: string, state: RunState, failure: Record<string, unknown> | null, metrics: RunMetrics | null, result: Record<string, unknown> | null = null) {
    this.db
      .prepare(`UPDATE runs SET state = ?, failure = ?, metrics = ?, result = ?, finished_at = ? WHERE id = ?`)
      .run(state, failure ? JSON.stringify(failure) : null, metrics ? JSON.stringify(metrics) : null, result ? JSON.stringify(result) : null, now(), runId);
    this.recordEvent(runId, { type: "state", state, ...(failure ?? {}) });
    for (const waiter of this.waiters.get(runId) ?? []) waiter();
  }

  private recordEvent(runId: string, event: Record<string, unknown>) {
    const next = (this.db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?`).get(runId) as { seq: number }).seq;
    this.db.prepare(`INSERT INTO run_events (run_id, seq, at, event) VALUES (?, ?, ?, ?)`).run(runId, next, now(), JSON.stringify(event));
  }
}
