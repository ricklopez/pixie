const TOKEN_KEY = "gateway.studio.token";
const CLIENT_TOKEN_KEY = "gateway.studio.clientToken";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function getClientToken(): string {
  return localStorage.getItem(CLIENT_TOKEN_KEY) ?? "";
}
export function setClientToken(token: string) {
  localStorage.setItem(CLIENT_TOKEN_KEY, token);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown
  ) {
    super(typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${status}`);
  }
}

export async function api<T>(method: string, url: string, body?: unknown, token = getToken(), headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export type AutomationState = "draft" | "recording" | "configuring" | "testing" | "ready" | "published";

export interface Definition {
  schemaVersion: string;
  id: string;
  name: string;
  engine: string;
  engineRevision: string;
  startUrl: string;
  allowedOrigins: string[];
  effect: string;
  inputs: { name: string; type: string; required: boolean; description?: string; source: string; binding: { checkpointId: string; targetLabel: string; eventSeq?: number } }[];
  outputs: { name: string; type: string; required: boolean; description?: string; extractor: Record<string, unknown> & { kind: string } }[];
  checkpoints: { id: string; objective: string; precondition: Condition[]; postcondition: Condition[]; allowedEffects: string[]; maxActions: number }[];
  assertions: Record<string, unknown>[];
  limits: { maxActions: number; deadlineMs: number };
  sourceRecordingId?: string;
  authRequiredSignals: Condition[];
}
export type Condition = { kind: string } & Record<string, string>;

export interface Automation {
  id: string;
  name: string;
  state: AutomationState;
  states: AutomationState[];
  definition: Definition;
  recordingId: string | null;
  lastTestRunId: string | null;
  inputSchema: { properties: Record<string, { type: string; description?: string }>; required: string[] };
  outputSchema: { properties: Record<string, { type: string; description?: string }>; required: string[] };
  revisions: { revision: number; checksum: string; publishedAt: string; publishedBy: string; testRunId: string | null }[];
  createdAt: string;
  updatedAt: string;
  checksum?: string;
}

export interface RecordingStatus {
  id: string;
  connected: boolean;
  startedAt: string;
  stoppedAt: string | null;
  elapsedMs: number;
  actionCount: number;
  warnings: { code: string; message: string; seq?: number }[];
  currentUrl: string | null;
  error: string | null;
}

export interface RecordingView {
  id: string;
  startedAt: string;
  stoppedAt: string;
  actionCount: number;
  events: RecordedEvent[];
  warnings: { code: string; message: string; seq?: number }[];
  suggestion: { checkpoints: Definition["checkpoints"]; inputs: Definition["inputs"]; unbound: RecordedEvent[] };
}

export interface RecordedEvent {
  seq: number;
  at: number;
  kind: "navigate" | "click" | "input" | "select" | "keypress" | "submit" | "unsupported";
  url: string;
  target?: { tag: string; role: string | null; label: string | null; name: string | null; id: string | null; placeholder: string | null; inputType: string | null; text: string | null; selectorHints: string[] };
  hasValue?: boolean;
  valueLength?: number;
  optionLabel?: string;
  key?: string;
  reason?: string;
  frame?: "main" | "subframe";
}

export type RunState = "queued" | "running" | "verifying" | "completed" | "needs_review" | "awaiting_auth" | "failed" | "cancelled";
export const TERMINAL: RunState[] = ["completed", "needs_review", "awaiting_auth", "failed", "cancelled"];

export interface ReviewExport {
  automationId: string;
  exportedAt: string;
  files: Record<string, string>;
  excluded: string[];
}

export interface Run {
  id: string;
  automationId: string;
  revision: number;
  accountId: string;
  kind: "test" | "endpoint";
  state: RunState;
  input: Record<string, unknown>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  failure: { reason?: string; reasons?: string[] } | null;
  metrics: { engine: string; engineRevision: string; modelCalls: number; actions: number; elapsedMs: number; modelLatencyMs: number[]; inputTokens: number; outputTokens: number; policyRejections: number } | null;
}

export interface RunEvidence {
  run: Run;
  timeline: { seq: number; at: string; event: Record<string, unknown> & { type: string } }[];
  checkpoints: Record<string, unknown>[];
  modelDecisions: (Record<string, unknown> & { checkpointId: string; model: string; operation: string; latencyMs: number; confidence?: number })[];
  actions: (Record<string, unknown> & { step: number; action: string; kind: string; boundInput: string | null; typedLength: number; url: string })[];
  policyRejections: Record<string, unknown>[];
  verification: { accepted: boolean; checks: { id: string; kind: string; passed: boolean; detail: string }[]; reasons?: string[] } | null;
  rawExtraction: Record<string, { value: string | null; source: string; checkpointId: string }> | null;
  data: Record<string, unknown> | null;
  finalUrl: string | null;
  screenshots: { name: string; checkpointId: string; label: string; url: string }[];
}

export interface Account {
  id: string;
  name: string;
  portalOrigin: string;
  createdAt: string;
}
