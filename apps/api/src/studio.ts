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
import { createApiKey, requireRole } from "./auth.js";
import { now, type AutomationRow, type AutomationState, type RevisionRow, type RunRow } from "./db.js";
import { openApiDocument } from "./openapi.js";
import { buildReviewExport } from "./export.js";
import { ACCOUNT_ID_PATTERN, isValidAccountId } from "./browsers.js";
import type { RunManager } from "./runs.js";
import { runEvidence, runView } from "./views.js";

export interface StudioContext {
  runs: RunManager;
  cdpUrl: (tenantId: string) => Promise<string>;
  browserProfiles: () => { name: string; cdpUrl: string; userDataDir: string }[];
  allowLoopback: boolean;
  publicBaseUrl: string;
}

const STATES: AutomationState[] = ["draft", "recording", "configuring", "testing", "ready", "published"];

export function registerStudioRoutes(app: FastifyInstance, ctx: StudioContext) {
  const db = ctx.runs.db;
  const recordings = new Map<string, RecordingSession>();

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
    studio.addHook("preHandler", requireRole(db, "developer"));

    studio.get("/studio/me", async (req) => ({ tenantId: req.principal.tenantId, name: req.principal.name, role: req.principal.role }));

    // -- accounts and keys -------------------------------------------------------------------------------
    studio.get("/studio/accounts", async (req) => {
      const rows = db
        .prepare(`SELECT id, name, portal_origin AS portalOrigin, created_at AS createdAt FROM accounts WHERE tenant_id = ? ORDER BY created_at`)
        .all(req.principal.tenantId) as { id: string; name: string; portalOrigin: string; createdAt: string }[];
      const launched = new Map(ctx.browserProfiles().map((p) => [p.name, p]));
      // Where the account's browser state lives; only this tenant's own accounts are reported.
      return rows.map((row) => ({ ...row, browser: launched.has(row.id) ? { state: "running", userDataDir: launched.get(row.id)!.userDataDir } : { state: "not launched" } }));
    });
    studio.post<{ Body: { id?: string; name: string; portalOrigin: string } }>("/studio/accounts", async (req, reply) => {
      const id = req.body.id ?? `acct_${randomUUID().slice(0, 8)}`;
      if (!isValidAccountId(id)) return reply.code(400).send({ error: "account id must match " + ACCOUNT_ID_PATTERN.source });
      if (db.prepare(`SELECT 1 FROM accounts WHERE id = ?`).get(id)) return reply.code(409).send({ error: "account id already exists" });
      db.prepare(`INSERT INTO accounts (id, tenant_id, name, portal_origin, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, req.principal.tenantId, req.body.name, req.body.portalOrigin, now());
      return reply.code(201).send({ id });
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
          ? { ...eligibilityOverviewDefinition(new URL(req.body.startUrl).origin), id, name: req.body.name }
          : template && (TODO_TEMPLATES as readonly string[]).includes(template)
            ? { ...todoDefinition(template as TodoTemplate, new URL(req.body.startUrl).origin), id, name: req.body.name }
            : newDefinition({ id, name: req.body.name, startUrl: req.body.startUrl, allowedOrigins: origins });
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
    studio.post<{ Params: { id: string }; Body: { accountId: string; input: unknown } }>("/studio/automations/:id/test", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      if (!["configuring", "testing", "ready"].includes(row.state)) return reply.code(409).send({ error: `cannot test in state ${row.state}` });
      const account = db.prepare(`SELECT id FROM accounts WHERE id = ? AND tenant_id = ?`).get(req.body.accountId, req.principal.tenantId);
      if (!account) return reply.code(403).send({ error: "account not found in this tenant" });
      const definition = JSON.parse(row.definition) as AutomationDefinition;
      const check = validateDefinition(definition, { allowLoopback: ctx.allowLoopback });
      if (!check.ok) return reply.code(400).send({ error: "definition is not complete", issues: check.issues });
      const created = await ctx.runs.create({
        tenantId: req.principal.tenantId,
        automationId: row.id,
        revision: 0,
        definition,
        accountId: req.body.accountId,
        callerId: req.principal.keyId,
        kind: "test",
        input: req.body.input
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

    // -- publish -----------------------------------------------------------------------------------------
    studio.post<{ Params: { id: string } }>("/studio/automations/:id/publish", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.state !== "ready") return reply.code(409).send({ error: `only automations in state 'ready' can be published (current: ${row.state}); run a passing test first` });
      const test = row.last_test_run_id ? ctx.runs.get(row.last_test_run_id) : undefined;
      if (!test || test.state !== "completed") return reply.code(409).send({ error: "the latest test run did not complete with an accepted result" });
      const definition = JSON.parse(row.definition) as AutomationDefinition;
      const checksum = await definitionChecksum(definition);
      const next = (db.prepare(`SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM revisions WHERE automation_id = ?`).get(row.id) as { n: number }).n;
      db.prepare(`INSERT INTO revisions (automation_id, revision, checksum, definition, published_at, published_by, test_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        row.id, next, checksum, JSON.stringify(definition), now(), req.principal.name, test.id
      );
      setState(row.id, "published");
      return reply.code(201).send({ automationId: row.id, revision: next, checksum, openapiUrl: `${ctx.publicBaseUrl}/v1/automations/${row.id}/openapi.json` });
    });
    studio.post<{ Params: { id: string } }>("/studio/automations/:id/new-draft", async (req, reply) => {
      const row = automation(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.state !== "published") return reply.code(409).send({ error: "only published automations can be forked into a new draft" });
      const id = `auto-${randomUUID().slice(0, 8)}`;
      const definition = { ...(JSON.parse(row.definition) as AutomationDefinition), id, name: `${row.name} (draft)` };
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
      return {
        rows,
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
  return { sendEvidenceFile, stopAllRecordings: async () => Promise.all([...recordings.values()].map((s) => s.stop())) };
}
