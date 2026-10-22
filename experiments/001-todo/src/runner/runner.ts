import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256 } from "../shared/canonical.js";
import { openSqliteDatabase } from "../shared/sqlite.js";
import type { SqliteDatabase } from "../shared/sqlite.js";
import { TODO_PREFIX } from "../shared/types.js";
import type {
  GeneratedArgs,
  LedgerState,
  Operation,
  PublicTask,
  RunResult,
  Task,
  TerminalState
} from "../shared/types.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

interface LedgerRow {
  request_id: string;
  op: Operation;
  payload_hash: string;
  state: LedgerState;
  result: string | null;
}

interface ChildResponse {
  result?: PublicTask | PublicTask[];
  visibleTasks: Task[];
  guard?: "needs_review" | "rejected" | "contract_revision_required";
  error?: string;
  dispatchCount: number;
  modelCallAttempts: number;
  ruleRevision: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const childPath = resolve(packageRoot, "src/runner/child.ts");
const defaultLedgerPath = resolve(packageRoot, ".data/runner-ledger.sqlite");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TodoRunner {
  private readonly db: SqliteDatabase;

  constructor(dbPath = defaultLedgerPath) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openSqliteDatabase(dbPath);
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        request_id TEXT PRIMARY KEY,
        op TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        result TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  async run(baseUrl: string, op: Operation, input: GeneratedArgs): Promise<RunResult> {
    if (!this.isLocalFixtureUrl(baseUrl)) {
      return this.result("rejected", op, undefined, "runner only permits HTTP loopback fixture URLs", false, 0, 0);
    }
    if (op === "list") {
      let child: ChildResponse;
      try {
        child = await this.runChild(baseUrl, op, input);
      } catch (error) {
        return this.result("failed", op, undefined, error instanceof Error ? error.message : "runner child failed", false, 0, 0);
      }
      if (child.error) return this.result("failed", op, undefined, child.error, false, child.dispatchCount, child.modelCallAttempts);
      return this.result("completed", op, child.result, undefined, false, child.dispatchCount, child.modelCallAttempts);
    }

    const requestId = input.requestId;
    if (!requestId || !uuidPattern.test(requestId)) {
      return this.result("rejected", op, undefined, "writes require a UUID requestId", false, 0, 0);
    }
    const payloadHash = sha256(canonicalJson({ op, input }));
    const existing = this.db.prepare("SELECT * FROM ledger WHERE request_id=?").get(requestId) as unknown as LedgerRow | undefined;
    if (existing) {
      if (existing.payload_hash !== payloadHash || existing.op !== op) {
        return this.result("conflict", op, undefined, "requestId reused with a different operation or payload", false, 0, 0, existing.state);
      }
      return this.replay(baseUrl, existing, input);
    }

    const preRejected = this.validateWriteInput(op, input);
    if (preRejected) {
      this.db.prepare("INSERT INTO ledger (request_id, op, payload_hash, state, result, updated_at) VALUES (?, ?, ?, 'needs_review', ?, ?)")
        .run(requestId, op, payloadHash, JSON.stringify({ terminal: "rejected", error: preRejected }), new Date().toISOString());
      return this.result("rejected", op, undefined, preRejected, false, 0, 0, "needs_review");
    }
    this.db.prepare("INSERT INTO ledger (request_id, op, payload_hash, state, result, updated_at) VALUES (?, ?, ?, 'intent_recorded', NULL, ?)")
      .run(requestId, op, payloadHash, new Date().toISOString());
    this.setState(requestId, "dispatched", null);
    let child: ChildResponse;
    try {
      child = await this.runChild(baseUrl, op, input);
    } catch (error) {
      return this.reconcileUncertain(
        baseUrl,
        op,
        input,
        requestId,
        error instanceof Error ? error.message : "runner child failed",
        1,
        0
      );
    }
    const modelCallAttempts = child.modelCallAttempts;
    if (child.guard) {
      this.setState(requestId, "needs_review", JSON.stringify({ terminal: child.guard }));
      return this.result(child.guard, op, undefined, child.guard, false, child.dispatchCount, modelCallAttempts, "needs_review");
    }
    const deleteConfirmed = op === "delete" && !child.error && !child.visibleTasks.some((task) => task.id === input.id);
    if (!child.error && (child.result !== undefined || deleteConfirmed)) {
      this.setState(requestId, "confirmed", child.result === undefined ? null : JSON.stringify(child.result));
      return this.result("completed", op, child.result, undefined, false, child.dispatchCount, modelCallAttempts, "confirmed");
    }

    if (child.dispatchCount === 0) {
      this.setState(requestId, "needs_review", JSON.stringify({ terminal: "failed", error: child.error ?? "generated operation failed before dispatch" }));
      return this.result("failed", op, undefined, child.error ?? "generated operation failed before dispatch", false, 0, modelCallAttempts, "needs_review");
    }

    return this.reconcileUncertain(
      baseUrl,
      op,
      input,
      requestId,
      child.error ?? "write outcome could not be established",
      child.dispatchCount,
      modelCallAttempts
    );
  }

  private async replay(baseUrl: string, existing: LedgerRow, input: GeneratedArgs): Promise<RunResult> {
    if (existing.state === "confirmed" || existing.state === "reconciled_existing") {
      const saved = existing.result ? JSON.parse(existing.result) as PublicTask | PublicTask[] : undefined;
      return this.result("completed", existing.op, saved, undefined, true, 0, 0, existing.state);
    }
    if (existing.state === "needs_review") {
      const saved = existing.result ? JSON.parse(existing.result) as { terminal?: TerminalState; error?: string } : {};
      const terminal = saved.terminal && ["needs_review", "rejected", "contract_revision_required", "failed"].includes(saved.terminal)
        ? saved.terminal
        : "needs_review";
      return this.result(terminal, existing.op, undefined, saved.error ?? saved.terminal ?? "write requires review", true, 0, 0, existing.state);
    }
    if (existing.op === "create") {
      let child: ChildResponse;
      try {
        child = await this.runChild(baseUrl, "list", {});
      } catch (error) {
        const message = error instanceof Error ? error.message : "prior create reconciliation failed";
        this.setState(existing.request_id, "outcome_unknown", JSON.stringify({ error: message }));
        return this.result("outcome_unknown", existing.op, undefined, message, true, 0, 0, "outcome_unknown");
      }
      const found = child.error ? undefined : this.findCreateResult(child.visibleTasks, input);
      if (found) {
        this.setState(existing.request_id, "reconciled_existing", JSON.stringify(found));
        return this.result("completed", existing.op, found, undefined, true, 0, child.modelCallAttempts, "reconciled_existing");
      }
      this.setState(existing.request_id, "outcome_unknown", JSON.stringify({ error: child.error ?? "prior create remains unconfirmed" }));
      return this.result("outcome_unknown", existing.op, undefined, child.error ?? "prior create remains unconfirmed", true, 0, child.modelCallAttempts, "outcome_unknown");
    }
    this.setState(existing.request_id, "needs_review", JSON.stringify({ terminal: "needs_review", error: "prior write was interrupted; automatic replay is disabled" }));
    return this.result("needs_review", existing.op, undefined, "prior write was interrupted; automatic replay is disabled", true, 0, 0, "needs_review");
  }

  private validateWriteInput(op: Operation, input: GeneratedArgs): string | null {
    if (!input.requestId || !uuidPattern.test(input.requestId)) return "writes require a UUID requestId";
    if (op === "create" && (typeof input.title !== "string" || !input.title.startsWith(TODO_PREFIX))) {
      return "title must start with exact prefix 'pixie-demo '";
    }
    if (op === "rename") {
      if (typeof input.newTitle !== "string") return "newTitle is required";
      if (!input.newTitle.startsWith(TODO_PREFIX)) return "newTitle must start with exact prefix 'pixie-demo '";
    }
    return null;
  }

  private isLocalFixtureUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
        !url.username &&
        !url.password;
    } catch {
      return false;
    }
  }

  private findCreateResult(rows: Task[], input: GeneratedArgs): PublicTask | undefined {
    const byRequestId = rows.filter((row) => row.requestId === input.requestId);
    if (byRequestId.length === 1) {
      const row = byRequestId[0]!;
      if (row.title !== input.title) return undefined;
      const { id, title, done } = row;
      return { id, title, done };
    }
    if (byRequestId.length > 0) return undefined;
    const byTitle = rows.filter((row) => row.title === input.title);
    if (byTitle.length !== 1) return undefined;
    const { id, title, done } = byTitle[0]!;
    return { id, title, done };
  }

  private async reconcileUncertain(
    baseUrl: string,
    op: Operation,
    input: GeneratedArgs,
    requestId: string,
    error: string,
    dispatchCount: number,
    knownModelCallAttempts: number
  ): Promise<RunResult> {
    if (op !== "create") {
      this.setState(requestId, "outcome_unknown", JSON.stringify({ error }));
      return this.result("outcome_unknown", op, undefined, error, false, dispatchCount, knownModelCallAttempts, "outcome_unknown");
    }
    let reconciliation: ChildResponse;
    try {
      reconciliation = await this.runChild(baseUrl, "list", {});
    } catch (cause) {
      const reconciliationError = cause instanceof Error ? cause.message : "create reconciliation failed";
      this.setState(requestId, "outcome_unknown", JSON.stringify({ error: reconciliationError }));
      return this.result("outcome_unknown", op, undefined, error, false, dispatchCount, knownModelCallAttempts, "outcome_unknown");
    }
    const combinedCalls = knownModelCallAttempts + reconciliation.modelCallAttempts;
    if (reconciliation.error) {
      this.setState(requestId, "outcome_unknown", JSON.stringify({ error }));
      return this.result("outcome_unknown", op, undefined, error, false, dispatchCount, combinedCalls, "outcome_unknown");
    }
    const reconciled = this.findCreateResult(reconciliation.visibleTasks, input);
    if (reconciled) {
      this.setState(requestId, "reconciled_existing", JSON.stringify(reconciled));
      return this.result("completed", op, reconciled, error, false, dispatchCount, combinedCalls, "reconciled_existing");
    }
    this.setState(requestId, "outcome_unknown", JSON.stringify({ error }));
    return this.result("outcome_unknown", op, undefined, error, false, dispatchCount, combinedCalls, "outcome_unknown");
  }

  private async runChild(baseUrl: string, op: Operation, input: GeneratedArgs): Promise<ChildResponse> {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(OPENAI|TYPESAFE|ANTHROPIC)(_|$)/i.test(key) || /_API_KEY$/i.test(key) || key === "PIXIE_ALLOW_PAID_EXPERIMENT") {
        delete env[key];
      }
    }
    const safeEnv: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "PLAYWRIGHT_BROWSERS_PATH"]) {
      if (env[key] !== undefined) safeEnv[key] = env[key];
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, ["--import", "tsx", childPath], {
        cwd: packageRoot,
        env: safeEnv,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
      this.collectChild(child, { baseUrl, op, input }, resolvePromise, rejectPromise, timeout);
    });
  }

  private collectChild(
    child: ChildProcessWithoutNullStreams,
    request: { baseUrl: string; op: Operation; input: GeneratedArgs },
    resolvePromise: (response: ChildResponse) => void,
    rejectPromise: (error: Error) => void,
    timeout: NodeJS.Timeout
  ): void {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectPromise(new Error(`runner child exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout.trim()) as ChildResponse);
      } catch {
        rejectPromise(new Error(`runner child returned invalid JSON: ${stdout.slice(0, 300)}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  }

  private setState(requestId: string, state: LedgerState, result: string | null): void {
    this.db.prepare("UPDATE ledger SET state=?, result=?, updated_at=? WHERE request_id=?")
      .run(state, result, new Date().toISOString(), requestId);
  }

  private result(
    terminal: TerminalState,
    op: Operation,
    value: PublicTask | PublicTask[] | undefined,
    error: string | undefined,
    reused: boolean,
    dispatchCount: number,
    modelCallAttempts: number,
    ledgerState?: LedgerState
  ): RunResult {
    return {
      terminal,
      op,
      ...(value === undefined ? {} : { result: value }),
      ...(error ? { error } : {}),
      reused,
      dispatchCount,
      modelCallAttempts,
      ...(ledgerState ? { ledgerState } : {})
    };
  }
}
