import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TODO_TEMPLATES } from "@gateway/definition";
import { resolveChromeExecutable } from "@gateway/recorder";

/** Root of the Pixie checkout this CLI was built in; `pixie dev`/`doctor` operate on that checkout. */
export const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const ENGINE_REVISION = "1231850a0bf1a0c0341fe408ef1668dbbfdfac46";

export interface Project {
  apiUrl: string;
  studioUrl: string;
  portalOrigin: string;
  accountId: string;
  engine: "live" | "scripted";
  clientToken?: string;
}

const DEFAULT_PROJECT: Project = {
  apiUrl: "http://127.0.0.1:4180",
  studioUrl: "http://127.0.0.1:5173",
  portalOrigin: "http://127.0.0.1:4174",
  accountId: "acct_demo",
  engine: "live"
};

const HELP = `pixie — local developer CLI for the Pixie gateway (runs from this checkout; there is no npm package)

  pixie init <directory>          create a Pixie project folder (pixie.json, .env.example); never overwrites
  pixie doctor                    check Node, uv/worker, Chrome, model variable, build and running services
  pixie dev [--scripted] [--headless] [--portal]
                                  start the API (+ dedicated browsers) and Studio from this checkout
  pixie list                       list automations
  pixie accounts [list]           list accounts; use \`accounts add\` to configure one
  pixie accounts add --name <n> --origin <url> [--id <id>] [--provider local|browserbase] [--environment <env>]
  pixie accounts secret <id> --ref <name>
  pixie create <name> --url <startUrl> [--template eligibility-overview|create-todo|list-todos|update-todo|delete-todo]
      [--allowed-origin <origin>...]
  pixie show <automationId>       show an automation and its definition
  pixie record start <id> [--url] start recording in the API-owned browser
  pixie record status <id>        show the active recording status
  pixie record stop <id>          stop recording and summarize captured steps
  pixie record <id>               start, wait for Enter, then stop the recording
  pixie definition get <id> [-o file]
  pixie definition set <id> <file>
  pixie draft <id>                fork a published automation into a new draft
  pixie test <id> [--account <id>] [--input '<json>'] [--follow]
  pixie generate <id> [--recording <file>]
  pixie test <id> --engine script
  pixie repair <id> --run <runId> [--source file | --model]
  pixie repairs <id>
  pixie approve <repairId>
  pixie reject <repairId> --reason <text>
  pixie rollback <id>
  pixie publish <id>              publish the tested definition
  pixie models                    list published output models
  pixie repos                     list published repositories
  pixie ops [repo]                list declared repository operations
  pixie diff <id>                 preview contract compatibility before publish
  pixie retire <operationVersionId>
  pixie runs [--automation <id>]  list Studio runs
  pixie run <runId> [--events]    inspect a run and its timeline
  pixie cancel <runId>            cancel a queued or running Studio run
  pixie spend                      show provider-call spend totals and ledger rows
  pixie connections               list Browserbase connections
  pixie connect <accountId> [--env <environment>]
                                  open and poll the Studio login handoff
  pixie disconnect <connectionId>
  pixie invoke <id> --input '<json>' [--account <id>] [--revision <n>]
      [--idempotency-key <key>] [--follow]
  pixie invoke --repo <r> --method <m> --version <major> --input '<json>' [--account <id>] [--follow]
  pixie openapi <id> [-o file]    retrieve the published OpenAPI document
  pixie export <id> [-o file]     retrieve the review export
  pixie mcp config [--client-token-env NAME]
  pixie mcp call <tool> --args '<json>'
  pixie keys create <name> --role client|developer
  pixie open [runId|automationId] print a Studio URL and open it when $BROWSER is set

Use \`--json\` on API commands to emit the API response as JSON. Studio commands require a
developer key (GATEWAY_DEV_TOKEN); \`invoke\` uses the client key (GATEWAY_CLIENT_TOKEN).
Both default to local demo tokens unless overridden by the project config/environment.
Tokens and provider keys are never included in normal command output. \`keys create\` reveals
the newly generated token once; copy it securely. Recording requires \`pixie dev\` with a
visible browser (omit \`--headless\`).`;

type Out = { log: (line: string) => void; error: (line: string) => void };
const stdio: Out = { log: (l) => console.log(l), error: (l) => console.error(l) };

export function loadProject(cwd = process.cwd()): Project {
  const file = resolve(cwd, "pixie.json");
  if (!existsSync(file)) return DEFAULT_PROJECT;
  return { ...DEFAULT_PROJECT, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<Project>) };
}

// -- init -------------------------------------------------------------------------------------------------

