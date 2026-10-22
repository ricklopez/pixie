import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { authenticate, type Principal } from "./auth.js";
import type { OperationsContext } from "./operations.js";
import { getRun, listOperations, startRun } from "./operations.js";

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function createServer(ctx: OperationsContext, principal: Principal) {
  const server = new McpServer({ name: "pixie-operations", version: "1.0.0" });
  server.registerTool("list_operations", {
    description: "List this tenant's published operations and their input/output JSON schemas.",
    inputSchema: {}
  }, async () => toolResult(listOperations(ctx.runs.db, principal.tenantId)));
  server.registerTool("invoke", {
    description: "Start a published operation and return a run handle without waiting for completion.",
    inputSchema: {
      automationId: z.string().min(1),
      input: z.record(z.string(), z.unknown()),
      revision: z.number().int().positive().optional(),
      accountId: z.string().min(1).optional(),
      idempotencyKey: z.string().min(1).optional()
    }
  }, async ({ automationId, input, revision, accountId, idempotencyKey }) => {
    const started = await startRun(ctx, principal, { automationId, input, revision, accountId, idempotencyKey, defaultLatestRevision: true });
    if (started.status >= 400) return toolError(JSON.stringify(started.body));
    const body = started.body as { id: string; state: string };
    return toolResult({
      runId: body.id,
      state: body.state,
      statusUrl: `${ctx.publicBaseUrl.replace(/\/+$/, "")}/v1/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(body.id)}`
    });
  });
  server.registerTool("get_run", {
    description: "Read a published operation run, its accepted result, verification summary, or failure.",
    inputSchema: {
      automationId: z.string().min(1),
      runId: z.string().min(1)
    }
  }, async ({ automationId, runId }) => {
    const result = getRun(ctx, principal, automationId, runId);
    if (result.status === 404) return toolError("not found");
    return toolResult(result.body);
  });
  return server;
}

const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport; keyId: string }>();

export function registerMcpRoute(app: FastifyInstance, ctx: OperationsContext) {
  const db = ctx.runs.db;
  app.post("/mcp", async (req, reply) => {
    const principal = authenticate(db, req);
    if (!principal) {
      return reply.code(401).type("application/json").send({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
        id: null
      });
    }
    if (principal.role !== "client") {
      return reply.code(403).type("application/json").send({
        jsonrpc: "2.0",
        error: { code: -32003, message: "Forbidden: a client key is required" },
        id: null
      });
    }
    const requestedSession = req.headers["mcp-session-id"];
    let session = typeof requestedSession === "string" ? sessions.get(requestedSession) : undefined;
    if (session && session.keyId !== principal.keyId) {
      return reply.code(404).type("application/json").send({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
    }
    if (typeof requestedSession === "string" && !session) {
      return reply.code(404).type("application/json").send({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
    }
    if (!session) {
      const server = createServer(ctx, principal);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
      await server.connect(transport);
      session = { server, transport, keyId: principal.keyId };
    }
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw, req.body);
    if (session.transport.sessionId) {
      sessions.set(session.transport.sessionId, session);
    }
  });
}
