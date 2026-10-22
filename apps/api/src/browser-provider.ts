import { randomUUID } from "node:crypto";
import type { BrowserPool } from "./browsers.js";

export type BrowserProviderName = "local" | "browserbase";

export interface BrowserSessionRequest {
  accountId: string;
  environment: string;
  contextId?: string;
  timeoutSeconds?: number;
  queueTimeoutMs?: number;
  runId?: string;
  connectionId?: string;
}

export interface BrowserSessionLease {
  id: string | null;
  cdpUrl: string;
  startedAt: number;
  release(): Promise<number>;
}

export interface BrowserProvider {
  readonly name: BrowserProviderName;
  acquireSession(request: BrowserSessionRequest): Promise<BrowserSessionLease>;
}

export class LocalBrowserProvider implements BrowserProvider {
  readonly name = "local" as const;

  constructor(private readonly pool: BrowserPool) {}

  async acquireSession(request: BrowserSessionRequest): Promise<BrowserSessionLease> {
    const cdpUrl = await this.pool.cdpUrlFor(request.accountId);
    return { id: null, cdpUrl, startedAt: Date.now(), release: async () => 0 };
  }
}

export interface BrowserbaseSession {
  id: string;
  status: string;
  contextId?: string;
  userMetadata?: Record<string, unknown>;
  connectUrl?: string;
  startedAt?: string;
  createdAt?: string;
}

type BrowserbaseOptions = {
  apiKey?: string;
  projectId?: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
  maxSessionSeconds?: number;
  releaseWaitMs?: number;
  pollIntervalMs?: number;
};

export class BrowserbaseProvider implements BrowserProvider {
  readonly name = "browserbase" as const;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxSessionSeconds: number;
  private readonly releaseWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly queues = new Map<string, { busy: boolean; waiters: { resolve: (release: () => void) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] }>();

  constructor(private readonly options: BrowserbaseOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://api.browserbase.com").replace(/\/+$/, "");
    this.maxSessionSeconds = options.maxSessionSeconds ?? parseSessionCap(process.env.PIXIE_MAX_SESSION_SECONDS);
    this.releaseWaitMs = options.releaseWaitMs ?? 10_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    if (!Number.isInteger(this.maxSessionSeconds) || this.maxSessionSeconds < 60 || this.maxSessionSeconds > 21600) {
      throw new Error("PIXIE_MAX_SESSION_SECONDS must be an integer between 60 and 21600");
    }
  }

  async createContext(name: string): Promise<string> {
    const response = await this.request<{ id: string }>("POST", "/v1/contexts", {
      name
    });
    if (!response.id) throw new Error("Browserbase returned no context id");
    return response.id;
  }

  async deleteContext(contextId: string): Promise<void> {
    await this.request<null>("DELETE", `/v1/contexts/${encodeURIComponent(contextId)}`);
  }

  async createSession(request: BrowserSessionRequest): Promise<BrowserbaseSession> {
    if (!request.contextId) throw new Error("Browserbase session requires a context");
    if (Boolean(request.runId) === Boolean(request.connectionId)) {
      throw new Error("Browserbase session requires exactly one runId or connectionId");
    }
    const response = await this.request<BrowserbaseSession>("POST", "/v1/sessions", {
      ...(this.options.projectId ? { projectId: this.options.projectId } : {}),
      browserSettings: { context: { id: request.contextId, persist: true } },
      keepAlive: true,
      timeout: Math.min(request.timeoutSeconds ?? this.maxSessionSeconds, this.maxSessionSeconds),
      userMetadata: { pixie: "1", ...(request.runId ? { runId: request.runId } : { connectionId: request.connectionId }) }
    });
    if (!response.id || !response.connectUrl) throw new Error("Browserbase returned an incomplete session");
    return response;
  }

  async getSession(id: string): Promise<BrowserbaseSession> {
    return this.request<BrowserbaseSession>("GET", `/v1/sessions/${encodeURIComponent(id)}`);
  }