export function init(directory: string, out: Out = stdio, jsonMode = false): number {
  const target = resolve(directory);
  if (existsSync(target) && readdirSync(target).length > 0) {
    out.error(`refusing to initialise ${target}: directory exists and is not empty (pixie never overwrites a project)`);
    return 1;
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(resolve(target, "pixie.json"), JSON.stringify(DEFAULT_PROJECT, null, 2) + "\n");
  writeFileSync(
    resolve(target, ".env.example"),
    [
      "# Copy to .env and fill in locally; .env is git-ignored. pixie reads these from your shell environment.",
      "TYPESAFE_API_KEY=            # required for GATEWAY_ENGINE=live (real Jev Ultrafast decisions)",
      "GATEWAY_DEV_TOKEN=dev-token-local",
      "GATEWAY_CLIENT_TOKEN=client-token-local",
      "# GATEWAY_CHROME_PATH=      # only if Chrome is not in a well-known location",
      ""
    ].join("\n")
  );
  writeFileSync(resolve(target, ".gitignore"), ".env\n.env.*\n!.env.example\nartifacts/\nbrowser-data/\n");
  writeFileSync(
    resolve(target, "README.md"),
    [
      "# Pixie project",
      "",
      "1. `pixie doctor` — verify Node, uv, Chrome and the model variable.",
      "2. `pixie dev` — start the API and Studio from the Pixie checkout.",
      "3. Build and review automations with `pixie create`, `pixie definition`, `pixie test`, and `pixie publish`.",
      "4. Use `pixie record <id>` with a visible browser to capture a workflow.",
      "",
      `Settings live in pixie.json (account \`${DEFAULT_PROJECT.accountId}\`, portal ${DEFAULT_PROJECT.portalOrigin}); secrets only in your environment.`,
      ""
    ].join("\n")
  );
  if (jsonMode) out.log(JSON.stringify({ created: target, files: ["pixie.json", ".env.example", ".gitignore", "README.md"] }));
  else out.log(`created Pixie project in ${target} (pixie.json, .env.example, .gitignore, README.md)`);
  return 0;
}

// -- doctor -----------------------------------------------------------------------------------------------

export interface Check {
  name: string;
  ok: boolean;
  level: "fail" | "warn";
  detail: string;
}

function mcpConfig(project: Project, tokenEnv: string, out: Out) {
  const snippet = {
    mcpServers: {
      pixie: {
        url: `${project.apiUrl.replace(/\/+$/, "")}/mcp`,
        headers: { Authorization: `Bearer \${${tokenEnv}}` }
      }
    }
  };
  out.log(JSON.stringify(snippet, null, 2));
  return 0;
}

async function mcpCall(project: Project, tool: string, argsText: string | undefined, out: Out) {
  if (!argsText) return usage(out, "pixie mcp call <tool> --args '<json>'");
  let args: unknown;
  try {
    args = JSON.parse(argsText) as unknown;
  } catch (error) {
    out.error(`pixie mcp: --args must be valid JSON (${(error as Error).message})`);
    return 2;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    out.error("pixie mcp: --args must be a JSON object");
    return 2;
  }
  const token = process.env.GATEWAY_CLIENT_TOKEN ?? project.clientToken ?? "client-token-local";
  const transport = new StreamableHTTPClientTransport(new URL(`${project.apiUrl.replace(/\/+$/, "")}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  });
  const client = new Client({ name: "pixie-cli", version: "0.1.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args as Record<string, unknown> });
    out.log(JSON.stringify(result, null, 2));
    return result.isError ? 1 : 0;
  } finally {
    await client.close();
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function commandVersion(cmd: string, args: string[]): string | null {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || result.stderr.trim() : null;
}

export async function doctorChecks(project: Project, env: NodeJS.ProcessEnv = process.env, checkout = CHECKOUT): Promise<Check[]> {
  const checks: Check[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({ name: "node >= 22.13", ok: major! > 22 || (major === 22 && minor! >= 13), level: "fail", detail: `found ${process.versions.node}` });

  const uv = commandVersion("uv", ["--version"]);
  checks.push({ name: "uv (Python worker manager)", ok: uv !== null, level: "fail", detail: uv ?? "not on PATH; install from https://docs.astral.sh/uv/" });
  checks.push({ name: "worker environment synced", ok: existsSync(resolve(checkout, "workers/jev/.venv")), level: "fail", detail: existsSync(resolve(checkout, "workers/jev/.venv")) ? "workers/jev/.venv present" : "run `npm run worker:sync`" });
  const lock = existsSync(resolve(checkout, "workers/jev/uv.lock")) ? readFileSync(resolve(checkout, "workers/jev/uv.lock"), "utf8") : "";
  checks.push({ name: `jev-ultrafast pinned to ${ENGINE_REVISION.slice(0, 12)}`, ok: lock.includes(ENGINE_REVISION), level: "fail", detail: lock.includes(ENGINE_REVISION) ? "uv.lock matches" : "uv.lock does not reference the pinned revision" });

  let chrome: string | null = null;
  try {
    chrome = resolveChromeExecutable(env.GATEWAY_CHROME_PATH);
  } catch {
    chrome = null;
  }
  const chromeOk = chrome !== null && (chrome.includes("/") || chrome.includes("\\") ? existsSync(chrome) : commandVersion(chrome, ["--version"]) !== null);
  checks.push({ name: "Chrome executable", ok: chromeOk, level: "fail", detail: chromeOk ? chrome! : `${chrome ?? "not found"} — set GATEWAY_CHROME_PATH` });

  const key = Boolean(env.TYPESAFE_API_KEY);
  checks.push({ name: "TYPESAFE_API_KEY (live Jev)", ok: key || project.engine === "scripted", level: project.engine === "live" ? "fail" : "warn", detail: key ? "set (value not shown)" : project.engine === "live" ? "missing; pixie.json engine is live" : "missing; scripted engine needs no model" });

  const built = existsSync(resolve(checkout, "apps/api/dist/main.js"));
  checks.push({ name: "gateway built", ok: built, level: "fail", detail: built ? "apps/api/dist present" : "run `npm run build`" });

  const api = await reachable(`${project.apiUrl}/health`);
  checks.push({ name: `API at ${project.apiUrl}`, ok: api, level: "warn", detail: api ? "healthy" : "not running (start with `pixie dev`)" });
  const studio = await reachable(project.studioUrl);
  checks.push({ name: `Studio at ${project.studioUrl}`, ok: studio, level: "warn", detail: studio ? "reachable" : "not running (start with `pixie dev`)" });
  return checks;
}

export async function doctor(project: Project, out: Out = stdio, jsonMode = false): Promise<number> {
  const checks = await doctorChecks(project);
  if (jsonMode) {
    out.log(JSON.stringify(checks));
    return checks.some((check) => !check.ok && check.level === "fail") ? 1 : 0;
  }
  for (const c of checks) out.log(`${c.ok ? "ok  " : c.level === "fail" ? "FAIL" : "warn"}  ${c.name}: ${c.detail}`);
  const failed = checks.filter((c) => !c.ok && c.level === "fail");
  out.log(failed.length ? `${failed.length} problem(s) must be fixed before \`pixie dev\` will work` : "environment ready");
  return failed.length ? 1 : 0;
}

// -- dev --------------------------------------------------------------------------------------------------

export async function dev(project: Project, flags: { scripted: boolean; headless: boolean; portal: boolean }, out: Out = stdio): Promise<number> {
  const engine = flags.scripted ? "scripted" : project.engine;
  if (engine === "live" && !process.env.TYPESAFE_API_KEY) {
    out.error("GATEWAY_ENGINE=live needs TYPESAFE_API_KEY in your environment; export it or run `pixie dev --scripted` for the no-model demo.");
    return 2;
  }
  if (!existsSync(resolve(CHECKOUT, "apps/api/dist/main.js"))) {
    out.log("building the gateway first (npm run build)…");
    const build = spawnSync("npm", ["run", "build"], { cwd: CHECKOUT, stdio: "inherit" });
    if (build.status !== 0) return build.status ?? 1;
  }
  const env = { ...process.env, GATEWAY_ENGINE: engine, GATEWAY_BROWSER_VISIBLE: flags.headless ? "0" : "1", GATEWAY_PORT: String(new URL(project.apiUrl).port || 4180) };
  const children: ChildProcess[] = [];
  const start = (name: string, args: string[], cwd = CHECKOUT) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const prefix = (chunk: Buffer) => chunk.toString().split("\n").filter(Boolean).forEach((l) => out.log(`[${name}] ${l}`));
    child.stdout?.on("data", prefix);
    child.stderr?.on("data", prefix);
    children.push(child);
    return child;
  };
  start("api", ["apps/api/dist/main.js"]);
  start("studio", [resolve(CHECKOUT, "node_modules/vite/bin/vite.js"), "--port", String(new URL(project.studioUrl).port || 5173), "--strictPort"], resolve(CHECKOUT, "apps/studio"));
  if (flags.portal) start("portal", ["apps/portal/dist/server.js"]);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !(await reachable(`${project.apiUrl}/health`))) await new Promise((r) => setTimeout(r, 300));
  out.log(
    (await reachable(`${project.apiUrl}/health`))
      ? `pixie dev: API ${project.apiUrl} (engine=${engine}, browsers ${flags.headless ? "headless" : "visible"}, one profile per account under artifacts/gateway/browser-data), Studio ${project.studioUrl}. Ctrl-C stops everything and closes the dedicated browsers.`
      : "pixie dev: the API did not become healthy within 30s; see the [api] output above"
  );
  return new Promise<number>((done) => {
    const stop = () => {
      for (const c of children) c.kill("SIGINT");
      setTimeout(() => {
        for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
        done(0);
      }, 8000).unref();
      Promise.all(children.map((c) => new Promise((r) => (c.exitCode === null ? c.once("exit", r) : r(null))))).then(() => done(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    children[0]!.once("exit", (code) => {
      out.error(`[api] exited with code ${code}`);
      stop();
    });
  });
}

// -- Studio and client API commands -----------------------------------------------------------------------

interface ApiResponse {
  status: number;
  json: unknown;
  raw: string;
}

interface RunView {
  id: string;
  automationId?: string;
  state: string;
  kind?: string;
  revision?: number;
  metrics?: Record<string, unknown> | null;
  failure?: { reason?: string; reasons?: string[] } | null;
}

interface RunEvidence {
  run: RunView;
  verification: { accepted: boolean; checks: { id: string; passed: boolean; detail?: string }[]; reasons?: string[] } | null;
  data: unknown;
  screenshots: unknown[];
  timeline?: { seq: number; at: string; event: Record<string, unknown> & { type: string } }[];
}

const TERMINAL_RUN_STATES = new Set(["completed", "needs_review", "failed", "awaiting_auth", "cancelled"]);

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function tokenForStudio(): string {
  return process.env.GATEWAY_DEV_TOKEN ?? "dev-token-local";
}

function tokenForClient(project: Project): string {
  return process.env.GATEWAY_CLIENT_TOKEN ?? project.clientToken ?? "client-token-local";
}

async function apiRequest(
  project: Project,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<ApiResponse> {
  const url = `${project.apiUrl.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  }).catch((error: Error) => {
    throw new Error(`cannot reach the API at ${project.apiUrl} (${error.message}); start it with \`pixie dev\``);
  });
  const raw = await res.text();
  let json: unknown = null;
  if (raw) {
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      json = raw;
    }
  }
  return { status: res.status, json, raw };
}

