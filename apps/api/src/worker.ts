import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AutomationDefinition, ListItem, MutationCheck } from "@gateway/definition";

/** NDJSON protocol shared with workers/jev/gateway_worker/main.py. */
export interface WorkerCommand {
  type: "run";
  runId: string;
  accountId: string;
  engine: "live" | "scripted" | "failing";
  script?: { operation: string; label?: string }[];
  definition: AutomationDefinition;
  input: Record<string, string | number | boolean>;
  secrets: Record<string, string>;
  evidenceDir: string;
  deadlineMs: number;
  cancelOnStdinClose: true;
}

export type WorkerOutcome = "extracted" | "auth_required" | "blocked" | "failed" | "cancelled";

export interface FinishedEvent {
  type: "finished";
  outcome: WorkerOutcome;
  reason: string | null;
  elapsedMs: number;
  modelCalls: number;
  actions: number;
}

export type WorkerEvent =
  | { type: "started"; runId: string; engine: string }
  | { type: "checkpoint"; id: string; status: "started" | "passed" | "failed"; reason?: string; actions?: number; elapsedMs?: number }
  | { type: "observation"; url: string; actionCount: number; fingerprint: string | null; elapsedMs: number }
  | {
      type: "model_call";
      checkpointId: string;
      model: string | null;
      latencyMs: number | null;
      operation: string | null;
      target: string | null;
      choice: string;
      confidence: number | null;
      targetConfidence?: number | null;
      operationProbabilities?: Record<string, number> | null;
      targetProbabilities?: Record<string, number> | null;
      usage: Record<string, number> | null;
      elapsedMs: number;
    }
  | { type: "policy_allowed"; checkpointId: string; action: string | null; kind: string | null; boundInput: string | null }
  | { type: "action"; checkpointId: string; step: number; action: string | null; kind: string | null; boundInput: string | null; page_changed: boolean; url: string; typedLength: number }
  | { type: "stale_page"; checkpointId: string; reason: string; attempt: number }
  | { type: "policy_rejected"; checkpointId: string; code: string; reason: string; action: string | null; kind: string | null }
  | { type: "screenshot"; checkpointId: string; label: string; ref: string }
  | { type: "auth_required"; signal: unknown; url: string }
  | { type: "mutation_check"; checkpointId: string; kind: "create" | "update" | "delete"; ok: boolean; reason: string | null; before: number; after: number }
  | { type: "extraction"; outputs: Record<string, { value: string | ListItem[] | null; source: string; checkpointId: string }>; mutations?: MutationCheck[]; observedAt: string; finalUrl: string }
  | { type: "cleanup"; closedTab: boolean; error?: string }
  | FinishedEvent;

export interface WorkerHandle {
  finished: Promise<FinishedEvent>;
  cancel(): void;
}

export interface WorkerRunner {
  start(command: WorkerCommand, onEvent: (event: WorkerEvent) => void): WorkerHandle;
}

export interface SubprocessRunnerOptions {
  workerDir: string;
  /** The CDP endpoint of the account's dedicated browser profile. */
  cdpUrl: string | ((accountId: string) => Promise<string>);
  /** Passed through to the worker process; TYPESAFE_API_KEY is read from the gateway's own environment. */
  env?: NodeJS.ProcessEnv;
}

/** Runs `uv run gateway-worker` in the pinned worker project and streams its events. */
export class SubprocessRunner implements WorkerRunner {
  constructor(private readonly options: SubprocessRunnerOptions) {}

  start(command: WorkerCommand, onEvent: (event: WorkerEvent) => void): WorkerHandle {
    let child: ChildProcessWithoutNullStreams | null = null;
    let cancelled = false;
    let finishedEvent: FinishedEvent | null = null;
    let stderr = "";
    const finished = new Promise<FinishedEvent>((resolve) => {
      const settle = (reason: string) => {
        if (finishedEvent) return resolve(finishedEvent);
        const failure: FinishedEvent = { type: "finished", outcome: "failed", reason, elapsedMs: 0, modelCalls: 0, actions: 0 };
        onEvent(failure);
        resolve(failure);
      };
      const cdp = typeof this.options.cdpUrl === "string" ? Promise.resolve(this.options.cdpUrl) : this.options.cdpUrl(command.accountId);
      cdp.then((cdpUrl) => {
        if (cancelled) return settle("cancelled before the browser was ready");
        child = this.spawnWorker(command, cdpUrl);
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-4000);
        });
        this.stream(child, onEvent, (event) => (finishedEvent = event), settle, () => stderr);
        child.stdin.write(JSON.stringify(command) + "\n");
      }, (error: Error) => settle(`browser for account ${command.accountId} unavailable: ${error.message}`));
    });
    return {
      finished,
      cancel: () => {
        cancelled = true;
        if (child && child.exitCode === null) child.stdin.write(JSON.stringify({ type: "cancel" }) + "\n");
      }
    };
  }

  private spawnWorker(command: WorkerCommand, cdpUrl: string): ChildProcessWithoutNullStreams {
    const env: NodeJS.ProcessEnv = {
      ...(this.options.env ?? process.env),
      BU_CDP_URL: cdpUrl,
      BU_NAME: `gateway-${command.runId.slice(0, 8)}`,
      BH_TELEMETRY: "0",
      BH_TAB_MARKER: "0",
      BH_UPDATE_CHECK: "0"
    };
    return spawn("uv", ["run", "--frozen", "gateway-worker"], { cwd: this.options.workerDir, env, stdio: ["pipe", "pipe", "pipe"] });
  }

  private stream(
    child: ChildProcessWithoutNullStreams,
    onEvent: (event: WorkerEvent) => void,
    onFinished: (event: FinishedEvent) => void,
    settle: (reason: string) => void,
    stderr: () => string
  ) {
    {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let event: WorkerEvent;
        try {
          event = JSON.parse(line) as WorkerEvent;
        } catch {
          return;
        }
        if (event.type === "finished") onFinished(event);
        onEvent(event);
      });
      let stdoutClosed = false;
      let exitCode: number | null | undefined;
      const maybeSettle = () => {
        if (stdoutClosed && exitCode !== undefined) settle(`worker exited (${exitCode}) without a result: ${stderr().trim().slice(-500)}`);
      };
      child.on("error", (error) => settle(`worker could not start: ${error.message}`));
      rl.on("close", () => {
        stdoutClosed = true;
        maybeSettle();
      });
      child.on("exit", (code) => {
        exitCode = code;
        maybeSettle();
      });
    }
  }
}
