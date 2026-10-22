import Fastify, { type FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { createApiKey } from "./auth.js";
import { now } from "./db.js";
import { RunManager, type RunManagerOptions } from "./runs.js";
import { registerStudioRoutes } from "./studio.js";
import { registerV1Routes } from "./v1.js";
import { registerMcpRoute } from "./mcp.js";
import { backfillPublishedContracts } from "./contracts.js";
import type { BrowserProvider, BrowserbaseProvider } from "./browser-provider.js";

export interface AppOptions extends Omit<RunManagerOptions, "db"> {
  db: DatabaseSync;
  browserProviders?: Partial<Record<"local" | "browserbase", BrowserProvider>>;
  browserbaseProvider?: BrowserbaseProvider;
  cdpUrl: (tenantId: string) => Promise<string>;
  /** Browser profiles currently launched (for diagnostics); tenant-scoped filtering happens in the route. */
  browserProfiles?: () => { name: string; cdpUrl: string; userDataDir: string }[];
  allowLoopback: boolean;
  publicBaseUrl: string;
  studioBaseUrl?: string;
  logger?: boolean;
}

export interface BootstrapTokens {
  developer: string;
  client: string;
  otherTenantClient: string;
}

/** Creates the demo tenants once. Tokens come from the environment for local use and are never logged. */
export function bootstrap(db: DatabaseSync, tokens: BootstrapTokens, portalOrigin: string) {
  const exists = db.prepare(`SELECT 1 FROM tenants WHERE id = 'tenant_demo'`).get();
  if (!exists) {
    db.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant_demo', 'Demo clinic group'), ('tenant_other', 'Unrelated tenant')`).run();
    createApiKey(db, "tenant_demo", "studio developer", "developer", tokens.developer);
    createApiKey(db, "tenant_demo", "demo client", "client", tokens.client);
    createApiKey(db, "tenant_other", "other client", "client", tokens.otherTenantClient);
    db.prepare(`INSERT INTO accounts (id, tenant_id, name, portal_origin, created_at) VALUES (?, ?, ?, ?, ?)`).run("acct_demo", "tenant_demo", "Synthetic portal account", portalOrigin, now());
    db.prepare(`INSERT INTO accounts (id, tenant_id, name, portal_origin, created_at) VALUES (?, ?, ?, ?, ?)`).run("acct_other", "tenant_other", "Other tenant account", portalOrigin, now());
  }
  backfillPublishedContracts(db);
}

export function buildApp(options: AppOptions): { app: FastifyInstance; runs: RunManager; shutdown: () => Promise<void> } {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_000_000 });
  const runs = new RunManager({
    db: options.db,
    runner: options.runner,
    evidenceRoot: options.evidenceRoot,
    selectEngine: options.selectEngine,
    browserProviders: options.browserProviders,
    scriptRunner: options.scriptRunner
  });
  app.get("/health", async () => ({ ok: true, time: now() }));
  const studio = registerStudioRoutes(app, {
    runs,
    cdpUrl: options.cdpUrl,
    browserProfiles: options.browserProfiles ?? (() => []),
    allowLoopback: options.allowLoopback,
    publicBaseUrl: options.publicBaseUrl,
    browserbaseProvider: options.browserbaseProvider
  });
  registerV1Routes(app, {
    runs,
    publicBaseUrl: options.publicBaseUrl,
    studioBaseUrl: options.studioBaseUrl,
    sendEvidenceFile: studio.sendEvidenceFile
  });
  registerMcpRoute(app, { runs, publicBaseUrl: options.publicBaseUrl, studioBaseUrl: options.studioBaseUrl ?? "http://127.0.0.1:5173" });
  return {
    app,
    runs,
    shutdown: async () => {
      await studio.stopAllRecordings();
      try {
        await options.browserbaseProvider?.sweepOrphans();
      } catch {
        console.error("Browserbase orphan sweep failed during shutdown");
      }
      await app.close();
    }
  };
}