function studioRequest(project: Project, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  return apiRequest(project, tokenForStudio(), method, path, body);
}

function clientRequest(project: Project, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse> {
  return apiRequest(project, tokenForClient(project), method, path, body, headers);
}

function apiErrorMessage(value: unknown): string {
  const body = asObject(value);
  if (typeof body?.error === "string") return body.error;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function reportApiError(out: Out, command: string, response: ApiResponse, jsonMode: boolean): number {
  if (jsonMode) {
    out.log(response.raw || "null");
    return 1;
  }
  out.error(`pixie ${command}: HTTP ${response.status}: ${apiErrorMessage(response.json)}`);
  const issues = asObject(response.json)?.issues;
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      const entry = asObject(issue);
      if (entry) out.error(`  ${String(entry.path ?? "definition")}: ${String(entry.message ?? "invalid")}`);
    }
  }
  return 1;
}

function emitApiJson(out: Out, response: ApiResponse): void {
  out.log(response.raw || "null");
}

function emitObject(out: Out, value: unknown): void {
  out.log(JSON.stringify(value, null, 2));
}

function printMetrics(out: Out, value: unknown): void {
  const metrics = asObject(value);
  if (!metrics) return;
  const engine = String(metrics.engine ?? "");
  const countLabel = engine.toLowerCase().includes("scripted") ? "scripted decisions" : "Jev decisions";
  const providerCalls = String(metrics.providerCalls ?? "unknown");
  const estimatedCost = typeof metrics.estimatedCostUsd === "number" ? `$${metrics.estimatedCostUsd.toFixed(6)}` : "unknown";
  const sessionSeconds = Number(metrics.browserSessionSeconds ?? 0);
  out.log(
    `${countLabel}=${String(metrics.modelCalls ?? "unknown")} providerCalls=${providerCalls} estimatedCostUsd=${estimatedCost} ` +
      `browserSessionSeconds=${sessionSeconds} browserSessionMinutes=${(sessionSeconds / 60).toFixed(2)} engine=${engine || "unknown"} ` +
      `actions=${String(metrics.actions ?? "unknown")} ` +
      `elapsedMs=${String(metrics.elapsedMs ?? "unknown")}`
  );
}

function printVerification(out: Out, value: RunEvidence["verification"]): void {
  if (!value) {
    out.log("verification: unavailable");
    return;
  }
  const passed = value.checks.filter((check) => check.passed).length;
  out.log(`verification: ${value.accepted ? "accepted" : "rejected"} (${passed}/${value.checks.length} checks passed)`);
  for (const check of value.checks) out.log(`  ${check.passed ? "pass" : "FAIL"}  ${check.id}${check.detail ? ` ${check.detail}` : ""}`);
  for (const reason of value.reasons ?? []) out.log(`  reason: ${reason}`);
}

function printRunEvidence(out: Out, project: Project, evidence: RunEvidence): void {
  out.log(`state: ${evidence.run.state}`);
  printVerification(out, evidence.verification);
  printMetrics(out, evidence.run.metrics);
  if (evidence.run.state === "completed") out.log(`data: ${JSON.stringify(evidence.data)}`);
  if (evidence.run.failure?.reason) out.log(`failure: ${evidence.run.failure.reason}`);
  out.log(`evidence: ${evidence.screenshots.length} screenshot(s); inspect at ${project.studioUrl}/#/runs/${evidence.run.id}`);
}

export async function list(project: Project, out: Out = stdio, jsonMode = false): Promise<number> {
  const response = await studioRequest(project, "GET", "/studio/automations");
  if (response.status !== 200 || !Array.isArray(response.json)) return reportApiError(out, "list", response, jsonMode);
  if (jsonMode) {
    emitApiJson(out, response);
    return 0;
  }
  for (const item of response.json) {
    const automation = asObject(item);
    if (!automation) continue;
    const revisions = Array.isArray(automation.revisions) ? automation.revisions.length : 0;
    out.log(`${String(automation.id)}  ${String(automation.state ?? "").padEnd(11)}  revisions=${revisions}  ${String(automation.name)}`);
  }
  if (response.json.length === 0) out.log("no automations yet — create one with `pixie create`");
  return 0;
}

async function accountsList(project: Project, out: Out, jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, "GET", "/studio/accounts");
  if (response.status !== 200 || !Array.isArray(response.json)) return reportApiError(out, "accounts", response, jsonMode);
  if (jsonMode) {
    emitApiJson(out, response);
    return 0;
  }
  out.log("ID  NAME  ORIGIN");
  for (const item of response.json) {
    const account = asObject(item);
    if (account) out.log(`${String(account.id)}  ${String(account.name)}  ${String(account.portalOrigin)}`);
  }
  if (response.json.length === 0) out.log("no accounts configured");
  return 0;
}

async function accountAdd(project: Project, out: Out, name: string, origin: string, id: string | undefined, provider: string | undefined, environment: string | undefined, jsonMode: boolean): Promise<number> {
  if (provider && provider !== "local" && provider !== "browserbase") {
    out.error("pixie accounts add: --provider must be local or browserbase");
    return 2;
  }
  const response = await studioRequest(project, "POST", "/studio/accounts", { name, portalOrigin: origin, ...(id ? { id } : {}), ...(provider ? { provider } : {}), ...(environment ? { environment } : {}) });
  if (response.status !== 201) return reportApiError(out, "accounts add", response, jsonMode);
  if (jsonMode) emitApiJson(out, response);
  else out.log(`created account ${String(asObject(response.json)?.id ?? "")}`);
  return 0;
}

async function connectionsList(project: Project, out: Out, jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, "GET", "/studio/connections");
  if (response.status !== 200 || !Array.isArray(response.json)) return reportApiError(out, "connections", response, jsonMode);
  if (jsonMode) emitApiJson(out, response);
  else {
    out.log("ID  ACCOUNT  ENVIRONMENT  STATE");
    for (const raw of response.json) {
      const item = asObject(raw);
      if (item) out.log(`${String(item.id)}  ${String(item.accountName)}  ${String(item.environment)}  ${String(item.state)}`);
    }
    if (response.json.length === 0) out.log("no Browserbase connections");
  }
  return 0;
}