  async releaseSession(id: string): Promise<void> {
    let requested = false;
    for (let attempt = 0; attempt < 2 && !requested; attempt += 1) {
      try {
        await this.request<unknown>("POST", `/v1/sessions/${encodeURIComponent(id)}`, { status: "REQUEST_RELEASE" });
        requested = true;
      } catch {
        if (attempt === 1) throw new Error("Browserbase session release request failed");
        await delay(this.pollIntervalMs);
      }
    }
    const deadline = Date.now() + this.releaseWaitMs;
    while (Date.now() < deadline) {
      const session = await this.getSession(id);
      if (!["PENDING", "RUNNING"].includes(session.status)) return;
      await delay(this.pollIntervalMs);
    }
    throw new Error("Browserbase session release was not confirmed before timeout");
  }

  async listRunningSessions(): Promise<BrowserbaseSession[]> {
    return this.request<BrowserbaseSession[]>("GET", "/v1/sessions?status=RUNNING");
  }

  async sweepOrphans(): Promise<number> {
    const sessions = await this.listRunningSessions();
    const tagged = sessions.filter((session) => session.userMetadata?.pixie === "1");
    const releases = await Promise.allSettled(tagged.map((session) => this.releaseSession(session.id)));
    if (releases.some((result) => result.status === "rejected")) throw new Error("one or more tagged Browserbase sessions could not be released");
    return tagged.length;
  }

  async acquireSession(request: BrowserSessionRequest): Promise<BrowserSessionLease> {
    if (!request.contextId) throw new Error("Browserbase session requires a connection context");
    const contextRelease = await this.acquireContext(request.contextId, request.queueTimeoutMs ?? this.maxSessionSeconds * 1000);
    let session: BrowserbaseSession;
    try {
      session = await this.createSession({ ...request, timeoutSeconds: request.timeoutSeconds ?? this.maxSessionSeconds });
    } catch (error) {
      contextRelease();
      throw error;
    }
    const cdpUrl = session.connectUrl!;
    const startedAt = Date.now();
    let released: Promise<number> | null = null;
    const timer = setTimeout(() => void lease.release().catch(() => undefined), this.maxSessionSeconds * 1000);
    timer.unref();
    const lease: BrowserSessionLease = {
      id: session.id,
      cdpUrl,
      startedAt,
      release: async () => {
        if (!released) {
          released = (async () => {
            clearTimeout(timer);
            await this.releaseSession(session.id);
            contextRelease();
            return Math.max(0, Math.ceil((Date.now() - startedAt) / 1000));
          })();
        }
        return released;
      }
    };
    return lease;
  }

  private async acquireContext(contextId: string, timeoutMs = this.maxSessionSeconds * 1000): Promise<() => void> {
    let queue = this.queues.get(contextId);
    if (!queue) {
      queue = { busy: false, waiters: [] };
      this.queues.set(contextId, queue);
    }
    if (!queue.busy) {
      queue.busy = true;
      return () => this.releaseContext(contextId);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          queue!.waiters = queue!.waiters.filter((item) => item !== waiter);
          reject(new Error("Browserbase context lease deadline exceeded"));
        }, timeoutMs)
      };
      waiter.timer.unref();
      queue!.waiters.push(waiter);
    });
  }

  private releaseContext(contextId: string): void {
    const queue = this.queues.get(contextId);
    if (!queue) return;
    const next = queue.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(() => this.releaseContext(contextId));
    } else {
      queue.busy = false;
      this.queues.delete(contextId);
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const apiKey = this.options.apiKey ?? process.env.BROWSERBASE_API_KEY;
    if (!apiKey) throw new Error("Browserbase requires BROWSERBASE_API_KEY");
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "X-BB-API-Key": apiKey,
        ...(body !== undefined ? { "content-type": "application/json" } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error(`Browserbase API returned HTTP ${response.status}`);
    if (response.status === 204) return null as T;
    return (await response.json()) as T;
  }
}

export function parseSessionCap(raw = process.env.PIXIE_MAX_SESSION_SECONDS): number {
  if (raw === undefined || raw === "") return 300;
  if (!/^\d+$/.test(raw)) throw new Error("PIXIE_MAX_SESSION_SECONDS must be an integer between 60 and 21600");
  const value = Number(raw);
  if (value < 60 || value > 21600) throw new Error("PIXIE_MAX_SESSION_SECONDS must be an integer between 60 and 21600");
  return value;
}

export function sessionLedgerId(): string {
  return randomUUID();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
