import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import {
  definitionChecksum,
  eligibilityOverviewDefinition,
  TODO_TEMPLATES,
  todoDefinition,
  type TodoTemplate,
  inputJsonSchema,
  newDefinition,
  outputJsonSchema,
  suggestFromRecording,
  validateDefinition,
  type AutomationDefinition
} from "@gateway/definition";
import { RecordingSession, type LiveInput, type RecordingResult } from "@gateway/recorder";
import { authenticate, createApiKey, requireRole } from "./auth.js";
import { now, type AutomationRow, type AutomationState, type RevisionRow, type RunRow } from "./db.js";
import { openApiDocument } from "./openapi.js";
import { buildReviewExport } from "./export.js";
import { ACCOUNT_ID_PATTERN, isValidAccountId } from "./browsers.js";
import type { RunManager } from "./runs.js";
import { generateAdapter, type RecordingInput } from "@gateway/adapter";
import {
  adapterSourceContainsSecret,
  executeRepairGates,
  estimateRepairInputTokens,
  FIREWORKS_MAX_CALLS,
  FIREWORKS_MAX_INPUT_TOKENS,
  FIREWORKS_REPAIR_PRICE_USD_PER_MILLION,
  requestModelRepair,
  sanitizeRepairText,
  sourceWithinAdapterScope
} from "./repair.js";
import { runEvidence, runView } from "./views.js";
import type { BrowserSessionLease, BrowserbaseProvider } from "./browser-provider.js";
import {
  contractTarget,
  listModels,
  listRepositories,
  listRepositoryOperations,
  persistContractPublication,
  prepareContractPublication,
  previewContract,
  retireOperation
} from "./contracts.js";
import {
  activatePublication,
  failPublicationActivation,
  recordActivationSmoke,
  stagePublicationActivation,
  storePublicationArtifact
} from "./publication.js";

export interface StudioContext {
  runs: RunManager;
  cdpUrl: (tenantId: string) => Promise<string>;
  browserProfiles: () => { name: string; cdpUrl: string; userDataDir: string }[];
  allowLoopback: boolean;
  publicBaseUrl: string;
  browserbaseProvider?: BrowserbaseProvider;
  fireworksApiKey?: string;
  fireworksEndpoint?: string;
}

const STATES: AutomationState[] = ["draft", "recording", "configuring", "testing", "ready", "published"];