async function connectAccount(project: Project, out: Out, accountId: string, environment: string | undefined, jsonMode: boolean): Promise<number> {
  const created = await studioRequest(project, "POST", "/studio/connections", { accountId, ...(environment ? { environment } : {}) });
  if (created.status !== 201) return reportApiError(out, "connect", created, jsonMode);
  const connection = asObject(created.json);
  const id = typeof connection?.id === "string" ? connection.id : "";
  if (!id) return 1;
  const started = await studioRequest(project, "POST", `/studio/connections/${encodeURIComponent(id)}/connect`);
  if (started.status !== 201) return reportApiError(out, "connect", started, jsonMode);
  const handoffUrl = `${project.studioUrl.replace(/\/+$/, "")}/#/connections/${encodeURIComponent(id)}`;
  if (jsonMode) out.log(JSON.stringify({ connectionId: id, handoffUrl }));
  else out.log(`Handoff: ${handoffUrl}\nComplete login in Studio, then choose Resume.`);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const response = await studioRequest(project, "GET", `/studio/connections/${encodeURIComponent(id)}`);
    if (response.status !== 200) return reportApiError(out, "connect", response, jsonMode);
    const state = String(asObject(response.json)?.state ?? "connecting");
    if (state === "connected" || state === "auth_required") {
      if (jsonMode) out.log(JSON.stringify({ connectionId: id, state }));
      else out.log(state);
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  out.error("pixie connect: timed out waiting for handoff state");
  return 1;
}

async function disconnect(project: Project, out: Out, id: string, jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, "POST", `/studio/connections/${encodeURIComponent(id)}/disconnect`);
  if (response.status !== 200) return reportApiError(out, "disconnect", response, jsonMode);
  if (jsonMode) emitApiJson(out, response);
  else out.log(`disconnected ${id} (${String(asObject(response.json)?.contextCleanup ?? "unknown")} context cleanup)`);
  return 0;
}

async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  const input = process.stdin;
  return new Promise<string>((resolveSecret, rejectSecret) => {
    let value = "";
    const previousRaw = input.isRaw;
    const finish = (error?: Error) => {
      input.removeListener("data", onData);
      input.setRawMode(Boolean(previousRaw));
      input.pause();
      process.stderr.write("\n");
      if (error) rejectSecret(error);
      else resolveSecret(value);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("secret input cancelled"));
        if (byte === 10 || byte === 13) return finish();
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else if (byte >= 32) value += String.fromCharCode(byte);
      }
    };
    process.stderr.write("Secret value (input is hidden): ");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function accountSecret(project: Project, out: Out, id: string, ref: string, jsonMode: boolean): Promise<number> {
  const value = await readSecret();
  const response = await studioRequest(project, "PUT", `/studio/accounts/${encodeURIComponent(id)}/secrets`, { [ref]: value });
  if (response.status !== 200) return reportApiError(out, "accounts secret", response, jsonMode);
  if (jsonMode) emitApiJson(out, response);
  else out.log(`stored account secret reference '${ref}' for ${id} (value not displayed)`);
  return 0;
}

async function createAutomation(
  project: Project,
  out: Out,
  name: string,
  startUrl: string,
  template: string | undefined,
  allowedOrigins: string[] | undefined,
  jsonMode: boolean
): Promise<number> {
  if (template && template !== "eligibility-overview" && !(TODO_TEMPLATES as readonly string[]).includes(template)) {
    out.error(`pixie create: unsupported template '${template}' (use eligibility-overview or ${TODO_TEMPLATES.join(", ")})`);
    return 2;
  }
  const response = await studioRequest(project, "POST", "/studio/automations", {
    name,
    startUrl,
    ...(template ? { template } : {}),
    ...(allowedOrigins?.length ? { allowedOrigins } : {})
  });
  if (response.status !== 201) return reportApiError(out, "create", response, jsonMode);
  if (jsonMode) emitApiJson(out, response);
  else {
    const automation = asObject(response.json);
    out.log(`created ${String(automation?.id ?? "")} (${String(automation?.state ?? "draft")})`);
    out.log(`review its definition with \`pixie definition get ${String(automation?.id ?? "")}\``);
  }
  return 0;
}

async function showAutomation(project: Project, out: Out, id: string, jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, "GET", `/studio/automations/${encodeURIComponent(id)}`);
  if (response.status !== 200) return reportApiError(out, "show", response, jsonMode);
  if (jsonMode) emitApiJson(out, response);
  else {
    const automation = asObject(response.json);
    out.log(`${String(automation?.name ?? "")}  ${String(automation?.id ?? id)}  state=${String(automation?.state ?? "unknown")}`);
    out.log(`definition:`);
    emitObject(out, automation?.definition ?? null);
    out.log(`published revisions: ${Array.isArray(automation?.revisions) ? automation.revisions.length : 0}`);
  }
  return 0;
}

function recordingSummary(value: unknown, out: Out): void {
  const recording = asObject(value);
  const events = Array.isArray(recording?.events) ? recording.events : [];
  const warnings = Array.isArray(recording?.warnings) ? recording.warnings : [];
  const suggestion = asObject(recording?.suggestion);
  out.log(`recording ${String(recording?.id ?? "")}: ${String(recording?.actionCount ?? events.length)} captured action(s)`);
  for (const event of events) {
    const entry = asObject(event);
    if (!entry) continue;
    const target = asObject(entry.target);
    out.log(`  ${String(entry.seq ?? "?")} ${String(entry.kind ?? "step")}${target?.label ? ` — ${String(target.label)}` : ""}`);
  }
  for (const warning of warnings) {
    const entry = asObject(warning);
    if (entry) out.log(`  warning: ${String(entry.message ?? entry.code ?? "recording warning")}`);
  }
  if (suggestion) {
    out.log(
      `suggestion: ${Array.isArray(suggestion.checkpoints) ? suggestion.checkpoints.length : 0} checkpoint(s), ` +
        `${Array.isArray(suggestion.inputs) ? suggestion.inputs.length : 0} input(s), ` +
        `${Array.isArray(suggestion.unbound) ? suggestion.unbound.length : 0} unbound event(s)`
    );
  }
}

async function recordRequest(
  project: Project,
  out: Out,
  id: string,
  action: "start" | "status" | "stop",
  startUrl: string | undefined,
  jsonMode: boolean
): Promise<{ code: number; json: unknown }> {
  const root = `/studio/automations/${encodeURIComponent(id)}/recording`;
  const response =
    action === "start"
      ? await studioRequest(project, "POST", `${root}/start`, startUrl ? { startUrl } : {})
      : action === "status"
        ? await studioRequest(project, "GET", `${root}/status`)
        : await studioRequest(project, "POST", `${root}/stop`, {});
  const expected = action === "start" ? 201 : 200;
  if (response.status !== expected) return { code: reportApiError(out, `record ${action}`, response, jsonMode), json: response.json };
  if (jsonMode) emitApiJson(out, response);
  else if (action === "status") emitObject(out, response.json);
  else if (action === "stop") recordingSummary(response.json, out);
  else {
    const status = asObject(response.json);
    out.log(`recording started for ${id} (session ${String(status?.id ?? "")})`);
  }
  return { code: 0, json: response.json };
}

async function waitForEnter(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      process.removeListener("SIGINT", onInterrupt);
      readline.close();
      resolvePromise();
    };
    const onInterrupt = () => {
      process.stderr.write("\n");
      finish();
    };
    process.once("SIGINT", onInterrupt);
    readline.once("line", finish);
    readline.once("close", finish);
    process.stderr.write("Press Enter to stop recording (Ctrl-C also stops): ");
  });
}

async function recordInteractive(project: Project, out: Out, id: string, startUrl: string | undefined, jsonMode: boolean): Promise<number> {
  const started = await recordRequest(project, out, id, "start", startUrl, jsonMode);
  if (started.code !== 0) return started.code;
  out.error("Perform the workflow in the API-owned visible browser window; Pixie CLI does not drive the browser.");
  await waitForEnter();
  return (await recordRequest(project, out, id, "stop", undefined, jsonMode)).code;
}

