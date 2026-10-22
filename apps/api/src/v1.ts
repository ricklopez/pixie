import type { FastifyInstance, FastifyReply } from "fastify";
import { requireRole } from "./auth.js";
import { openApiDocument } from "./openapi.js";
import { isTerminal, type RunManager } from "./runs.js";
import { runEvidence, runResult, runView } from "./views.js";
import { getScopedRun, listPublishedAutomations, published, revisions, startRun } from "./operations.js";

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
  const operations = { runs: ctx.runs, publicBaseUrl: ctx.publicBaseUrl, studioBaseUrl: "" };

  // OpenAPI is readable with any key of the tenant (client or developer).
  app.register(async (v1) => {
    v1.addHook("preHandler", requireRole(db, "any"));
    v1.get<{ Params: { id: string } }>("/v1/automations/:id/openapi.json", async (req, reply) => {
      const row = published(db, req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "no published automation with this id" });
      return openApiDocument(row.id, row.name, revisions(db, row.id), ctx.publicBaseUrl);
    });
    v1.get("/v1/automations", async (req) => {
      return listPublishedAutomations(db, req.principal.tenantId).map(({ row, revisions: publishedRevisions }) => ({
        id: row.id,
        name: row.name,
        revisions: publishedRevisions.map((r) => ({ revision: r.revision, checksum: r.checksum, publishedAt: r.published_at })),
        openapiUrl: `${ctx.publicBaseUrl}/v1/automations/${row.id}/openapi.json`
      }));
    });
  });

  app.register(async (v1) => {
    v1.addHook("preHandler", requireRole(db, "client"));

    const ownedRun = (params: RunParams, tenantId: string) => {
      return getScopedRun(ctx.runs, tenantId, params.id, params.runId);
    };

    v1.post<{ Params: { id: string }; Body: { revision?: unknown; accountId?: unknown; input?: unknown } }>("/v1/automations/:id/runs", async (req, reply) => {
      const body = req.body ?? {};
      const result = await startRun(operations, req.principal, {
        automationId: req.params.id,
        revision: body.revision,
        accountId: body.accountId,
        input: body.input,
        idempotencyKey: typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null
      });
      return reply.code(result.status).send(result.body);
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
