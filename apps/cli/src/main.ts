import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveChromeExecutable } from "@gateway/recorder";

/** Root of the gateway checkout this CLI was built in; `pixie dev`/`doctor` operate on that checkout. */
export const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const ENGINE_REVISION = "1231850a0bf1a0c0341fe408ef1668dbbfdfac46";

export interface Project {
  apiUrl: string;
  studioUrl: string;
  portalOrigin: string;
  accountId: string;
  engine: "live" | "scripted";
}

const DEFAULT_PROJECT: Project = {
  apiUrl: "http://127.0.0.1:4180",
  studioUrl: "http://127.0.0.1:5173",
  portalOrigin: "https://todo.uiineed.com",
  accountId: "acct_todo",
  engine: "live"
};

const HELP = `pixie — local developer CLI for the Pixie gateway (runs from this checkout; there is no npm package)

  pixie init <directory>          create a Pixie project folder (pixie.json, .env.example); never overwrites
  pixie doctor                    check Node, uv/worker, Chrome, model variable, build and running services
  pixie dev [--scripted] [--headless] [--portal]
                                  start the API (+ dedicated browsers) and Studio from this checkout
  pixie list                      list this tenant's automations with state and published revisions
  pixie test <automationId> [--account <id>] [--input '<json>']
                                  run a Studio test run and print the verified result or failure
  pixie publish <automationId>    publish the tested definition as the next immutable revision

Not available as CLI commands (use Studio at the studioUrl instead): creating an automation, recording a
workflow in the dedicated browser, reviewing inputs/outputs/checkpoints. \`pixie test\`/\`publish\` act on an
automation you authored there.

Settings come from ./pixie.json (see \`pixie init\`) and the environment: GATEWAY_DEV_TOKEN (Studio token,
default dev-token-local), TYPESAFE_API_KEY (live Jev), GATEWAY_CHROME_PATH (Chrome location). Secrets are
read from the environment only and are never written by pixie.`;

type Out = { log: (line: string) => void; error: (line: string) => void };
const stdio: Out = { log: (l) => console.log(l), error: (l) => console.error(l) };

export function loadProject(cwd = process.cwd()): Project {
  const file = resolve(cwd, "pixie.json");
  if (!existsSync(file)) return DEFAULT_PROJECT;
  return { ...DEFAULT_PROJECT, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<Project>) };
}

// -- init -------------------------------------------------------------------------------------------------

export function init(directory: string, out: Out = stdio): number {
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
      "2. `pixie dev` — start the API and Studio from the gateway checkout.",
      "3. Author an automation in Studio (create → record → review), then `pixie test <id>` and `pixie publish <id>`.",
      "",
      `Settings live in pixie.json (account \`${DEFAULT_PROJECT.accountId}\`, portal ${DEFAULT_PROJECT.portalOrigin}); secrets only in your environment.`,
      ""
    ].join("\n")
  );
  out.log(`created Pixie project in ${target} (pixie.json, .env.example, .gitignore, README.md)`);
  return 0;
}

// -- doctor -----------------------------------------------------------------------------------------------