async function definitionGet(project: Project, out: Out, id: string, output: string | undefined, jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, "GET", `/studio/automations/${encodeURIComponent(id)}`);
  if (response.status !== 200) return reportApiError(out, "definition get", response, jsonMode);
  const definition = asObject(response.json)?.definition;
  if (!definition) {
    out.error(`pixie definition get: API response for ${id} did not include a definition`);
    return 1;
  }
  if (output) writeFileSync(resolve(output), `${JSON.stringify(definition, null, 2)}\n`);
  if (jsonMode) out.log(JSON.stringify(definition));
  else if (output) out.log(`wrote definition to ${resolve(output)}`);
  else emitObject(out, definition);
  return 0;
}

async function definitionSet(project: Project, out: Out, id: string, filename: string, jsonMode: boolean): Promise<number> {
  let definition: unknown;
  try {
    definition = JSON.parse(readFileSync(resolve(filename), "utf8")) as unknown;
  } catch (error) {
    out.error(`pixie definition set: cannot read definition file ${filename}: ${(error as Error).message}`);
    return 1;
  }
  const response = await studioRequest(project, "PUT", `/studio/automations/${encodeURIComponent(id)}/definition`, definition);
  if (response.status !== 200) return reportApiError(out, "definition set", response, jsonMode);
  if (jsonMode) emitApiJson(out, response);
  else {
    const automation = asObject(response.json);
    out.log(`updated definition for ${id}; state=${String(automation?.state ?? "configuring")}`);
    if (typeof automation?.checksum === "string") out.log(`checksum: ${automation.checksum}`);
  }
  return 0;
}

async function draft(project: Project, out: Out, id: string, jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, "POST", `/studio/automations/${encodeURIComponent(id)}/new-draft`, {});
  if (response.status !== 201) return reportApiError(out, "draft", response, jsonMode);
  if (jsonMode) emitApiJson(out, response);
  else out.log(`created draft ${String(asObject(response.json)?.id ?? "")}`);
  return 0;
}

export async function testRun(
  project: Project,
  automationId: string,
  accountId: string,
  input: unknown,
  out: Out = stdio,
  follow = false,
  jsonMode = false,
  engine?: string
): Promise<number> {
  const started = await studioRequest(project, "POST", `/studio/automations/${encodeURIComponent(automationId)}/test`, { accountId, input, ...(engine ? { engine } : {}) });
  if (started.status !== 202) return reportApiError(out, "test", started, jsonMode);
  const runId = String(asObject(started.json)?.id ?? "");
  if (!follow) {
    if (jsonMode) emitApiJson(out, started);
    else out.log(`test run ${runId} queued for account ${accountId}; use \`pixie run ${runId}\` to inspect it`);
    return 0;
  }
  if (!jsonMode) out.log(`test run ${runId} queued for account ${accountId}; waiting…`);
  const deadline = Date.now() + 120_000;
  let response: ApiResponse;
  let evidence: RunEvidence | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    response = await studioRequest(project, "GET", `/studio/runs/${encodeURIComponent(runId)}`);
    if (response.status !== 200) return reportApiError(out, "test", response, jsonMode);
    evidence = response.json as RunEvidence;
    if (TERMINAL_RUN_STATES.has(evidence.run.state)) {
      if (jsonMode) emitApiJson(out, response);
      else printRunEvidence(out, project, evidence);
      return evidence.run.state === "completed" && evidence.verification?.accepted === true ? 0 : 1;
    }
  }
  out.error(`pixie test: timed out waiting for run ${runId}`);
  return 1;
}

export async function publish(project: Project, automationId: string, out: Out = stdio, jsonMode = false): Promise<number> {
  const response = await studioRequest(project, "POST", `/studio/automations/${encodeURIComponent(automationId)}/publish`, {});
  if (response.status !== 201) return reportApiError(out, "publish", response, jsonMode);
  if (jsonMode) {
    emitApiJson(out, response);
    return 0;
  }
  const result = asObject(response.json);
  const revision = String(result?.revision ?? "");
  out.log(`published ${automationId} revision ${revision} (checksum ${String(result?.checksum ?? "")})`);
  if (result?.compatibility) {
    const model = asObject(result.modelVersion);
    const operation = asObject(result.operationVersion);
    const adapter = asObject(result.adapterRevision);
    out.log(`contract ${String(result.repository)}.${String(result.method)} compatibility=${String(result.compatibility)}`);
    out.log(`model v${String(model?.major)}.${String(model?.minor)} operation v${String(operation?.major)}.${String(operation?.minor)} adapter rev ${String(adapter?.revision)}`);
  }
  out.log(`openapi: ${String(result?.openapiUrl ?? "")}`);
  out.log(
    `invoke as a client:\n  pixie invoke ${automationId} --revision ${revision} --account ${project.accountId} --input '{}' --follow`
  );
  return 0;
}

async function adapterRequest(project: Project, method: string, path: string, body: unknown, out: Out, jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, method, path, body);
  if (response.status < 200 || response.status >= 300) return reportApiError(out, "adapter", response, jsonMode);
  const result = asObject(response.json);
  const unsupported = result?.unsupported;
  if (Array.isArray(unsupported) && unsupported.length > 0) {
    out.error(`adapter generation failed: ${JSON.stringify(unsupported)}`);
    return 1;
  }
  if (jsonMode) emitApiJson(out, response);
  else out.log(JSON.stringify(response.json, null, 2));
  return 0;
}

async function generate(project: Project, id: string, recordingFile: string | undefined, out: Out, jsonMode: boolean): Promise<number> {
  if (!recordingFile) return adapterRequest(project, "GET", `/studio/automations/${encodeURIComponent(id)}/generated`, undefined, out, jsonMode);
  const recording = JSON.parse(readFileSync(resolve(recordingFile), "utf8")) as { events: unknown[] };
  return adapterRequest(project, "POST", `/studio/automations/${encodeURIComponent(id)}/generated`, { recording }, out, jsonMode);
}

