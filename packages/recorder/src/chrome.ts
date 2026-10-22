import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface ControlledChromeOptions {
  executable?: string;
  port?: number;
  /** Dedicated profile directory. One profile == one account; never a personal Chrome profile. */
  userDataDir: string;
  /** `visible` shows the window for demos; `headless` is the default for servers and CI. */
  mode?: "headless" | "visible";
  /** @deprecated use `mode`. */
  headless?: boolean;
}

export interface ControlledChrome {
  cdpUrl: string;
  /** null when re-attaching to the dedicated instance this profile already launched. */
  process: ChildProcess | null;
  executable: string;
  close(): Promise<void>;
}

const OWNER_FILE = "pixie-owner.json";

interface OwnerMarker {
  port: number;
  pid: number;
  startedAt: string;
}

const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
];
const LINUX_CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
const WINDOWS_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];

/** Resolves the Chrome executable: explicit option, GATEWAY_CHROME_PATH, then per-platform well-known locations. */
export function resolveChromeExecutable(explicit?: string, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string {
  const fromEnv = explicit ?? process.env.GATEWAY_CHROME_PATH;
  if (fromEnv) return fromEnv;
  const candidates = platform === "darwin" ? MAC_CANDIDATES : platform === "win32" ? WINDOWS_CANDIDATES : LINUX_CANDIDATES;
  if (platform === "linux") return LINUX_CANDIDATES[0]!;
  const found = candidates.find(exists);
  if (!found) throw new Error(`No Chrome found in ${candidates.join(", ")}; set GATEWAY_CHROME_PATH`);
  return found;
}

async function versionInfo(cdpUrl: string): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, string>;
  } catch {
    return null;
  }
}

function readOwner(userDataDir: string): OwnerMarker | null {
  try {
    return JSON.parse(readFileSync(join(userDataDir, OWNER_FILE), "utf8")) as OwnerMarker;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Chrome writes the port it actually bound into `<profile>/DevToolsActivePort`. */
function activePortOf(userDataDir: string): number | null {
  try {
    return Number(readFileSync(join(userDataDir, "DevToolsActivePort"), "utf8").split("\n")[0]);
  } catch {
    return null;
  }
}

/**
 * True only when the CDP endpoint on `port` was launched by us for exactly this profile: the profile's ownership
 * marker names the port, the recorded pid is alive, and Chrome's own DevToolsActivePort file agrees.
 */
export function ownsEndpoint(userDataDir: string, port: number): boolean {
  const owner = readOwner(userDataDir);
  return owner !== null && owner.port === port && processAlive(owner.pid) && activePortOf(userDataDir) === port;
}

/** The port of a still-running Chrome that this profile launched earlier, or null. */
export function ownedPort(userDataDir: string): number | null {
  const owner = readOwner(userDataDir);
  return owner !== null && ownsEndpoint(userDataDir, owner.port) ? owner.port : null;
}

export type EndpointHealth = "ready" | "recovered" | "unreachable";

/**
 * Chrome keeps serving `/json/version` after its last tab closes, but `/json/list` is empty and Playwright's
 * `connectOverCDP` then fails ("Browser context management is not supported"). For a browser we own, opening a
 * blank tab through the HTTP endpoint restores a usable default context without restarting Chrome.
 */
export async function ensurePageTarget(cdpUrl: string, fetchImpl: typeof fetch = fetch): Promise<EndpointHealth> {
  const list = async () => {
    const res = await fetchImpl(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`/json/list ${res.status}`);
    return (await res.json()) as { type?: string }[];
  };
  try {
    if ((await list()).some((t) => t.type === "page")) return "ready";
    const opened = await fetchImpl(`${cdpUrl}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(3000) });
    if (!opened.ok) throw new Error(`/json/new ${opened.status}`);
    return (await list()).some((t) => t.type === "page") ? "recovered" : "unreachable";
  } catch {
    return "unreachable";
  }
}

/** True when a CDP server answers on the port. */
export async function cdpPortInUse(port: number): Promise<boolean> {
  return (await versionInfo(`http://127.0.0.1:${port}`)) !== null;
}

/**
 * Launches a dedicated Chrome for one profile directory with a remote-debugging port, or re-attaches to the
 * instance this same profile launched earlier. A CDP server on the port that this profile does not own is
 * refused rather than reused, so runs can never be routed into another account's (or a developer's) browser.
 */
export async function launchControlledChrome(options: ControlledChromeOptions): Promise<ControlledChrome> {
  const port = options.port ?? 9333;
  const cdpUrl = `http://127.0.0.1:${port}`;
  const executable = resolveChromeExecutable(options.executable);
  mkdirSync(options.userDataDir, { recursive: true });
  const existing = await versionInfo(cdpUrl);
  if (existing) {
    if (ownsEndpoint(options.userDataDir, port)) {
      if ((await ensurePageTarget(cdpUrl)) === "unreachable") throw new Error(`Owned Chrome on ${cdpUrl} has no usable page target and could not open one`);
      return { cdpUrl, process: null, executable, close: async () => {} };
    }
    throw new Error(`Port ${port} already serves a CDP endpoint (${existing.Browser ?? "unknown"}) that profile ${options.userDataDir} does not own; refusing to attach`);
  }
  rmSync(join(options.userDataDir, OWNER_FILE), { force: true });
  const headless = options.mode ? options.mode === "headless" : options.headless ?? true;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${options.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--window-size=1200,860",
    "about:blank"
  ];
  if (headless) args.unshift("--headless=new");
  const child = spawn(executable, args, { stdio: "ignore", detached: false });
  child.on("error", () => {});
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Controlled Chrome (${executable}) exited with code ${child.exitCode}`);
    if (await versionInfo(cdpUrl)) break;
    await sleep(150);
  }
  if (!(await versionInfo(cdpUrl))) {
    child.kill("SIGKILL");
    throw new Error(`Controlled Chrome did not expose CDP on ${cdpUrl} within 20s`);
  }
  const marker: OwnerMarker = { port, pid: child.pid ?? -1, startedAt: new Date().toISOString() };
  writeFileSync(join(options.userDataDir, OWNER_FILE), JSON.stringify(marker));
  return {
    cdpUrl,
    process: child,
    executable,
    close: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const end = Date.now() + 5000;
        while (child.exitCode === null && Date.now() < end) await sleep(100);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      rmSync(join(options.userDataDir, OWNER_FILE), { force: true });
    }
  };
}
