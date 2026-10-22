import type { FastifyInstance, FastifyReply } from "fastify";
import type { AutomationDefinition } from "@gateway/definition";
import { requireRole } from "./auth.js";
import type { AutomationRow, RevisionRow } from "./db.js";
import { openApiDocument } from "./openapi.js";
import { isTerminal, type RunManager } from "./runs.js";
import { runEvidence, runResult, runView } from "./views.js";

export interface V1Context {
  runs: RunManager;
  publicBaseUrl: string;
  sendEvidenceFile: (runId: string, name: string, reply: FastifyReply) => Promise<unknown>;
}

interface RunParams {
  id: string;
  runId: string;
}

/** Published endpoint set. Every route is scoped to the caller's tenant; unpublished automations do not exist here. */
export function registerV1Routes(app: FastifyInstance, ctx: V1Context) {
  const db = ctx.runs.db;
  const published = (id: string, tenantId: string) =>
    db.prepare(`SELECT * FROM automations WHERE id = ? AND tenant_id = ? AND EXISTS (SELECT 1 FROM revisions r WHERE r.automation_id = automations.id)`).get(id, tenantId) as unknown as AutomationRow | undefined;
  const revisions = (id: string) => db.prepare(`SELECT * FROM revisions WHERE automation_id = ? ORDER BY revision`).all(id) as unknown as RevisionRow[];

  // OpenAPI is readable with any key of the tenant (client or developer).
  app.register(async (v1) => {
    v1.addHook("preHandler", requireRole(db, "any"));
    v1.get<{ Params: { id: string } }>("/v1/automations/:id/openapi.json", async (req, reply) => {
      const row = published(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "no published automation with this id" });
      return openApiDocument(row.id, row.name, revisions(row.id), ctx.publicBaseUrl);
    });
    v1.get("/v1/automations", async (req) => {
      const rows = db
        .prepare(`SELECT a.* FROM automations a WHERE a.tenant_id = ? AND EXISTS (SELECT 1 FROM revisions r WHERE r.automation_id = a.id) ORDER BY a.created_at`)
        .all(req.principal.tenantId) as unknown as AutomationRow[];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        revisions: revisions(row.id).map((r) => ({ revision: r.revision, checksum: r.checksum, publishedAt: r.published_at })),
        openapiUrl: `${ctx.publicBaseUrl}/v1/automations/${row.id}/openapi.json`
      }));
    });
  });

  app.register(async (v1) => {
    v1.addHook("preHandler", requireRole(db, "client"));

    const ownedRun = (params: RunParams, tenantId: string) => {
      const run = ctx.runs.get(params.runId);
      if (!run || run.tenant_id !== tenantId || run.automation_id !== params.id || run.kind !== "endpoint") return undefined;
      return run;
    };

    v1.post<{ Params: { id: string }; Body: { revision?: unknown; accountId?: unknown; input?: unknown } }>("/v1/automations/:id/runs", async (req, reply) => {
      const row = published(req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "no published automation with this id" });
      const body = req.body ?? {};
      if (typeof body.revision !== "number" || !Number.isInteger(body.revision)) return reply.code(400).send({ error: "'revision' (integer) is required; there is no implicit latest revision" });
      if (typeof body.accountId !== "string" || !body.accountId) return reply.code(400).send({ error: "'accountId' is required" });
      const revision = revisions(row.id).find((r) => r.revision === body.revision);
      if (!revision) return reply.code(400).send({ error: `revision ${body.revision} is not published for this automation` });
      const account = db.prepare(`SELECT id FROM accounts WHERE id = ? AND tenant_id = ?`).get(body.accountId, req.principal.tenantId);
      if (!account) return reply.code(403).send({ error: "account is not available to this key" });
      const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null;
      const created = await ctx.runs.create({
        tenantId: req.principal.tenantId,
        automationId: row.id,
        revision: revision.revision,
        definition: JSON.parse(revision.definition) as AutomationDefinition,
        accountId: body.accountId,
        callerId: req.principal.keyId,
        kind: "endpoint",
        input: body.input,
        idempotencyKey
      });
      if (!created.ok) return reply.code(created.status).send({ error: created.error, details: created.details });
      const links = {
        self: `${ctx.publicBaseUrl}/v1/automations/${row.id}/runs/${created.run.id}`,
        result: `${ctx.publicBaseUrl}/v1/automations/${row.id}/runs/${created.run.id}/result`,
        evidence: `${ctx.publicBaseUrl}/v1/automations/${row.id}/runs/${created.run.id}/evidence`
      };
      return reply.code(created.reused ? 200 : 202).send({ ...runView(ctx.runs.get(created.run.id)!), links });
    });

    v1.get<{ Params: RunParams }>("/v1/automations/:id/runs/:runId", async (req, reply) => {
      const run = ownedRun(req.params, req.principal.tenantId);
      return run ? runView(run) : reply.code(404).send({ error: "run not found" });
    });

    v1.get<{ Params: RunParams }>("/v1/automations/:id/runs/:runId/result", async (req, reply) => {
      const run = ownedRun(req.params, req.principal.tenantId);
      if (!run) return reply.code(404).send({ error: "run not found" });
      if (!isTerminal(run.state)) return reply.code(202).send(runView(run));
      const result = runResult(run);
      if (!result) return reply.code(409).send({ ...runView(run), error: `run ended in state '${run.state}' without an accepted result` });
      return result;
    });

    v1.get<{ Params: RunParams }>("/v1/automations/:id/runs/:runId/evidence", async (req, reply) => {
      const run = ownedRun(req.params, req.principal.tenantId);
      if (!run) return reply.code(404).send({ error: "run not found" });
      return runEvidence(db, ctx.runs, run, `${ctx.publicBaseUrl}/v1/automations/${run.automation_id}/runs/${run.id}/evidence`);
    });

    v1.get<{ Params: RunParams & { name: string } }>("/v1/automations/:id/runs/:runId/evidence/:name", async (req, reply) => {
      const run = ownedRun(req.params, req.principal.tenantId);
      if (!run) return reply.code(404).send({ error: "run not found" });
      return ctx.sendEvidenceFile(run.id, req.params.name, reply);
    });

    v1.post<{ Params: RunParams }>("/v1/automations/:id/runs/:runId/cancel", async (req, reply) => {
      const run = ownedRun(req.params, req.principal.tenantId);
      if (!run) return reply.code(404).send({ error: "run not found" });
      const result = ctx.runs.cancel(run.id);
      return reply.code(result.ok ? 202 : 409).send({ ...result, run: runView(ctx.runs.get(run.id)!) });
    });
  });
}