async function contractList(project: Project, kind: "models" | "repositories" | "operations", repo: string | undefined, out: Out, jsonMode: boolean): Promise<number> {
  const path = kind === "models" ? "/studio/models" : kind === "repositories" ? "/studio/repositories" : `/studio/operations${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
  const response = await studioRequest(project, "GET", path);
  if (response.status !== 200 || !Array.isArray(response.json)) return reportApiError(out, kind, response, jsonMode);
  if (jsonMode) return emitApiJson(out, response), 0;
  for (const row of response.json) out.log(JSON.stringify(row));
  if (!response.json.length) out.log(`no ${kind} found`);
  return 0;
}

async function diffContract(project: Project, id: string, out: Out, jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, "GET", `/studio/automations/${encodeURIComponent(id)}/contract`);
  if (response.status !== 200) return reportApiError(out, "diff", response, jsonMode);
  if (jsonMode) return emitApiJson(out, response), 0;
  const value = asObject(response.json);
  const diff = asObject(value?.compatibility);
  const next = asObject(value?.next);
  out.log(`${String(value?.repository)}.${String(value?.method)} compatibility=${String(diff?.level)} next=${String(next?.major)}.${String(next?.minor)} adapter=${String(next?.adapterRevision)}`);
  if (Array.isArray(diff?.changes)) for (const change of diff.changes) out.log(JSON.stringify(change));
  if (value?.error) out.error(String(value.error));
  return 0;
}

async function retireOperation(project: Project, id: string, out: Out, jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, "POST", `/studio/operations/${encodeURIComponent(id)}/retire`, {});
  if (response.status !== 200) return reportApiError(out, "retire", response, jsonMode);
  if (jsonMode) return emitApiJson(out, response), 0;
  out.log(JSON.stringify(response.json, null, 2));
  return 0;
}

async function runsList(project: Project, out: Out, automationId: string | undefined, jsonMode: boolean): Promise<number> {
  const query = automationId ? `?automationId=${encodeURIComponent(automationId)}` : "";
  const response = await studioRequest(project, "GET", `/studio/runs${query}`);
  if (response.status !== 200 || !Array.isArray(response.json)) return reportApiError(out, "runs", response, jsonMode);
  if (jsonMode) {
    emitApiJson(out, response);
    return 0;
  }
  out.log("RUN ID  AUTOMATION  STATE  KIND  REVISION");
  for (const item of response.json) {
    const run = asObject(item);
    if (run) out.log(`${String(run.id)}  ${String(run.automationId)}  ${String(run.state)}  ${String(run.kind)}  ${String(run.revision)}`);
  }
  if (response.json.length === 0) out.log("no runs found");
  return 0;
}

async function spend(project: Project, out: Out, jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, "GET", "/studio/spend");
  if (response.status !== 200) return reportApiError(out, "spend", response, jsonMode);
  if (jsonMode) {
    emitApiJson(out, response);
    return 0;
  }
  const summary = asObject(response.json);
  const total = asObject(summary?.total);
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  const formatUsd = (value: unknown) => typeof value === "number" ? `$${value.toFixed(6)}` : "unknown";
  out.log(
    `total estimated spend: ${formatUsd(total?.estimatedCostUsd)} ` +
      `(${String(total?.providerCalls ?? "unknown")} provider calls, ${String(total?.inputTokens ?? "unknown")} input tokens)`
  );
  const browserSeconds = Number(summary?.browserSessionSeconds ?? 0);
  out.log(`Browserbase usage: ${(browserSeconds / 60).toFixed(2)} session-minutes (${browserSeconds} seconds)`);
  for (const value of rows) {
    const row = asObject(value);
    if (!row) continue;
    out.log(
      `run=${String(row.runId)} at=${String(row.at)} providerCalls=${String(row.providerCalls)} ` +
        `inputTokens=${String(row.inputTokens)} estimatedCostUsd=${formatUsd(row.estimatedCostUsd)}`
    );
  }
  if (rows.length === 0) out.log("no provider spend recorded");
  return 0;
}

async function showRun(project: Project, out: Out, runId: string, events: boolean, jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, "GET", `/studio/runs/${encodeURIComponent(runId)}`);
  if (response.status !== 200) return reportApiError(out, "run", response, jsonMode);
  if (jsonMode) {
    emitApiJson(out, response);
    return 0;
  }
  const evidence = response.json as RunEvidence;
  out.log(`run ${evidence.run.id}  automation=${String(evidence.run.automationId ?? "")}  state=${evidence.run.state}`);
  printVerification(out, evidence.verification);
  printMetrics(out, evidence.run.metrics);
  if (evidence.run.failure?.reason) out.log(`failure: ${evidence.run.failure.reason}`);
  if (events) {
    for (const item of evidence.timeline ?? []) out.log(`${item.seq} ${item.at} ${item.event.type} ${JSON.stringify(item.event)}`);
  } else {
    out.log(`inspect the full timeline with \`pixie run ${runId} --events\``);
  }
  return 0;
}

async function cancelRun(project: Project, out: Out, runId: string, jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, "POST", `/studio/runs/${encodeURIComponent(runId)}/cancel`, {});
  if (response.status !== 202 && response.status !== 409) return reportApiError(out, "cancel", response, jsonMode);
  if (jsonMode) emitApiJson(out, response);
  else {
    const result = asObject(response.json);
    out.log(`cancel ${runId}: ${String(result?.ok === true ? "accepted" : result?.error ?? "not cancelled")}`);
  }
  return response.status === 202 ? 0 : 1;
}

async function latestRevision(project: Project, automationId: string): Promise<{ revision: number } | null> {
  const response = await clientRequest(project, "GET", "/v1/automations");
  if (response.status !== 200 || !Array.isArray(response.json)) return null;
  const automation = response.json.map(asObject).find((item) => item?.id === automationId);
  const revisions = automation && Array.isArray(automation.revisions) ? automation.revisions : [];
  const latest = revisions.at(-1);
  const revision = Number(asObject(latest)?.revision);
  return Number.isInteger(revision) && revision > 0 ? { revision } : null;
}