export interface Check {
  name: string;
  ok: boolean;
  level: "fail" | "warn";
  detail: string;
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

export async function doctor(project: Project, out: Out = stdio): Promise<number> {
  const checks = await doctorChecks(project);
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

// -- studio API commands ----------------------------------------------------------------------------------

async function studioRequest(project: Project, method: string, path: string, body?: unknown) {
  const token = process.env.GATEWAY_DEV_TOKEN ?? "dev-token-local";
  const res = await fetch(`${project.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  }).catch((error: Error) => {
    throw new Error(`cannot reach the API at ${project.apiUrl} (${error.message}); start it with \`pixie dev\``);
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}

interface RunView {
  id: string;
  state: string;
  failure?: { reason?: string } | null;
}

interface RunEvidence {
  run: RunView;
  verification: { accepted: boolean; checks: { id: string; passed: boolean; detail?: string }[]; reasons: string[] } | null;
  data: unknown;
  screenshots: unknown[];
}

export async function list(project: Project, out: Out = stdio): Promise<number> {
  const { status, json } = await studioRequest(project, "GET", "/studio/automations");
  if (status !== 200 || !Array.isArray(json)) {
    out.error(`list failed: HTTP ${status} ${JSON.stringify(json)}`);
    return 1;
  }
  for (const a of json as { id: string; name: string; state: string; revisions?: { revision: number }[] }[]) {
    out.log(`${a.id}  ${a.state.padEnd(11)}  revisions=${a.revisions?.length ?? 0}  ${a.name}`);
  }
  if (json.length === 0) out.log("no automations yet — create and record one in Studio");
  return 0;
}

export async function testRun(project: Project, automationId: string, accountId: string, input: unknown, out: Out = stdio): Promise<number> {
  const started = await studioRequest(project, "POST", `/studio/automations/${automationId}/test`, { accountId, input });
  if (started.status !== 202) {
    out.error(`test not started: HTTP ${started.status} ${JSON.stringify(started.json)}`);
    return 1;
  }
  const runId = (started.json as { id: string }).id;
  out.log(`test run ${runId} queued for account ${accountId}; waiting…`);
  const terminal = new Set(["completed", "needs_review", "failed", "awaiting_auth", "cancelled"]);
  let evidence: RunEvidence | null = null;
  while (!evidence || !terminal.has(evidence.run.state)) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll = await studioRequest(project, "GET", `/studio/runs/${runId}`);
    if (poll.status !== 200) {
      out.error(`lost the run: HTTP ${poll.status}`);
      return 1;
    }
    evidence = poll.json as unknown as RunEvidence;
  }
  const { run, verification } = evidence;
  out.log(`state: ${run.state}`);
  for (const c of verification?.checks ?? []) out.log(`  ${c.passed ? "pass" : "FAIL"}  ${c.id} ${c.detail ?? ""}`.trimEnd());
  if (run.state === "completed") out.log(`data: ${JSON.stringify(evidence.data)}`);
  if (run.failure?.reason) out.log(`failure: ${run.failure.reason}`);
  out.log(`evidence: ${evidence.screenshots.length} screenshot(s); inspect at ${project.studioUrl}/#/runs/${runId}`);
  return run.state === "completed" ? 0 : 1;
}

export async function publish(project: Project, automationId: string, out: Out = stdio): Promise<number> {
  const { status, json } = await studioRequest(project, "POST", `/studio/automations/${automationId}/publish`, {});
  if (status !== 201 || !json) {
    out.error(`publish refused: HTTP ${status} ${JSON.stringify(json)}`);
    return 1;
  }
  const { revision, checksum, openapiUrl } = json as { revision: number; checksum: string; openapiUrl: string };
  out.log(`published ${automationId} revision ${revision} (checksum ${checksum})`);
  out.log(`openapi: ${openapiUrl}`);
  out.log(`invoke as a client:\n  curl -X POST ${project.apiUrl}/v1/automations/${automationId}/runs -H "Authorization: Bearer $GATEWAY_CLIENT_TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" -d '{"revision":${revision},"accountId":"${project.accountId}","input":{}}'`);
  return 0;
}

// -- entry ------------------------------------------------------------------------------------------------

export async function main(argv: string[], out: Out = stdio): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      account: { type: "string" },
      input: { type: "string" },
      scripted: { type: "boolean", default: false },
      headless: { type: "boolean", default: false },
      portal: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false }
    }
  });
  const [command, arg] = positionals;
  if (values.help || !command) {
    out.log(HELP);
    return command ? 0 : 2;
  }
  const project = loadProject();
  try {
    switch (command) {
      case "init":
        if (!arg) return usage(out, "pixie init <directory>");
        return init(arg, out);
      case "doctor":
        return doctor(project, out);
      case "dev":
        return dev(project, { scripted: values.scripted, headless: values.headless, portal: values.portal }, out);
      case "list":
        return list(project, out);
      case "test":
        if (!arg) return usage(out, "pixie test <automationId> [--account <id>] [--input '<json>']");
        return testRun(project, arg, values.account ?? project.accountId, values.input ? JSON.parse(values.input) : {}, out);
      case "publish":
        if (!arg) return usage(out, "pixie publish <automationId>");
        return publish(project, arg, out);
      default:
        out.error(`unknown command '${command}'\n\n${HELP}`);
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
