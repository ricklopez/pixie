import type { FastifyInstance, FastifyReply } from "fastify";
import { requireRole } from "./auth.js";
import { openApiDocument, repositoryOpenApiDocument } from "./openapi.js";
import type { RunManager } from "./runs.js";
import { runEvidence, runView } from "./views.js";
import {
  getContractRunResult,
  getContractRunStatus,
  getRunResult,
  getRunStatus,
  getScopedRun,
  listPublishedAutomations,
  published,
  revisions,
  startContractRun,
  startRun
} from "./operations.js";
import { listRepositoryOperations } from "./contracts.js";

export interface V1Context {
  runs: RunManager;
  publicBaseUrl: string;
  studioBaseUrl?: string;
  sendEvidenceFile: (runId: string, name: string, reply: FastifyReply) => Promise<unknown>;
}

interface RunParams {
  id: string;
  runId: string;
}

/** Published endpoint set. Every route is scoped to the caller's tenant; unpublished automations do not exist here. */
export function registerV1Routes(app: FastifyInstance, ctx: V1Context) {
  const db = ctx.runs.db;
  const operations = { runs: ctx.runs, publicBaseUrl: ctx.publicBaseUrl, studioBaseUrl: ctx.studioBaseUrl ?? "http://127.0.0.1:5173" };

  // OpenAPI is readable with any key of the tenant (client or developer).
  app.register(async (v1) => {
    v1.addHook("preHandler", requireRole(db, "any"));
    v1.get<{ Params: { id: string } }>("/v1/automations/:id/openapi.json", async (req, reply) => {
      const row = published(db, req.params.id, req.principal.tenantId);
      if (!row) return reply.code(404).send({ error: "no published automation with this id" });
      return openApiDocument(row.id, row.name, revisions(db, row.id), ctx.publicBaseUrl);
    });
    v1.get<{ Params: { repo: string } }>("/v1/repositories/:repo/openapi.json", async (req, reply) => {
      const operations = listRepositoryOperations(db, req.principal.tenantId, req.params.repo);
      if (!operations.length) return reply.code(404).send({ error: "repository not found" });
      return repositoryOpenApiDocument(req.params.repo, operations, ctx.publicBaseUrl);
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
      const result = getRunStatus(operations, req.principal, req.params.id, req.params.runId);
      return reply.code(result.status).send(result.body);
    });

    v1.get<{ Params: RunParams }>("/v1/automations/:id/runs/:runId/result", async (req, reply) => {
      const result = getRunResult(operations, req.principal, req.params.id, req.params.runId);
      return reply.code(result.status).send(result.body);
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

    v1.post<{ Params: { repo: string; method: string }; Querystring: { version?: string }; Body: { accountId?: unknown; input?: unknown } }>(
      "/v1/repositories/:repo/operations/:method/runs",
      async (req, reply) => {
        const header = req.headers["pixie-contract-version"];
        const rawVersion = typeof header === "string" ? header : req.query.version;
        const result = await startContractRun(operations, req.principal, {
          repository: req.params.repo,
          method: req.params.method,
          version: rawVersion === undefined ? undefined : Number(rawVersion),
          accountId: req.body?.accountId,
          input: req.body?.input,
          idempotencyKey: typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : null
        });
        return reply.code(result.status).send(result.body);
      }
    );
    v1.get<{ Params: { repo: string; method: string; runId: string } }>("/v1/repositories/:repo/operations/:method/runs/:runId", async (req, reply) => {
      const result = getContractRunStatus(operations, req.principal, req.params.repo, req.params.method, req.params.runId);
      return reply.code(result.status).send(result.body);
    });
    v1.get<{ Params: { repo: string; method: string; runId: string } }>("/v1/repositories/:repo/operations/:method/runs/:runId/result", async (req, reply) => {
      const result = getContractRunResult(operations, req.principal, req.params.repo, req.params.method, req.params.runId);
      return reply.code(result.status).send(result.body);
    });
  });
}