async function invoke(
  project: Project,
  out: Out,
  automationId: string,
  input: unknown,
  accountId: string,
  requestedRevision: string | undefined,
  idempotencyKey: string | undefined,
  follow: boolean,
  jsonMode: boolean
): Promise<number> {
  let revision: number;
  if (requestedRevision !== undefined) {
    revision = Number(requestedRevision);
    if (!Number.isInteger(revision) || revision < 1) {
      out.error("pixie invoke: --revision must be a positive integer");
      return 2;
    }
  } else {
    const latest = await latestRevision(project, automationId);
    if (!latest) {
      out.error(`pixie invoke: automation ${automationId} is not published or is unavailable to this client key`);
      return 1;
    }
    revision = latest.revision;
  }
  const headers: Record<string, string> = idempotencyKey ? { "idempotency-key": idempotencyKey } : {};
  const started = await clientRequest(
    project,
    "POST",
    `/v1/automations/${encodeURIComponent(automationId)}/runs`,
    { revision, accountId, input },
    headers
  );
  if (started.status !== 202 && started.status !== 200) return reportApiError(out, "invoke", started, jsonMode);
  const runId = String(asObject(started.json)?.id ?? "");
  if (!follow) {
    if (jsonMode) emitApiJson(out, started);
    else out.log(`run ${runId} ${started.status === 200 ? "reused" : "queued"} (state=${String(asObject(started.json)?.state ?? "unknown")})`);
    return 0;
  }
  const deadline = Date.now() + 120_000;
  let runStatus: ApiResponse = started;
  let run = asObject(started.json);
  while (!TERMINAL_RUN_STATES.has(String(run?.state)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    runStatus = await clientRequest(
      project,
      "GET",
      `/v1/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}`
    );
    if (runStatus.status !== 200) return reportApiError(out, "invoke", runStatus, jsonMode);
    run = asObject(runStatus.json);
  }
  if (!TERMINAL_RUN_STATES.has(String(run?.state))) {
    out.error(`pixie invoke: timed out waiting for run ${runId}`);
    return 1;
  }
  const result = await clientRequest(
    project,
    "GET",
    `/v1/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}/result`
  );
  if (jsonMode) {
    if (result.status === 200) emitApiJson(out, result);
    else return reportApiError(out, "invoke", result, true);
    return 0;
  }
  out.log(`run ${runId} ${started.status === 200 ? "reused" : "started"}; state=${String(run?.state)}`);
  printMetrics(out, asObject(runStatus.json)?.metrics);
  if (result.status !== 200) return reportApiError(out, "invoke", result, false);
  const value = asObject(result.json);
  const checks = Array.isArray(value?.checks) ? value.checks : [];
  const passed = checks.filter((item) => asObject(item)?.passed === true).length;
  out.log(`verification: ${value?.accepted === true ? "accepted" : "rejected"} (${passed}/${checks.length} checks passed)`);
  out.log(`data: ${JSON.stringify(value?.data ?? null)}`);
  return value?.accepted === true ? 0 : 1;
}

function outputDocument(out: Out, value: unknown, filename: string | undefined, jsonMode: boolean): void {
  if (filename) writeFileSync(resolve(filename), `${JSON.stringify(value, null, 2)}\n`);
  if (jsonMode) out.log(JSON.stringify(value));
  else if (filename) out.log(`wrote ${resolve(filename)}`);
  else emitObject(out, value);
}

async function documentRequest(
  project: Project,
  out: Out,
  command: "openapi" | "export",
  id: string,
  filename: string | undefined,
  jsonMode: boolean
): Promise<number> {
  const path = command === "openapi" ? `/studio/automations/${encodeURIComponent(id)}/openapi.json` : `/studio/automations/${encodeURIComponent(id)}/export`;
  const response = await studioRequest(project, "GET", path);
  if (response.status !== 200) return reportApiError(out, command, response, jsonMode);
  outputDocument(out, response.json, filename, jsonMode);
  return 0;
}

async function createKey(project: Project, out: Out, name: string, role: "client" | "developer", jsonMode: boolean): Promise<number> {
  const response = await studioRequest(project, "POST", "/studio/api-keys", { name, role });
  if (response.status !== 201) return reportApiError(out, "keys create", response, jsonMode);
  out.error("WARNING: this newly created API token is shown once. Copy it to a secure secret store; it cannot be retrieved later.");
  if (jsonMode) {
    emitApiJson(out, response);
    return 0;
  }
  const key = asObject(response.json);
  out.log(`created ${role} key ${String(key?.id ?? "")}`);
  if (typeof key?.token === "string") out.log(`token: ${key.token}`);
  return 0;
}

async function openStudio(project: Project, out: Out, id: string | undefined, jsonMode: boolean): Promise<number> {
  let url = project.studioUrl.replace(/\/+$/, "");
  if (id) {
    if (id.startsWith("auto-")) {
      const response = await studioRequest(project, "GET", `/studio/automations/${encodeURIComponent(id)}`);
      if (response.status !== 200) return reportApiError(out, "open", response, jsonMode);
      url += `/#/automations/${encodeURIComponent(id)}`;
    } else {
      const response = await studioRequest(project, "GET", `/studio/runs/${encodeURIComponent(id)}`);
      if (response.status !== 200) return reportApiError(out, "open", response, jsonMode);
      url += `/#/runs/${encodeURIComponent(id)}`;
    }
  }
  if (jsonMode) out.log(JSON.stringify({ url }));
  else out.log(url);
  const browser = process.env.BROWSER;
  if (browser) {
    const child = spawn(browser, [url], { detached: true, stdio: "ignore" });
    child.once("error", (error) => out.error(`pixie open: could not launch $BROWSER (${error.message})`));
    child.unref();
  }
  return 0;
}

// -- entry ------------------------------------------------------------------------------------------------

export async function main(argv: string[], out: Out = stdio): Promise<number> {
  interface CliOptions {
    account?: string;
    automation?: string;
    "allowed-origin"?: string[];
    events?: boolean;
    follow?: boolean;
    headless?: boolean;
    help?: boolean;
    id?: string;
    "idempotency-key"?: string;
    args?: string;
    "client-token-env"?: string;
    input?: string;
    json?: boolean;
    name?: string;
    origin?: string;
    output?: string;
    portal?: boolean;
    ref?: string;
    revision?: string;
    role?: string;
    scripted?: boolean;
    template?: string;
    url?: string;
    provider?: string;
    env?: string;
    environment?: string;
    repo?: string;
    method?: string;
    version?: string;
    engine?: string;
    source?: string;
    run?: string;
    model?: boolean;
    reason?: string;
    recording?: string;
  }
  let parsed: { values: CliOptions; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        account: { type: "string" },
        args: { type: "string" },
        automation: { type: "string" },
        "allowed-origin": { type: "string", multiple: true },
        events: { type: "boolean" },
        follow: { type: "boolean" },
        headless: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        id: { type: "string" },
        "idempotency-key": { type: "string" },
        "client-token-env": { type: "string" },
        input: { type: "string" },
        json: { type: "boolean" },
        name: { type: "string" },
        origin: { type: "string" },
        output: { type: "string", short: "o" },
        portal: { type: "boolean" },
        provider: { type: "string" },
        env: { type: "string" },
        environment: { type: "string" },
        repo: { type: "string" },
        method: { type: "string" },
        version: { type: "string" },
        engine: { type: "string" },
        source: { type: "string" },
        run: { type: "string" },
        model: { type: "boolean" },
        reason: { type: "string" },
        recording: { type: "string" },
        ref: { type: "string" },
        revision: { type: "string" },
        role: { type: "string" },
        scripted: { type: "boolean" },
        template: { type: "string" },
        url: { type: "string" }
      }
    }) as unknown as { values: CliOptions; positionals: string[] };
  } catch (error) {
    const command = argv.find((value) => !value.startsWith("-")) ?? "cli";
    out.error(`pixie ${command}: ${(error as Error).message}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, arg, subarg, third] = positionals;
  const jsonMode = values.json === true;
  if (values.help || !command) {
    out.log(HELP);
    return command ? 0 : 2;
  }
  let project: Project;
  try {
    project = loadProject();
  } catch (error) {
    out.error(`pixie ${command}: ${(error as Error).message}`);
    return 1;
  }
  const required = (value: string | undefined, usageText: string): value is string => {
    if (value) return true;
    out.error(`usage: ${usageText}`);
    return false;
  };
  try {
    switch (command) {
      case "init":
        if (!required(arg, "pixie init <directory>")) return 2;
        return init(arg, out, jsonMode);
      case "doctor":
        return doctor(project, out, jsonMode);
      case "dev":
        return dev(project, { scripted: values.scripted === true, headless: values.headless === true, portal: values.portal === true }, out);
      case "list":
        return list(project, out, jsonMode);
      case "accounts":
        if (!arg || arg === "list") return accountsList(project, out, jsonMode);
        if (arg === "add") {
          if (!values.name || !values.origin) return usage(out, "pixie accounts add --name <n> --origin <url> [--id <id>]");
          return accountAdd(project, out, values.name, values.origin, values.id, values.provider, values.environment, jsonMode);
        }
        if (arg === "secret") {
          if (!subarg || !values.ref) return usage(out, "pixie accounts secret <id> --ref <name> (reads value securely from stdin)");
          return accountSecret(project, out, subarg, values.ref, jsonMode);
        }
        return usage(out, "pixie accounts [list] | accounts add --name <n> --origin <url> [--id <id>] | accounts secret <id> --ref <name>");
      case "create": {
        if (!required(arg, "pixie create <name> --url <startUrl> [--template <name>] [--allowed-origin <origin>...]")) return 2;
        if (!values.url) return usage(out, "pixie create <name> --url <startUrl> [--template <name>] [--allowed-origin <origin>...]");
        const allowedOrigins = values["allowed-origin"] as string[] | undefined;
        return createAutomation(project, out, arg, values.url, values.template, allowedOrigins, jsonMode);
      }
      case "show":
        if (!required(arg, "pixie show <automationId>")) return 2;
        return showAutomation(project, out, arg, jsonMode);
      case "record":
        if (arg === "start" || arg === "status" || arg === "stop") {
          if (!required(subarg, `pixie record ${arg} <automationId>${arg === "start" ? " [--url <url>]" : ""}`)) return 2;
          return (await recordRequest(project, out, subarg, arg, values.url, jsonMode)).code;
        }
        if (!required(arg, "pixie record <automationId> | pixie record start|status|stop <automationId>")) return 2;
        return recordInteractive(project, out, arg, values.url, jsonMode);
      case "definition":
        if (arg === "get") {
          if (!required(subarg, "pixie definition get <automationId> [-o file]")) return 2;
          return definitionGet(project, out, subarg, values.output, jsonMode);
        }
        if (arg === "set") {
          if (!subarg || !third) return usage(out, "pixie definition set <automationId> <file>");
          return definitionSet(project, out, subarg, third, jsonMode);
        }
        return usage(out, "pixie definition get <automationId> [-o file] | pixie definition set <automationId> <file>");
      case "draft":
        if (!required(arg, "pixie draft <automationId>")) return 2;
        return draft(project, out, arg, jsonMode);
      case "test": {
        if (!required(arg, "pixie test <automationId> [--account <id>] [--input '<json>'] [--follow]")) return 2;
        let input: unknown = {};
        try {
          if (values.input) input = JSON.parse(values.input) as unknown;
        } catch (error) {
          out.error(`pixie test: --input must be valid JSON (${(error as Error).message})`);
          return 2;
        }
        return testRun(project, arg, values.account ?? project.accountId, input, out, values.follow === true, jsonMode, values.engine as string | undefined);
      }
      case "generate":
        if (!required(arg, "pixie generate <automationId> [--recording <file>]")) return 2;
        return generate(project, arg, values.recording, out, jsonMode);
      case "repair": {
        if (!required(arg, "pixie repair <automationId> --run <runId> [--source file | --model]")) return 2;
        let source: string | undefined;
        if (values.source) source = readFileSync(String(values.source), "utf8");
        return adapterRequest(project, "POST", `/studio/automations/${encodeURIComponent(arg)}/repairs`, { runId: values.run, source, model: values.model === true }, out, jsonMode);
      }
      case "repairs":
        if (!required(arg, "pixie repairs <automationId>")) return 2;
        return adapterRequest(project, "GET", `/studio/automations/${encodeURIComponent(arg)}/repairs`, {}, out, jsonMode);
      case "approve":
        if (!required(arg, "pixie approve <repairId>")) return 2;
        return adapterRequest(project, "POST", `/studio/repairs/${encodeURIComponent(arg)}/approve`, {}, out, jsonMode);
      case "reject":
        if (!required(arg, "pixie reject <repairId> --reason <text>")) return 2;
        return adapterRequest(project, "POST", `/studio/repairs/${encodeURIComponent(arg)}/reject`, { reason: values.reason }, out, jsonMode);
      case "rollback":
        if (!required(arg, "pixie rollback <automationId>")) return 2;
        return adapterRequest(project, "POST", `/studio/automations/${encodeURIComponent(arg)}/bindings/rollback`, {}, out, jsonMode);
      case "publish":
        if (!required(arg, "pixie publish <automationId>")) return 2;
        return publish(project, arg, out, jsonMode);
      case "models":
        return contractList(project, "models", undefined, out, jsonMode);
      case "repos":
        return contractList(project, "repositories", undefined, out, jsonMode);
      case "ops":
        return contractList(project, "operations", arg, out, jsonMode);
      case "diff":
        if (!required(arg, "pixie diff <automationId>")) return 2;
        return diffContract(project, arg, out, jsonMode);
      case "retire":
        if (!required(arg, "pixie retire <operationVersionId>")) return 2;
        return retireOperation(project, arg, out, jsonMode);
      case "runs":
        return runsList(project, out, values.automation, jsonMode);
      case "spend":
        return spend(project, out, jsonMode);
      case "connections":
        if (arg) return usage(out, "pixie connections");
        return connectionsList(project, out, jsonMode);
      case "connect":
        if (!required(arg, "pixie connect <accountId> [--env <environment>]")) return 2;
        return connectAccount(project, out, arg, values.env, jsonMode);
      case "disconnect":
        if (!required(arg, "pixie disconnect <connectionId>")) return 2;
        return disconnect(project, out, arg, jsonMode);
      case "run":
        if (!required(arg, "pixie run <runId> [--events]")) return 2;
        return showRun(project, out, arg, values.events === true, jsonMode);
      case "cancel":
        if (!required(arg, "pixie cancel <runId>")) return 2;
        return cancelRun(project, out, arg, jsonMode);
      case "invoke": {
        if (values.repo || values.method || values.version) {
          if (arg || !values.repo || !values.method || !values.version || values.input === undefined) {
            return usage(out, "pixie invoke --repo <r> --method <m> --version <major> --input '<json>' [--account <id>] [--follow]");
          }
          let contractInput: unknown;
          try { contractInput = JSON.parse(values.input) as unknown; } catch { return usage(out, "pixie invoke --input must be valid JSON"); }
          const version = Number(values.version);
          if (!Number.isInteger(version) || version < 1) return usage(out, "pixie invoke --version must be a positive integer");
          const started = await clientRequest(project, "POST", `/v1/repositories/${encodeURIComponent(values.repo)}/operations/${encodeURIComponent(values.method)}/runs`, {
            accountId: values.account ?? project.accountId, input: contractInput
          }, { "Pixie-Contract-Version": String(version), ...(values["idempotency-key"] ? { "idempotency-key": values["idempotency-key"] } : {}) });
          if (started.status !== 200 && started.status !== 202) return reportApiError(out, "invoke", started, jsonMode);
          if (!values.follow) { emitApiJson(out, started); return 0; }
          const runId = String(asObject(started.json)?.id ?? "");
          const basePath = `/v1/repositories/${encodeURIComponent(values.repo)}/operations/${encodeURIComponent(values.method)}/runs/${encodeURIComponent(runId)}`;
          const deadline = Date.now() + 120_000;
          let status = started;
          while (!TERMINAL_RUN_STATES.has(String(asObject(status.json)?.state)) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            status = await clientRequest(project, "GET", basePath);
          }
          const result = await clientRequest(project, "GET", `${basePath}/result`);
          if (result.status !== 200) return reportApiError(out, "invoke", result, jsonMode);
          if (jsonMode) emitApiJson(out, result);
          else out.log(JSON.stringify(result.json, null, 2));
          return 0;
        }
        if (!required(arg, "pixie invoke <automationId> --input '<json>' [--account <id>] [--revision <n>] [--idempotency-key <key>] [--follow]")) return 2;
        if (values.input === undefined) return usage(out, "pixie invoke <automationId> --input '<json>' [--account <id>] [--revision <n>] [--idempotency-key <key>] [--follow]");
        let input: unknown;
        try {
          input = JSON.parse(values.input) as unknown;
        } catch (error) {
          out.error(`pixie invoke: --input must be valid JSON (${(error as Error).message})`);
          return 2;
        }
        return invoke(
          project,
          out,
          arg,
          input,
          values.account ?? project.accountId,
          values.revision,
          values["idempotency-key"],
          values.follow === true,
          jsonMode
        );
      }
      case "openapi":
      case "export":
        if (!required(arg, `pixie ${command} <automationId> [-o file]`)) return 2;
        return documentRequest(project, out, command, arg, values.output, jsonMode);
      case "keys":
        if (arg !== "create") return usage(out, "pixie keys create <name> --role client|developer");
        if (positionals.length > 3) return usage(out, "pixie keys create <name> --role client|developer");
        if ((!subarg && !values.name) || (values.role !== "client" && values.role !== "developer")) {
          return usage(out, "pixie keys create <name> --role client|developer");
        }
        return createKey(project, out, subarg ?? values.name!, values.role, jsonMode);
      case "open":
        if (subarg) return usage(out, "pixie open [runId|automationId]");
        return openStudio(project, out, arg, jsonMode);
      case "mcp":
        if (arg === "config") return mcpConfig(project, values["client-token-env"] ?? "GATEWAY_CLIENT_TOKEN", out);
        if (arg === "call") return mcpCall(project, subarg ?? "", values.args, out);
        return usage(out, "pixie mcp config [--client-token-env NAME] | pixie mcp call <tool> --args '<json>'");
      default:
        out.error(`pixie ${command}: unknown command\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    out.error(`pixie ${command}: ${(error as Error).message}`);
    return 1;
  }
}

function usage(out: Out, text: string): number {
  out.error(`usage: ${text}`);
  return 2;
}