export function registerStudioRoutes(app: FastifyInstance, ctx: StudioContext) {
  const db = ctx.runs.db;
  const recordings = new Map<string, RecordingSession>();
  const connectionSessions = new Map<string, { session: RecordingSession; lease: BrowserSessionLease; controllerKeyId: string }>();
  const stopConnection = async (id: string, ignoreReleaseError = false) => {
    const active = connectionSessions.get(id);
    if (!active) return;
    connectionSessions.delete(id);
    await active.session.stop().catch(() => undefined);
    let seconds: number;
    try {
      seconds = await active.lease.release();
    } catch (error) {
      if (!ignoreReleaseError) throw error;
      seconds = Math.max(0, Math.ceil((Date.now() - active.lease.startedAt) / 1000));
    }
    db.prepare(`INSERT INTO browser_session_ledger (id, connection_id, purpose, at, session_seconds) VALUES (?, ?, 'handoff', ?, ?)`)
      .run(randomUUID(), id, now(), seconds);
    db.prepare(`UPDATE connections SET last_session_seconds = ? WHERE id = ?`).run(seconds, id);
  };

  const automation = (id: string, tenantId: string) =>
    db.prepare(`SELECT * FROM automations WHERE id = ? AND tenant_id = ?`).get(id, tenantId) as unknown as AutomationRow | undefined;
  const setState = (id: string, state: AutomationState, patch: Partial<Pick<AutomationRow, "definition" | "recording_id" | "last_test_run_id">> = {}) => {
    const current = db.prepare(`SELECT * FROM automations WHERE id = ?`).get(id) as unknown as AutomationRow;
    db.prepare(`UPDATE automations SET state = ?, definition = ?, recording_id = ?, last_test_run_id = ?, updated_at = ? WHERE id = ?`).run(
      state,
      patch.definition ?? current.definition,
      patch.recording_id ?? current.recording_id,
      patch.last_test_run_id ?? current.last_test_run_id,
      now(),
      id
    );
  };
  const revisionsOf = (id: string) => db.prepare(`SELECT * FROM revisions WHERE automation_id = ? ORDER BY revision`).all(id) as unknown as RevisionRow[];
  const view = (row: AutomationRow) => {
    const definition = JSON.parse(row.definition) as AutomationDefinition;
    return {
      id: row.id,
      name: row.name,
      state: row.state,
      states: STATES,
      definition,
      recordingId: row.recording_id,
      lastTestRunId: row.last_test_run_id,
      inputSchema: inputJsonSchema(definition),
      outputSchema: outputJsonSchema(definition),
      revisions: revisionsOf(row.id).map((r) => ({ revision: r.revision, checksum: r.checksum, publishedAt: r.published_at, publishedBy: r.published_by, testRunId: r.test_run_id })),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  };

  app.register(async (studio) => {
    studio.addHook("preHandler", async (req, reply) => {
      if (req.url.startsWith("/studio/connections")) {
        const principal = authenticate(db, req);
        if (!principal) return reply.code(401).send({ error: "missing or invalid bearer token" });
        if (principal.role !== "developer") return reply.code(404).send({ error: "not found" });
        req.principal = principal;
        return;
      }
      return requireRole(db, "developer")(req, reply);
    });

    studio.get("/studio/me", async (req) => ({
      tenantId: req.principal.tenantId,
      name: req.principal.name,
      role: req.principal.role,
      publicApiUrl: ctx.publicBaseUrl
    }));

    // -- accounts and keys -------------------------------------------------------------------------------
    studio.get("/studio/accounts", async (req) => {
      const rows = db
        .prepare(`SELECT id, name, portal_origin AS portalOrigin, provider, environment, created_at AS createdAt FROM accounts WHERE tenant_id = ? ORDER BY created_at`)
        .all(req.principal.tenantId) as { id: string; name: string; portalOrigin: string; createdAt: string }[];
      const launched = new Map(ctx.browserProfiles().map((p) => [p.name, p]));
      // Where the account's browser state lives; only this tenant's own accounts are reported.
      return rows.map((row) => ({ ...row, browser: launched.has(row.id) ? { state: "running", userDataDir: launched.get(row.id)!.userDataDir } : { state: "not launched" } }));
    });
    studio.post<{ Body: { id?: string; name: string; portalOrigin: string; provider?: "local" | "browserbase"; environment?: string; authRequiredSignals?: unknown[] } }>("/studio/accounts", async (req, reply) => {
      const id = req.body.id ?? `acct_${randomUUID().slice(0, 8)}`;
      if (!isValidAccountId(id)) return reply.code(400).send({ error: "account id must match " + ACCOUNT_ID_PATTERN.source });
      if (db.prepare(`SELECT 1 FROM accounts WHERE id = ?`).get(id)) return reply.code(409).send({ error: "account id already exists" });
      const provider = req.body.provider ?? "local";
      if (!["local", "browserbase"].includes(provider)) return reply.code(400).send({ error: "provider must be local or browserbase" });
      const environment = req.body.environment ?? "local";
      db.prepare(`INSERT INTO accounts (id, tenant_id, name, portal_origin, provider, environment, auth_required_signals, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, req.principal.tenantId, req.body.name, req.body.portalOrigin, provider, environment, JSON.stringify(req.body.authRequiredSignals ?? []), now());
      return reply.code(201).send({ id, provider, environment });
    });
    studio.put<{ Params: { id: string }; Body: Record<string, string> }>("/studio/accounts/:id/secrets", async (req, reply) => {
      const account = db.prepare(`SELECT id FROM accounts WHERE id = ? AND tenant_id = ?`).get(req.params.id, req.principal.tenantId);
      if (!account) return reply.code(404).send({ error: "account not found" });
      for (const [ref, value] of Object.entries(req.body)) {
        db.prepare(`INSERT OR REPLACE INTO account_secrets (account_id, ref, value) VALUES (?, ?, ?)`).run(req.params.id, ref, value);
      }
      return { stored: Object.keys(req.body) };
    });
    studio.post<{ Body: { name: string; role?: "client" | "developer" } }>("/studio/api-keys", async (req, reply) => {
      const created = createApiKey(db, req.principal.tenantId, req.body.name, req.body.role ?? "client");
      return reply.code(201).send(created);
    });

    studio.get("/studio/connections", async (req) =>
      db.prepare(`SELECT c.id, c.account_id AS accountId, a.name AS accountName, c.environment, c.provider, c.state,
        c.context_status AS contextStatus, c.last_verified_at AS lastVerifiedAt
        FROM connections c JOIN accounts a ON a.id = c.account_id WHERE a.tenant_id = ? ORDER BY a.name, c.environment`).all(req.principal.tenantId)
    );
    studio.post<{ Body: { accountId: string; environment?: string } }>("/studio/connections", async (req, reply) => {
      const account = db.prepare(`SELECT id, provider, environment FROM accounts WHERE id = ? AND tenant_id = ?`)
        .get(req.body.accountId, req.principal.tenantId) as { id: string; provider: string; environment: string } | undefined;
      if (!account || account.provider !== "browserbase") return reply.code(404).send({ error: "browserbase account not found" });
      const environment = req.body.environment ?? account.environment;
      db.prepare(`INSERT OR IGNORE INTO connections (id, account_id, environment, provider, state) VALUES (?, ?, ?, 'browserbase', 'disconnected')`)
        .run(randomUUID(), account.id, environment);
      return reply.code(201).send(db.prepare(`SELECT id, account_id AS accountId, environment, provider, state FROM connections WHERE account_id = ? AND environment = ?`).get(account.id, environment));
    });
    studio.get<{ Params: { id: string } }>("/studio/connections/:id", async (req, reply) => {
      const row = db.prepare(`SELECT c.id, c.account_id AS accountId, a.name AS accountName, c.environment, c.provider, c.state,
        c.context_status AS contextStatus, c.last_verified_at AS lastVerifiedAt, c.controller_key_id AS controllerKeyId
        FROM connections c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND a.tenant_id = ?`)
        .get(req.params.id, req.principal.tenantId) as Record<string, unknown> | undefined;
      if (!row) return reply.code(404).send({ error: "not found" });
      const { controllerKeyId, ...safe } = row;
      return { ...safe, controller: controllerKeyId === req.principal.keyId };
    });
    studio.post<{ Params: { id: string } }>("/studio/connections/:id/connect", async (req, reply) => {
      if (!ctx.browserbaseProvider) return reply.code(503).send({ error: "browserbase provider is unavailable" });
      const row = db.prepare(`SELECT c.id, c.account_id, c.environment, c.context_id, a.portal_origin
        FROM connections c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND a.tenant_id = ?`)
        .get(req.params.id, req.principal.tenantId) as { id: string; account_id: string; environment: string; context_id: string | null; portal_origin: string } | undefined;
      if (!row) return reply.code(404).send({ error: "not found" });
      try {
        await stopConnection(row.id);
      } catch {
        return reply.code(502).send({ error: "previous browser session release was not confirmed" });
      }
      const contextId = row.context_id ?? await ctx.browserbaseProvider.createContext(`pixie-${row.account_id}-${row.environment}`);
      db.prepare(`UPDATE connections SET context_id = ?, state = 'connecting', controller_key_id = ?, context_status = 'active' WHERE id = ?`)
        .run(contextId, req.principal.keyId, row.id);
      let lease: BrowserSessionLease | undefined;
      try {
        lease = await ctx.browserbaseProvider.acquireSession({ accountId: row.account_id, environment: row.environment, contextId, connectionId: row.id });
        const origin = new URL(row.portal_origin).origin;
        const session = new RecordingSession({ cdpUrl: lease.cdpUrl, startUrl: origin, allowedOrigins: [origin], screencast: true });
        await session.start();
        connectionSessions.set(row.id, { session, lease, controllerKeyId: req.principal.keyId });
        return reply.code(201).send({ id: row.id, state: "connecting", controller: true });
      } catch {
        if (lease) {
          const seconds = await lease.release().catch(() => Math.max(0, Math.ceil((Date.now() - lease!.startedAt) / 1000)));
          db.prepare(`INSERT INTO browser_session_ledger (id, connection_id, purpose, at, session_seconds) VALUES (?, ?, 'handoff', ?, ?)`)
            .run(randomUUID(), row.id, now(), seconds);
        }
        db.prepare(`UPDATE connections SET state = 'disconnected', controller_key_id = NULL WHERE id = ?`).run(row.id);
        return reply.code(502).send({ error: "browser handoff could not be started" });
      }
    });
    studio.get<{ Params: { id: string } }>("/studio/connections/:id/frame", async (req, reply) => {
      const owned = db.prepare(`SELECT 1 FROM connections c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND a.tenant_id = ?`)
        .get(req.params.id, req.principal.tenantId);
      if (!owned) return reply.code(404).send({ error: "not found" });
      const frame = connectionSessions.get(req.params.id)?.session.frame();
      if (!frame) return reply.code(204).send();
      return reply.header("content-type", "image/jpeg").header("cache-control", "no-store").send(frame);
    });
    studio.post<{ Params: { id: string }; Body: LiveInput }>("/studio/connections/:id/input", async (req, reply) => {
      const owned = db.prepare(`SELECT controller_key_id FROM connections c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND a.tenant_id = ?`)
        .get(req.params.id, req.principal.tenantId) as { controller_key_id: string | null } | undefined;
      if (!owned) return reply.code(404).send({ error: "not found" });
      if (owned.controller_key_id !== req.principal.keyId) return reply.code(403).send({ error: "only the handoff controller may send input" });
      const session = connectionSessions.get(req.params.id)?.session;
      if (!session) return reply.code(409).send({ error: "no active handoff" });
      await session.input(req.body);
      return reply.code(204).send();
    });
    studio.post<{ Params: { id: string } }>("/studio/connections/:id/resume", async (req, reply) => {
      const connection = db.prepare(`SELECT c.id, c.account_id, c.environment, c.context_id, c.controller_key_id, a.portal_origin, a.auth_required_signals
        FROM connections c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND a.tenant_id = ?`)
        .get(req.params.id, req.principal.tenantId) as { id: string; account_id: string; environment: string; context_id: string | null; controller_key_id: string | null; portal_origin: string; auth_required_signals: string } | undefined;
      if (!connection || !connection.context_id || !ctx.browserbaseProvider) return reply.code(404).send({ error: "not found" });
      if (connection.controller_key_id !== req.principal.keyId) return reply.code(403).send({ error: "only the handoff controller may resume" });
      try {
        await stopConnection(connection.id);
      } catch {
        return reply.code(502).send({ error: "handoff session release was not confirmed" });
      }
      db.prepare(`UPDATE connections SET controller_key_id = NULL WHERE id = ?`).run(connection.id);
      const rawWait = Number(process.env.PIXIE_CONTEXT_SYNC_WAIT_MS ?? 5000);
      const syncWait = Number.isFinite(rawWait) ? Math.min(Math.max(rawWait, 0), 30_000) : 5000;
      await new Promise((resolve) => setTimeout(resolve, syncWait));
      let lease: BrowserSessionLease | undefined;
      let state: "connected" | "auth_required" = "auth_required";
      try {
        lease = await ctx.browserbaseProvider.acquireSession({
          accountId: connection.account_id, environment: connection.environment, contextId: connection.context_id, connectionId: connection.id
        });
        const origin = new URL(connection.portal_origin).origin;
        const check = new RecordingSession({ cdpUrl: lease.cdpUrl, startUrl: origin, allowedOrigins: [origin] });
        await check.start();
        const signals = JSON.parse(connection.auth_required_signals) as { kind: string; pattern?: string }[];
        if (!(await check.hasAuthRequiredSignal(signals))) state = "connected";
        await check.stop();
      } catch {
        return reply.code(502).send({ error: "connection verification could not be completed" });
      } finally {
        if (lease) {
          const seconds = await lease.release().catch(() => 0);
          db.prepare(`INSERT INTO browser_session_ledger (id, connection_id, purpose, at, session_seconds) VALUES (?, ?, 'verification', ?, ?)`)
            .run(randomUUID(), connection.id, now(), seconds);
        }
      }
      db.prepare(`UPDATE connections SET state = ?, last_verified_at = ?, controller_key_id = NULL WHERE id = ?`)
        .run(state, state === "connected" ? now() : null, connection.id);
      return { id: connection.id, state };
    });
    studio.post<{ Params: { id: string } }>("/studio/connections/:id/disconnect", async (req, reply) => {
      const row = db.prepare(`SELECT c.id, c.context_id FROM connections c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND a.tenant_id = ?`)
        .get(req.params.id, req.principal.tenantId) as { id: string; context_id: string | null } | undefined;
      if (!row) return reply.code(404).send({ error: "not found" });
      await stopConnection(row.id);
      let cleanup = "deleted";
      if (row.context_id && ctx.browserbaseProvider) {
        try { await ctx.browserbaseProvider.deleteContext(row.context_id); } catch { cleanup = "orphaned"; }
      } else if (row.context_id) {
        cleanup = "orphaned";
      }
      db.prepare(`UPDATE connections SET state = 'disconnected', context_id = ?, context_status = ?, controller_key_id = NULL WHERE id = ?`)
        .run(cleanup === "deleted" ? null : row.context_id, cleanup, row.id);
      return { id: row.id, state: "disconnected", contextCleanup: cleanup };
    });

    // -- automations -------------------------------------------------------------------------------------
    studio.get("/studio/automations", async (req) =>
      (db.prepare(`SELECT * FROM automations WHERE tenant_id = ? ORDER BY created_at`).all(req.principal.tenantId) as unknown as AutomationRow[]).map(view)
    );
    studio.post<{ Body: { name: string; startUrl: string; allowedOrigins?: string[]; template?: "eligibility-overview" | TodoTemplate } }>("/studio/automations", async (req, reply) => {
      const id = `auto-${randomUUID().slice(0, 8)}`;
      const origins = req.body.allowedOrigins ?? [new URL(req.body.startUrl).origin];
      const template = req.body.template;
      const definition =
        template === "eligibility-overview"
          ? { ...eligibilityOverviewDefinition(new URL(req.body.startUrl).origin), id, name: req.body.name, adapterGenerator: "template" as const }
          : template && (TODO_TEMPLATES as readonly string[]).includes(template)
            ? { ...todoDefinition(template as TodoTemplate, new URL(req.body.startUrl).origin), id, name: req.body.name, adapterGenerator: "template" as const }
            : { ...newDefinition({ id, name: req.body.name, startUrl: req.body.startUrl, allowedOrigins: origins }), adapterGenerator: "manual" as const };
      const check = validateDefinition(definition, { allowLoopback: ctx.allowLoopback });
      if (!check.ok) {
        const blocking = check.issues.filter((i) => ["startUrl", "allowedOrigins", ...origins.map((_, k) => `allowedOrigins[${k}]`)].includes(i.path));
        if (blocking.length) return reply.code(400).send({ error: "origin policy rejected this automation", issues: blocking });
      }
      db.prepare(`INSERT INTO automations (id, tenant_id, name, state, definition, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?)`).run(id, req.principal.tenantId, req.body.name, JSON.stringify(definition), now(), now());
      return reply.code(201).send(view(automation(id, req.principal.tenantId)!));
    });
    studio.get<{ Params: { id: string } }>("/studio/automations/:id", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      return row ? view(row) : reply.code(404).send({ error: "not found" });
    });

    // -- recording ---------------------------------------------------------------------------------------
    studio.post<{ Params: { id: string }; Body: { startUrl?: string } }>("/studio/automations/:id/recording/start", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.state === "published") return reply.code(409).send({ error: "published revisions are immutable; create a new automation to change the workflow" });
      if (recordings.has(row.id)) return reply.code(409).send({ error: "a recording is already active" });
      const definition = JSON.parse(row.definition) as AutomationDefinition;
      const startUrl = req.body?.startUrl ?? definition.startUrl;
      if (!definition.allowedOrigins.includes(new URL(startUrl).origin)) return reply.code(400).send({ error: "startUrl is outside the allowed origins" });
      const session = new RecordingSession({ cdpUrl: await ctx.cdpUrl(req.principal.tenantId), startUrl, allowedOrigins: definition.allowedOrigins, screencast: true });
      await session.start();
      recordings.set(row.id, session);
      setState(row.id, "recording");
      return reply.code(201).send(session.status());
    });
    studio.get<{ Params: { id: string } }>("/studio/automations/:id/recording/status", async (req, reply) => {
      const session = recordings.get(req.params.id);
      return session ? session.status() : reply.code(404).send({ error: "no active recording" });
    });
    studio.get<{ Params: { id: string } }>("/studio/automations/:id/recording/frame", async (req, reply) => {
      const session = recordings.get(req.params.id);
      const frame = session?.frame();
      if (!frame) return reply.code(204).send();
      return reply.header("content-type", "image/jpeg").header("cache-control", "no-store").send(frame);
    });
    studio.post<{ Params: { id: string }; Body: LiveInput }>("/studio/automations/:id/recording/input", async (req, reply) => {
      const session = recordings.get(req.params.id);
      if (!session) return reply.code(404).send({ error: "no active recording" });
      await session.input(req.body);
      return reply.code(204).send();
    });
    studio.post<{ Params: { id: string } }>("/studio/automations/:id/recording/stop", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      const session = recordings.get(req.params.id);
      if (!row || !session) return reply.code(404).send({ error: "no active recording" });
      const result: RecordingResult = await session.stop();
      recordings.delete(row.id);
      db.prepare(`INSERT INTO recordings (id, automation_id, started_at, stopped_at, events, warnings, action_count) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        result.id, row.id, result.startedAt, result.stoppedAt, JSON.stringify(result.events), JSON.stringify(result.warnings), result.actionCount
      );
      const definition = JSON.parse(row.definition) as AutomationDefinition;
      definition.sourceRecordingId = result.id;
      definition.adapterGenerator = "recorded";
      setState(row.id, "configuring", { definition: JSON.stringify(definition), recording_id: result.id });
      return recordingView(result.id);
    });
    studio.get<{ Params: { id: string } }>("/studio/automations/:id/recording", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row?.recording_id) return reply.code(404).send({ error: "no recording yet" });
      return recordingView(row.recording_id);
    });
    function recordingView(recordingId: string) {
      const rec = db.prepare(`SELECT * FROM recordings WHERE id = ?`).get(recordingId) as { id: string; started_at: string; stopped_at: string; events: string; warnings: string; action_count: number };
      const events = JSON.parse(rec.events) as RecordingResult["events"];
      return {
        id: rec.id,
        startedAt: rec.started_at,
        stoppedAt: rec.stopped_at,
        actionCount: rec.action_count,
        events,
        warnings: JSON.parse(rec.warnings) as RecordingResult["warnings"],
        suggestion: suggestFromRecording(events)
      };
    }

    // -- definition review -------------------------------------------------------------------------------
    studio.put<{ Params: { id: string }; Body: unknown }>("/studio/automations/:id/definition", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.state === "published") return reply.code(409).send({ error: "published revisions are immutable; create a new automation to change the workflow" });
      if (row.state === "recording") return reply.code(409).send({ error: "stop the recording first" });
      const candidate = { ...(req.body as object), id: row.id } as unknown;
      const check = validateDefinition(candidate, { allowLoopback: ctx.allowLoopback });
      if (!check.ok) return reply.code(400).send({ error: "definition rejected", issues: check.issues });
      const definition = { ...check.definition, sourceRecordingId: check.definition.sourceRecordingId ?? row.recording_id ?? undefined };
      setState(row.id, "configuring", { definition: JSON.stringify(definition), last_test_run_id: null });
      db.prepare(`UPDATE automations SET last_test_run_id = NULL WHERE id = ?`).run(row.id);
      return { ...view(automation(row.id, req.principal.tenantId)!), checksum: await definitionChecksum(definition) };
    });

    // -- test run ----------------------------------------------------------------------------------------
    studio.post<{ Params: { id: string }; Body: { accountId: string; input: unknown; engine?: "script" | "live" | "scripted" } }>("/studio/automations/:id/test", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      if (!["configuring", "testing", "ready"].includes(row.state)) return reply.code(409).send({ error: `cannot test in state ${row.state}` });
      const account = db.prepare(`SELECT id FROM accounts WHERE id = ? AND tenant_id = ?`).get(req.body.accountId, req.principal.tenantId);
      if (!account) return reply.code(403).send({ error: "account not found in this tenant" });
      const definition = JSON.parse(row.definition) as AutomationDefinition;
      const check = validateDefinition(definition, { allowLoopback: ctx.allowLoopback });
      if (!check.ok) return reply.code(400).send({ error: "definition is not complete", issues: check.issues });
      let adapterSource: string | null = null;
      if (req.body.engine === "script") {
        if (!row.recording_id) return reply.code(409).send({ error: "script testing requires a recording" });
        const recording = db.prepare(`SELECT events FROM recordings WHERE id = ?`).get(row.recording_id) as { events: string } | undefined;
        if (!recording) return reply.code(409).send({ error: "recording not found" });
        const generated = generateAdapter({ events: JSON.parse(recording.events) }, definition);
        if (generated.unsupported.length) return reply.code(422).send({ error: "recording contains unsupported steps", unsupported: generated.unsupported });
        adapterSource = generated.source;
      }
      const created = await ctx.runs.create({
        tenantId: req.principal.tenantId,
        automationId: row.id,
        revision: 0,
        definition,
        accountId: req.body.accountId,
        callerId: req.principal.keyId,
        kind: "test",
        input: req.body.input,
        ...(req.body.engine ? { engine: req.body.engine } : {}),
        ...(adapterSource ? { adapterSource } : {})
      });
      if (!created.ok) return reply.code(created.status).send({ error: created.error, details: created.details });
      setState(row.id, "testing", { last_test_run_id: created.run.id });
      void ctx.runs.waitForTerminal(created.run.id).then((run) => {
        const current = db.prepare(`SELECT * FROM automations WHERE id = ?`).get(row.id) as unknown as AutomationRow;
        if (current.last_test_run_id !== run.id || current.state !== "testing") return;
        setState(row.id, run.state === "completed" ? "ready" : "configuring");
      }).catch(() => setState(row.id, "configuring"));
      return reply.code(202).send(runView(created.run));
    });

    studio.get<{ Params: { id: string } }>("/studio/automations/:id/generated", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      if (!row.recording_id) return reply.code(404).send({ error: "no recording yet" });
      const recording = db.prepare(`SELECT events FROM recordings WHERE id = ?`).get(row.recording_id) as { events: string } | undefined;
      if (!recording) return reply.code(404).send({ error: "recording not found" });
      const generated = generateAdapter({ events: JSON.parse(recording.events) }, JSON.parse(row.definition) as AutomationDefinition);
      return generated;
    });
    studio.post<{ Params: { id: string }; Body: { recording: { events: unknown[]; warnings?: unknown[]; actionCount?: number } } }>("/studio/automations/:id/generated", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      const generated = generateAdapter(req.body.recording as RecordingInput, JSON.parse(row.definition) as AutomationDefinition);
      const id = randomUUID();
      db.prepare(`INSERT INTO recordings (id, automation_id, started_at, stopped_at, events, warnings, action_count) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, row.id, now(), now(), JSON.stringify(req.body.recording.events), JSON.stringify(req.body.recording.warnings ?? []), req.body.recording.actionCount ?? req.body.recording.events.length);
      setState(row.id, "configuring", { recording_id: id, last_test_run_id: null });
      return generated;
    });

    // -- contracts and publish --------------------------------------------------------------------------
    studio.get<{ Params: { id: string } }>("/studio/automations/:id/contract", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      const definition = JSON.parse(row.definition) as AutomationDefinition;
      return previewContract(db, req.principal.tenantId, definition);
    });
    studio.get("/studio/models", async (req) => listModels(db, req.principal.tenantId));
    studio.get<{ Querystring: { repo?: string } }>("/studio/repositories", async (req) =>
      req.query.repo
        ? listRepositories(db, req.principal.tenantId).filter((repository) => repository.name === req.query.repo)
        : listRepositories(db, req.principal.tenantId)
    );
    studio.get<{ Querystring: { repo?: string } }>("/studio/operations", async (req) =>
      listRepositoryOperations(db, req.principal.tenantId, req.query.repo)
    );
    studio.post<{ Params: { id: string } }>("/studio/operations/:id/retire", async (req, reply) => {
      const result = retireOperation(db, req.principal.tenantId, req.params.id, req.principal.name);
      if (!result) return reply.code(404).send({ error: "not found" });
      return { ...result, state: "retired" };
    });
    studio.post<{ Params: { id: string } }>("/studio/automations/:id/publish", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.state === "published") {
        db.prepare(`UPDATE publication_activations SET artifact_reused = 1
          WHERE id = (SELECT pa.id FROM publication_activations pa
            JOIN adapter_revisions ar ON ar.id = pa.adapter_revision_id
            WHERE ar.automation_id = ? AND pa.state = 'active'
              AND ar.automation_revision = (SELECT MAX(revision) FROM revisions WHERE automation_id = ?)
            ORDER BY pa.created_at DESC LIMIT 1)`)
          .run(row.id, row.id);
        const existing = db.prepare(`SELECT r.revision, r.checksum, ar.id AS adapterRevisionId,
            ar.revision AS adapterRevision, ov.id AS operationVersionId, ov.major, ov.minor,
            ov.model_version_id AS modelVersionId, repo.name AS repository, ov.method,
            pa.id AS activationId, pa.state AS activationState, pa.smoke_run_id AS smokeRunId,
            pa.artifact_hash AS artifactHash, artifact.size AS artifactSize
          FROM revisions r
          JOIN adapter_revisions ar ON ar.automation_id = r.automation_id AND ar.automation_revision = r.revision
          JOIN operation_versions ov ON ov.id = ar.operation_version_id
          JOIN repositories repo ON repo.id = ov.repository_id
          JOIN publication_activations pa ON pa.adapter_revision_id = ar.id AND pa.state = 'active'
          JOIN publication_artifacts artifact ON artifact.hash = pa.artifact_hash
          WHERE r.automation_id = ? AND r.revision = (SELECT MAX(revision) FROM revisions WHERE automation_id = ?)
          ORDER BY pa.created_at DESC LIMIT 1`).get(row.id, row.id) as {
          revision: number; checksum: string; adapterRevisionId: string; adapterRevision: number;
          operationVersionId: string; major: number; minor: number; modelVersionId: string;
          repository: string; method: string; activationId: string; activationState: string;
          smokeRunId: string | null; artifactHash: string; artifactSize: number;
        } | undefined;
        if (!existing) return reply.code(409).send({ error: "latest published revision has no successful activation" });
        return reply.code(201).send({
          automationId: row.id,
          revision: existing.revision,
          checksum: existing.checksum,
          openapiUrl: `${ctx.publicBaseUrl}/v1/automations/${row.id}/openapi.json`,
          compatibility: "adapter",
          repository: existing.repository,
          method: existing.method,
          modelVersion: { id: existing.modelVersionId, major: existing.major, minor: existing.minor },
          operationVersion: { id: existing.operationVersionId, major: existing.major, minor: existing.minor },
          adapterRevision: { id: existing.adapterRevisionId, revision: existing.adapterRevision },
          artifact: { hash: existing.artifactHash, size: existing.artifactSize, reused: true },
          activation: { id: existing.activationId, state: existing.activationState, smokeRunId: existing.smokeRunId }
        });
      }
      if (row.state !== "ready") return reply.code(409).send({ error: `only automations in state 'ready' can be published (current: ${row.state}); run a passing test first` });
      const test = row.last_test_run_id ? ctx.runs.get(row.last_test_run_id) : undefined;
      if (!test || test.state !== "completed") return reply.code(409).send({ error: "the latest test run did not complete with an accepted result" });
      const definition = JSON.parse(row.definition) as AutomationDefinition;
      let adapterSource: string | null = null;
      if (definition.adapterGenerator === "recorded" && row.recording_id) {
        const recording = db.prepare(`SELECT events FROM recordings WHERE id = ?`).get(row.recording_id) as { events: string } | undefined;
        if (recording) {
          const generated = generateAdapter({ events: JSON.parse(recording.events) }, definition);
          if (generated.unsupported.length) return reply.code(422).send({ error: "recording contains unsupported steps", unsupported: generated.unsupported });
          const metrics = test.metrics ? JSON.parse(test.metrics) as { engine?: string; adapterHash?: string } : {};
          if (!metrics.engine?.startsWith("script") || metrics.adapterHash !== generated.hash) return reply.code(409).send({ error: "script publication requires a passing test of the exact adapter hash" });
          adapterSource = generated.source;
        }
      }
      const checksum = await definitionChecksum(definition);
      const next = (db.prepare(`SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM revisions WHERE automation_id = ?`).get(row.id) as { n: number }).n;
      let contract;
      let artifact: ReturnType<typeof storePublicationArtifact>;
      let activationId = "";
      try {
        db.exec("BEGIN IMMEDIATE");
        const target = contractTarget(definition);
        db.prepare(`INSERT OR IGNORE INTO repositories (id, tenant_id, name) VALUES (?, ?, ?)`).run(randomUUID(), req.principal.tenantId, target.repository);
        const repository = db.prepare(`SELECT id FROM repositories WHERE tenant_id = ? AND name = ?`).get(req.principal.tenantId, target.repository) as { id: string };
        contract = prepareContractPublication(db, req.principal.tenantId, repository.id, row.id, next, definition, checksum, false, adapterSource);
        db.prepare(`INSERT INTO revisions (automation_id, revision, checksum, definition, published_at, published_by, test_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          row.id, next, checksum, JSON.stringify(definition), now(), req.principal.name, test.id
        );
        persistContractPublication(db, contract, { activateBinding: false });
        const operation = db.prepare(`SELECT model_version_id FROM operation_versions WHERE id = ?`)
          .get(contract.operationVersionId) as { model_version_id: string };
        artifact = storePublicationArtifact(db, {
          tenantId: req.principal.tenantId,
          adapterRevisionId: contract.adapter.id,
          source: adapterSource,
          definition,
          operationVersionId: contract.operationVersionId,
          modelVersionId: operation.model_version_id
        });
        activationId = stagePublicationActivation(db, {
          tenantId: req.principal.tenantId,
          repositoryId: contract.repositoryId,
          method: contract.method,
          major: contract.major,
          operationVersionId: contract.operationVersionId,
          adapterRevisionId: contract.adapter.id,
          artifactHash: artifact.hash,
          artifactReused: artifact.reused
        });
        setState(row.id, "published");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        const status = error instanceof Error && /keyFields|dependency|exceeds/.test(error.message) ? 422 : 500;
        return reply.code(status).send({ error: error instanceof Error ? error.message : "contract publication failed" });
      }
      const operation = db.prepare(`SELECT major, minor, model_version_id FROM operation_versions WHERE id = ?`)
        .get(contract.operationVersionId) as { major: number; minor: number; model_version_id: string };
      const testMetrics = test.metrics ? JSON.parse(test.metrics) as { engine?: string } : {};
      const smoke = await ctx.runs.create({
        tenantId: req.principal.tenantId,
        automationId: row.id,
        revision: next,
        definition,
        accountId: test.account_id,
        callerId: test.caller_id,
        kind: "test",
        input: JSON.parse(test.input),
        operationVersionId: contract.operationVersionId,
        adapterRevisionId: contract.adapter.id,
        engine: adapterSource ? "script" : testMetrics.engine?.includes("live") ? "live" : "scripted",
        ...(adapterSource ? { adapterSource } : {})
      });
      if (!smoke.ok) {
        failPublicationActivation(db, activationId, smoke.error);
        return reply.code(409).send({ error: "publication smoke test could not start", activationId, artifactHash: artifact.hash, activationState: "failed" });
      }
      recordActivationSmoke(db, activationId, smoke.run.id);
      const smokeResult = await ctx.runs.waitForTerminal(smoke.run.id);
      const activated = smokeResult.state === "completed" && activatePublication(db, activationId);
      if (!activated) {
        failPublicationActivation(db, activationId, "publication smoke test failed");
        return reply.code(409).send({
          error: "publication smoke test failed; the prior binding remains active",
          activationId,
          artifactHash: artifact.hash,
          activationState: "failed",
          smokeRunId: smoke.run.id
        });
      }
      return reply.code(201).send({
        automationId: row.id,
        revision: next,
        checksum,
        openapiUrl: `${ctx.publicBaseUrl}/v1/automations/${row.id}/openapi.json`,
        compatibility: contract.compatibility.level,
        changes: contract.compatibility.changes,
        repository: contract.repository,
        method: contract.method,
        modelVersion: { id: operation.model_version_id, major: operation.major, minor: operation.minor },
        operationVersion: { id: contract.operationVersionId, major: operation.major, minor: operation.minor },
        adapterRevision: { id: contract.adapter.id, revision: contract.adapter.revision },
        artifact: { hash: artifact.hash, size: artifact.size, reused: artifact.reused },
        activation: { id: activationId, state: "active", smokeRunId: smoke.run.id }
      });
    });
    studio.get<{ Params: { id: string } }>("/studio/automations/:id/publications", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      const activations = db.prepare(`SELECT pa.id, pa.state, pa.artifact_hash AS artifactHash,
          pa.smoke_run_id AS smokeRunId, pa.failure, pa.created_at AS createdAt, pa.updated_at AS updatedAt,
          pa.created_at AS stagedAt, pa.smoked_at AS smokedAt, pa.activated_at AS activatedAt,
          pa.method, pa.major, pa.adapter_revision_id AS adapterRevisionId,
          ar.revision AS adapterRevision, a.size AS artifactSize,
          pa.artifact_reused AS reused
        FROM publication_activations pa
        JOIN adapter_revisions ar ON ar.id = pa.adapter_revision_id
        JOIN publication_artifacts a ON a.hash = pa.artifact_hash
        WHERE pa.tenant_id = ? AND ar.automation_id = ?
        ORDER BY pa.created_at DESC`).all(req.principal.tenantId, row.id);
      return { activations, runtimeServiceId: process.env.PIXIE_RENDER_SERVICE_ID ?? null };
    });
    studio.get<{ Params: { id: string } }>("/studio/activations/:id", async (req, reply) => {
      const activation = db.prepare(`SELECT pa.id, pa.state, pa.failure, pa.smoke_run_id AS smokeRunId,
          pa.artifact_hash AS artifactHash, pa.created_at AS stagedAt, pa.smoked_at AS smokedAt,
          pa.activated_at AS activatedAt, pa.updated_at AS updatedAt, a.size AS artifactSize,
          pa.artifact_reused AS reused,
          pa.method, pa.major
        FROM publication_activations pa
        JOIN publication_artifacts a ON a.hash = pa.artifact_hash
        WHERE pa.id = ? AND pa.tenant_id = ?`)
        .get(req.params.id, req.principal.tenantId) as Record<string, unknown> | undefined;
      if (!activation) return reply.code(404).send({ error: "not found" });
      return activation;
    });
    studio.post<{ Params: { id: string }; Body: { runId: string; source?: string; model?: boolean } }>("/studio/automations/:id/repairs", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      const run = req.body?.runId ? ctx.runs.get(req.body.runId) : undefined;
      if (!row || !run || run.tenant_id !== req.principal.tenantId || run.automation_id !== row.id) return reply.code(404).send({ error: "not found" });
      if (!["failed", "needs_review"].includes(run.state)) return reply.code(409).send({ error: "repair requires a failed run" });
      let source = req.body.source;
      let generator: "manual" | "model" = "manual";
      let modelSpend = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
      if (req.body.model) {
        if (source || !ctx.fireworksApiKey) return reply.code(400).send({ error: "model repair requires FIREWORKS_API_KEY and no manual source" });
        const active = run.adapter_revision_id
          ? db.prepare(`SELECT current.source FROM adapter_revisions failed
            JOIN publication_bindings pb ON pb.operation_version_id = failed.operation_version_id
            JOIN adapter_revisions current ON current.id = pb.adapter_revision_id
            WHERE failed.id = ?`).get(run.adapter_revision_id) as { source: string | null } | undefined
          : db.prepare(`SELECT ar.source FROM adapter_revisions ar
            JOIN publication_bindings pb ON pb.adapter_revision_id = ar.id
            WHERE ar.automation_id = ? ORDER BY ar.revision DESC LIMIT 1`).get(row.id) as { source: string | null } | undefined;
        const failureEvents = db.prepare(`SELECT event FROM run_events WHERE run_id = ? ORDER BY seq`).all(run.id) as { event: string }[];
        const inputValues = Object.values(JSON.parse(run.input) as Record<string, unknown>).filter((value): value is string => typeof value === "string");
        if (inputValues.some((value) => value.length >= 3 && active?.source?.includes(value))) {
          return reply.code(409).send({ error: "active adapter source contains caller input and cannot be sent to the repair model" });
        }
        const safeEvents = failureEvents.map(({ event }) => JSON.parse(event) as Record<string, unknown>)
          .filter((event) => ["policy_rejected", "script_failure", "action"].includes(String(event.type)))
          .map((event) => ({
            type: event.type,
            reason: typeof event.reason === "string" ? sanitizeRepairText(event.reason, inputValues) : undefined,
            checkpointId: event.checkpointId
          }));
        const rawDomExcerpt = failureEvents.map(({ event }) => JSON.parse(event) as { type?: string; domExcerpt?: string })
          .find((event) => event.type === "script_failure")?.domExcerpt ?? "";
        const domExcerpt = sanitizeRepairText(rawDomExcerpt, inputValues);
        if (!active?.source) return reply.code(409).send({ error: "no active adapter source to repair" });
        if (adapterSourceContainsSecret(active.source)) return reply.code(409).send({ error: "active adapter source contains a value that cannot be sent to the repair model" });
        const estimatedTokens = estimateRepairInputTokens(active.source, safeEvents, domExcerpt);
        db.exec("BEGIN IMMEDIATE");
        const current = db.prepare(`SELECT calls, input_tokens AS tokens FROM repair_model_usage WHERE run_id = ?`).get(run.id) as { calls: number; tokens: number } | undefined ?? { calls: 0, tokens: 0 };
        if (current.calls >= FIREWORKS_MAX_CALLS || current.tokens + estimatedTokens > FIREWORKS_MAX_INPUT_TOKENS) {
          db.exec("ROLLBACK");
          return reply.code(429).send({ error: "Fireworks repair budget exhausted" });
        }
        db.prepare(`INSERT INTO repair_model_usage (run_id, calls, input_tokens) VALUES (?, 1, ?) ON CONFLICT(run_id) DO UPDATE SET calls = calls + 1, input_tokens = input_tokens + excluded.input_tokens`).run(run.id, estimatedTokens);
        const estimatedInputCost = estimatedTokens * FIREWORKS_REPAIR_PRICE_USD_PER_MILLION.input / 1_000_000;
        db.prepare(`INSERT INTO spend_ledger (run_id, at, provider_calls, input_tokens, output_tokens, estimated_cost_usd) VALUES (?, ?, 1, ?, 0, ?) ON CONFLICT(run_id) DO UPDATE SET provider_calls = provider_calls + 1, input_tokens = input_tokens + excluded.input_tokens, estimated_cost_usd = estimated_cost_usd + excluded.estimated_cost_usd`)
          .run(run.id, now(), estimatedTokens, estimatedInputCost);
        db.exec("COMMIT");
        try {
          const repaired = await requestModelRepair({
            source: active.source, failureEvents: safeEvents, domExcerpt, apiKey: ctx.fireworksApiKey,
            ...(ctx.fireworksEndpoint ? { endpoint: ctx.fireworksEndpoint } : {}),
            priorCalls: current.calls, priorInputTokens: current.tokens,
            onUsage: (usage) => {
              db.prepare(`UPDATE spend_ledger SET input_tokens = input_tokens - ? + ?, output_tokens = output_tokens + ?, estimated_cost_usd = estimated_cost_usd - ? + ? WHERE run_id = ?`)
                .run(estimatedTokens, usage.inputTokens, usage.outputTokens, estimatedInputCost, usage.estimatedCostUsd, run.id);
              db.prepare(`UPDATE repair_model_usage SET input_tokens = input_tokens - ? + ?, output_tokens = output_tokens + ?, estimated_cost_usd = estimated_cost_usd + ? WHERE run_id = ?`)
                .run(estimatedTokens, usage.inputTokens, usage.outputTokens, usage.estimatedCostUsd, run.id);
              modelSpend = usage;
            }
          });
          source = repaired.source;
          generator = "model";
        } catch (error) {
          return reply.code(502).send({ error: error instanceof Error ? error.message : "model repair failed" });
        }
      }
      if (!source) return reply.code(400).send({ error: "repair source is required" });
      if (!sourceWithinAdapterScope(source)) return reply.code(422).send({ error: "repair candidate may change adapter source only" });
      const id = randomUUID();
      const hash = await definitionChecksum({ ...JSON.parse(row.definition), source });
      let repairCdpUrl = "";
      try { repairCdpUrl = await ctx.cdpUrl(run.tenant_id); } catch { repairCdpUrl = ""; }
      const gates = await executeRepairGates({ source, definition: JSON.parse(row.definition) as AutomationDefinition, run, cdpUrl: repairCdpUrl });
      const passed = gates.every((gate) => gate.passed);
      const state = passed ? "awaiting_approval" : "gates_failed";
      db.prepare(`INSERT INTO repair_candidates (id, tenant_id, automation_id, run_id, source, source_hash, generator, state, validation, gate_results, gate_logs, model_calls, input_tokens, output_tokens, estimated_cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, req.principal.tenantId, row.id, run.id, source, hash, generator, state, JSON.stringify({ accepted: passed }), JSON.stringify(gates.map(({ name, passed }) => ({ name, passed }))), JSON.stringify(Object.fromEntries(gates.map(({ name, log }) => [name, log]))), generator === "model" ? 1 : 0, modelSpend.inputTokens, modelSpend.outputTokens, modelSpend.estimatedCostUsd, now());
      const seq = (db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM run_events WHERE run_id = ?`).get(run.id) as { n: number }).n;
      db.prepare(`INSERT INTO run_events (run_id, seq, at, event) VALUES (?, ?, ?, ?)`)
        .run(run.id, seq, now(), JSON.stringify({ type: "repair_candidate_created", repairId: id, generator, state, gates: gates.map(({ name, passed }) => ({ name, passed })) }));
      return reply.code(201).send({ id, state, sourceHash: hash, gates });
    });
    studio.get<{ Params: { id: string } }>("/studio/automations/:id/repairs", async (req) => {
      return db.prepare(`SELECT rc.id, rc.run_id AS runId, rc.source, rc.source_hash AS sourceHash, rc.generator, rc.state, rc.validation, rc.gate_results AS gateResults, rc.gate_logs AS gateLogs, rc.rejection_reason AS rejectionReason, rc.created_at AS createdAt, rc.approved_at AS approvedAt, (SELECT ar.source FROM adapter_revisions ar WHERE ar.automation_id = rc.automation_id ORDER BY ar.revision DESC LIMIT 1) AS activeSource FROM repair_candidates rc WHERE rc.automation_id = ? AND rc.tenant_id = ? ORDER BY rc.created_at DESC`).all(req.params.id, req.principal.tenantId);
    });
    studio.post<{ Params: { id: string } }>("/studio/repairs/:id/approve", async (req, reply) => {
      const candidate = db.prepare(`SELECT * FROM repair_candidates WHERE id = ? AND tenant_id = ?`).get(req.params.id, req.principal.tenantId) as { id: string; automation_id: string; run_id: string; source: string; source_hash: string; state: string; gate_results: string } | undefined;
      if (!candidate) return reply.code(404).send({ error: "not found" });
      if (candidate.state === "gates_failed" || candidate.state !== "awaiting_approval" || !(JSON.parse(candidate.gate_results) as { passed: boolean }[]).every((gate) => gate.passed)) return reply.code(409).send({ error: "repair gates have not all passed" });
      const row = automation(candidate.automation_id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      const runAdapter = db.prepare(`SELECT adapter_revision_id FROM runs WHERE id = ?`).get(candidate.run_id) as { adapter_revision_id: string | null } | undefined;
      const active = runAdapter?.adapter_revision_id
        ? db.prepare(`SELECT ar.*, ov.repository_id, ov.method, ov.major FROM adapter_revisions original
          JOIN publication_bindings pb ON pb.operation_version_id = original.operation_version_id
          JOIN adapter_revisions ar ON ar.id = pb.adapter_revision_id
          JOIN operation_versions ov ON ov.id = ar.operation_version_id
          WHERE original.id = ?`).get(runAdapter.adapter_revision_id)
        : db.prepare(`SELECT ar.*, ov.repository_id, ov.method, ov.major FROM adapter_revisions ar
          JOIN operation_versions ov ON ov.id = ar.operation_version_id
          WHERE ar.automation_id = ? AND EXISTS (SELECT 1 FROM publication_bindings pb WHERE pb.adapter_revision_id = ar.id)
          ORDER BY ov.major DESC, ov.minor DESC, ar.revision DESC LIMIT 1`).get(row.id);
      const activeAdapter = active as { id: string; operation_version_id: string; revision: number; automation_revision: number; definition_hash: string; engine: string; engine_revision: string; repository_id: string; method: string; major: number } | undefined;
      if (!activeAdapter) return reply.code(409).send({ error: "no published adapter to repair" });
      const adapterId = randomUUID();
      const adapterContent = { id: adapterId, operation_version_id: activeAdapter.operation_version_id, revision: activeAdapter.revision + 1, definition_hash: activeAdapter.definition_hash, engine: "script", engine_revision: "repair", generator: "manual", source: candidate.source };
      const adapterHash = await definitionChecksum(adapterContent as never);
      db.prepare(`INSERT INTO adapter_revisions (id, operation_version_id, revision, definition_hash, engine, engine_revision, generator, source, automation_id, automation_revision, hash) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`)
        .run(adapterId, activeAdapter.operation_version_id, activeAdapter.revision + 1, activeAdapter.definition_hash, "script", "repair", candidate.source, row.id, activeAdapter.automation_revision, adapterHash);
      db.prepare(`UPDATE publication_bindings SET adapter_revision_id = ? WHERE repository_id = ? AND method = ? AND major = ?`).run(adapterId, activeAdapter.repository_id, activeAdapter.method, activeAdapter.major);
      const revision = activeAdapter.revision + 1;
      db.prepare(`UPDATE repair_candidates SET state = 'approved', approved_at = ? WHERE id = ?`).run(now(), candidate.id);
      return { id: candidate.id, state: "approved", revision };
    });
    studio.post<{ Params: { id: string } }>("/studio/automations/:id/bindings/rollback", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      const binding = db.prepare(`SELECT pb.repository_id, pb.method, pb.major, pb.operation_version_id, ar.revision FROM publication_bindings pb JOIN adapter_revisions ar ON ar.id = pb.adapter_revision_id WHERE ar.automation_id = ?`).get(row.id) as { repository_id: string; method: string; major: number; operation_version_id: string; revision: number } | undefined;
      if (!binding || binding.revision <= 1) return reply.code(409).send({ error: "no previous adapter revision" });
      const previous = db.prepare(`SELECT id FROM adapter_revisions WHERE operation_version_id = ? AND revision = ?`).get(binding.operation_version_id, binding.revision - 1) as { id: string } | undefined;
      if (!previous) return reply.code(409).send({ error: "no previous adapter revision" });
      db.prepare(`UPDATE publication_bindings SET adapter_revision_id = ? WHERE repository_id = ? AND method = ? AND major = ?`).run(previous.id, binding.repository_id, binding.method, binding.major);
      return { state: "rolled_back", adapterRevisionId: previous.id };
    });
    studio.post<{ Params: { id: string }; Body: { reason?: string } }>("/studio/repairs/:id/reject", async (req, reply) => {
      const changed = db.prepare(`UPDATE repair_candidates SET state = 'rejected', rejection_reason = ? WHERE id = ? AND tenant_id = ?`).run(req.body?.reason ?? "rejected by developer", req.params.id, req.principal.tenantId);
      if (!changed) return reply.code(404).send({ error: "not found" });
      return { id: req.params.id, state: "rejected" };
    });
    studio.post<{ Params: { id: string } }>("/studio/automations/:id/new-draft", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.state !== "published") return reply.code(409).send({ error: "only published automations can be forked into a new draft" });
      const id = `auto-${randomUUID().slice(0, 8)}`;
      const source = JSON.parse(row.definition) as AutomationDefinition;
      const target = contractTarget(source);
      const name = `${row.name.replace(/(?: \(draft\))+$/, "")} (draft)`;
      const definition = { ...source, id, name, repository: target.repository, method: target.method };
      db.prepare(`INSERT INTO automations (id, tenant_id, name, state, definition, recording_id, created_at, updated_at) VALUES (?, ?, ?, 'configuring', ?, ?, ?, ?)`).run(
        id, req.principal.tenantId, definition.name, JSON.stringify(definition), row.recording_id, now(), now()
      );
      return reply.code(201).send(view(automation(id, req.principal.tenantId)!));
    });
    studio.get<{ Params: { id: string } }>("/studio/automations/:id/openapi.json", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      return openApiDocument(row.id, row.name, revisionsOf(row.id), ctx.publicBaseUrl);
    });

    // -- runs and evidence -------------------------------------------------------------------------------
    studio.get<{ Querystring: { automationId?: string } }>("/studio/runs", async (req) => {
      const rows = req.query.automationId
        ? (db.prepare(`SELECT * FROM runs WHERE tenant_id = ? AND automation_id = ? ORDER BY created_at DESC LIMIT 100`).all(req.principal.tenantId, req.query.automationId) as unknown as RunRow[])
        : (db.prepare(`SELECT * FROM runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`).all(req.principal.tenantId) as unknown as RunRow[]);
      return rows.map(runView);
    });
    studio.get("/studio/spend", async (req) => {
      const rows = db
        .prepare(
          `SELECT spend_ledger.run_id AS runId, spend_ledger.at, spend_ledger.provider_calls AS providerCalls,
             spend_ledger.input_tokens AS inputTokens, spend_ledger.estimated_cost_usd AS estimatedCostUsd
           FROM spend_ledger JOIN runs ON runs.id = spend_ledger.run_id
           WHERE runs.tenant_id = ? ORDER BY spend_ledger.at DESC`
        )
        .all(req.principal.tenantId) as { runId: string; at: string; providerCalls: number; inputTokens: number; estimatedCostUsd: number }[];
      const browserSessionSeconds = (db.prepare(`SELECT COALESCE(SUM(bsl.session_seconds), 0) AS seconds
        FROM browser_session_ledger bsl
        LEFT JOIN runs r ON r.id = bsl.run_id
        LEFT JOIN connections c ON c.id = bsl.connection_id
        LEFT JOIN accounts a ON a.id = c.account_id
        WHERE (r.tenant_id = ? OR a.tenant_id = ?)`).get(req.principal.tenantId, req.principal.tenantId) as { seconds: number }).seconds;
      return {
        rows,
        browserSessionSeconds,
        total: {
          providerCalls: rows.reduce((sum, row) => sum + row.providerCalls, 0),
          inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
          estimatedCostUsd: Number(rows.reduce((sum, row) => sum + row.estimatedCostUsd, 0).toFixed(6))
        }
      };
    });
    studio.get<{ Params: { runId: string } }>("/studio/runs/:runId", async (req, reply) => {
      const run = ctx.runs.get(req.params.runId);
      if (!run || run.tenant_id !== req.principal.tenantId) return reply.code(404).send({ error: "not found" });
      return runEvidence(db, ctx.runs, run, `/studio/runs/${run.id}/evidence`);
    });
    studio.get<{ Params: { runId: string; name: string } }>("/studio/runs/:runId/evidence/:name", async (req, reply) => {
      const run = ctx.runs.get(req.params.runId);
      if (!run || run.tenant_id !== req.principal.tenantId) return reply.code(404).send({ error: "not found" });
      return sendEvidenceFile(run.id, req.params.name, reply);
    });
    studio.post<{ Params: { runId: string } }>("/studio/runs/:runId/cancel", async (req, reply) => {
      const run = ctx.runs.get(req.params.runId);
      if (!run || run.tenant_id !== req.principal.tenantId) return reply.code(404).send({ error: "not found" });
      const result = ctx.runs.cancel(run.id);
      return reply.code(result.ok ? 202 : 409).send(result);
    });

    // -- review export (A14) -----------------------------------------------------------------------------
    studio.get<{ Params: { id: string } }>("/studio/automations/:id/export", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      const revisions = revisionsOf(row.id);
      if (!revisions.length) return reply.code(409).send({ error: "nothing to export: publish a revision first (drafts are not reviewable artifacts)" });
      const runs = db.prepare(`SELECT * FROM runs WHERE automation_id = ? AND tenant_id = ? ORDER BY created_at`).all(row.id, req.principal.tenantId) as unknown as RunRow[];
      return buildReviewExport(row, revisions, runs, ctx.publicBaseUrl, now());
    });
  });

  async function sendEvidenceFile(runId: string, name: string, reply: import("fastify").FastifyReply) {
    const row = db.prepare(`SELECT path, content_type FROM evidence WHERE run_id = ? AND name = ?`).get(runId, name) as { path: string; content_type: string } | undefined;
    if (!row || !existsSync(row.path)) return reply.code(404).send({ error: "evidence not found" });
    return reply.header("content-type", row.content_type).header("cache-control", "private, no-store").send(await readFile(row.path));
  }
  return {
    sendEvidenceFile,
    stopAllRecordings: async () => {
      await Promise.all([...recordings.values()].map((s) => s.stop()));
      await Promise.all([...connectionSessions.keys()].map((id) => stopConnection(id, true)));
    }
  };
}
