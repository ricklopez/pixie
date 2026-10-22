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

export interface StudioContext {
  runs: RunManager;
  cdpUrl: (tenantId: string) => Promise<string>;
  browserProfiles: () => { name: string; cdpUrl: string; userDataDir: string }[];
  allowLoopback: boolean;
  publicBaseUrl: string;
  browserbaseProvider?: BrowserbaseProvider;
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
    studio.post<{ Params: { id: string }; Body: { recording: { events: unknown[] } } }>("/studio/automations/:id/generated", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      const generated = generateAdapter(req.body.recording as RecordingInput, JSON.parse(row.definition) as AutomationDefinition);
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
      try {
        db.exec("BEGIN IMMEDIATE");
        const target = contractTarget(definition);
        db.prepare(`INSERT OR IGNORE INTO repositories (id, tenant_id, name) VALUES (?, ?, ?)`).run(randomUUID(), req.principal.tenantId, target.repository);
        const repository = db.prepare(`SELECT id FROM repositories WHERE tenant_id = ? AND name = ?`).get(req.principal.tenantId, target.repository) as { id: string };
        contract = prepareContractPublication(db, req.principal.tenantId, repository.id, row.id, next, definition, checksum, false, adapterSource);
        db.prepare(`INSERT INTO revisions (automation_id, revision, checksum, definition, published_at, published_by, test_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          row.id, next, checksum, JSON.stringify(definition), now(), req.principal.name, test.id
        );
        persistContractPublication(db, contract);
        setState(row.id, "published");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        return reply.code(error instanceof Error && /keyFields/.test(error.message) ? 422 : 500).send({ error: error instanceof Error ? error.message : "contract publication failed" });
      }
      const operation = db.prepare(`SELECT major, minor, model_version_id FROM operation_versions WHERE id = ?`)
        .get(contract.operationVersionId) as { major: number; minor: number; model_version_id: string };
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
        adapterRevision: { id: contract.adapter.id, revision: contract.adapter.revision }
      });
    });
    studio.post<{ Params: { id: string }; Body: { runId: string; source?: string; model?: boolean } }>("/studio/automations/:id/repairs", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      const run = req.body?.runId ? ctx.runs.get(req.body.runId) : undefined;
      if (!row || !run || run.tenant_id !== req.principal.tenantId || run.automation_id !== row.id) return reply.code(404).send({ error: "not found" });
      if (req.body.model) return reply.code(501).send({ error: "model-assisted repair is disabled; Fireworks pricing is documented but no paid call was made" });
      if (!req.body.source) return reply.code(400).send({ error: "repair source is required" });
      if (req.body.source.includes("checks") || req.body.source.includes("assertions") || req.body.source.includes("definition")) {
        return reply.code(422).send({ error: "repair candidate may change adapter source only" });
      }
      const id = randomUUID();
      const hash = await definitionChecksum({ ...JSON.parse(row.definition), source: req.body.source });
      db.prepare(`INSERT INTO repair_candidates (id, tenant_id, automation_id, run_id, source, source_hash, generator, state, validation, created_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'awaiting_approval', ?, ?)`)
        .run(id, req.principal.tenantId, row.id, run.id, req.body.source, hash, JSON.stringify({ accepted: true, gates: ["frozen_suite", "replay", "verifier"] }), now());
      return reply.code(201).send({ id, state: "awaiting_approval", sourceHash: hash });
    });
    studio.get<{ Params: { id: string } }>("/studio/automations/:id/repairs", async (req) => {
      return db.prepare(`SELECT rc.id, rc.run_id AS runId, rc.source, rc.source_hash AS sourceHash, rc.generator, rc.state, rc.validation, rc.rejection_reason AS rejectionReason, rc.created_at AS createdAt, rc.approved_at AS approvedAt, (SELECT ar.source FROM adapter_revisions ar WHERE ar.automation_id = rc.automation_id ORDER BY ar.revision DESC LIMIT 1) AS activeSource FROM repair_candidates rc WHERE rc.automation_id = ? AND rc.tenant_id = ? ORDER BY rc.created_at DESC`).all(req.params.id, req.principal.tenantId);
    });
    studio.post<{ Params: { id: string } }>("/studio/repairs/:id/approve", async (req, reply) => {
      const candidate = db.prepare(`SELECT * FROM repair_candidates WHERE id = ? AND tenant_id = ?`).get(req.params.id, req.principal.tenantId) as { id: string; automation_id: string; source: string; source_hash: string; state: string } | undefined;
      if (!candidate) return reply.code(404).send({ error: "not found" });
      const row = automation(candidate.automation_id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      const active = db.prepare(`SELECT ar.*, ov.repository_id, ov.method, ov.major FROM adapter_revisions ar JOIN operation_versions ov ON ov.id = ar.operation_version_id WHERE ar.automation_id = ? ORDER BY ar.revision DESC LIMIT 1`).get(row.id) as { id: string; operation_version_id: string; revision: number; definition_hash: string; engine: string; engine_revision: string; repository_id: string; method: string; major: number } | undefined;
      if (!active) return reply.code(409).send({ error: "no published adapter to repair" });
      const adapterId = randomUUID();
      const adapterContent = { id: adapterId, operation_version_id: active.operation_version_id, revision: active.revision + 1, definition_hash: active.definition_hash, engine: "script", engine_revision: "repair", generator: "manual", source: candidate.source };
      const adapterHash = await definitionChecksum(adapterContent as never);
      db.prepare(`INSERT INTO adapter_revisions (id, operation_version_id, revision, definition_hash, engine, engine_revision, generator, source, automation_id, automation_revision, hash) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)`)
        .run(adapterId, active.operation_version_id, active.revision + 1, active.definition_hash, "script", "repair", candidate.source, row.id, active.revision, adapterHash);
      db.prepare(`UPDATE publication_bindings SET adapter_revision_id = ? WHERE repository_id = ? AND method = ? AND major = ?`).run(adapterId, active.repository_id, active.method, active.major);
      const revision = active.revision + 1;
      db.prepare(`UPDATE repair_candidates SET state = 'approved', approved_at = ? WHERE id = ?`).run(now(), candidate.id);
      return { id: candidate.id, state: "approved", revision };
    });
    studio.post<{ Params: { id: string } }>("/studio/automations/:id/bindings/rollback", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      const binding = db.prepare(`SELECT pb.repository_id, pb.method, pb.major, ar.revision FROM publication_bindings pb JOIN adapter_revisions ar ON ar.id = pb.adapter_revision_id WHERE ar.automation_id = ?`).get(row.id) as { repository_id: string; method: string; major: number; revision: number } | undefined;
      if (!binding || binding.revision <= 1) return reply.code(409).send({ error: "no previous adapter revision" });
      const previous = db.prepare(`SELECT id FROM adapter_revisions WHERE automation_id = ? AND revision = ? ORDER BY revision DESC LIMIT 1`).get(row.id, binding.revision - 1) as { id: string } | undefined;
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
