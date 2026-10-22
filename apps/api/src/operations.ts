import { inputJsonSchema, outputJsonSchema, type AutomationDefinition } from "@gateway/definition";
import type { DatabaseSync } from "node:sqlite";
import type { Principal } from "./auth.js";
import type { AutomationRow, RevisionRow } from "./db.js";
import { isTerminal, type RunManager } from "./runs.js";
import { runResult, runView } from "./views.js";

export interface OperationsContext {
  runs: RunManager;
  publicBaseUrl: string;
  studioBaseUrl: string;
}

export interface StartOperationParams {
  automationId: string;
  revision?: unknown;
  accountId?: unknown;
  input?: unknown;
  idempotencyKey?: string | null;
  defaultLatestRevision?: boolean;
}

export type OperationResponse = { status: number; body: Record<string, unknown> };

export function listOperations(db: DatabaseSync, tenantId: string) {
  return listPublishedAutomations(db, tenantId).map(({ row, revisions: publishedRevisions }) => {
    const latest = publishedRevisions.at(-1)!;
    const definition = JSON.parse(latest.definition) as AutomationDefinition;
    return {
      id: row.id,
      name: row.name,
      latestRevision: latest.revision,
      inputSchema: inputJsonSchema(definition),
      outputSchema: outputJsonSchema(definition)
    };
  });
}

export function listPublishedAutomations(db: DatabaseSync, tenantId: string) {
  const rows = db
    .prepare(`SELECT a.* FROM automations a WHERE a.tenant_id = ? AND EXISTS (SELECT 1 FROM revisions r WHERE r.automation_id = a.id) ORDER BY a.created_at`)
    .all(tenantId) as unknown as AutomationRow[];
  return rows.map((row) => ({ row, revisions: revisions(db, row.id) }));
}

export async function startRun(ctx: OperationsContext, principal: Principal, params: StartOperationParams): Promise<OperationResponse> {
  const db = ctx.runs.db;
  const row = published(db, params.automationId, principal.tenantId);
  if (!row) return { status: 404, body: { error: "no published automation with this id" } };
  const publishedRevisions = revisions(db, row.id);
  const requestedRevision = params.revision === undefined && params.defaultLatestRevision
    ? publishedRevisions.at(-1)?.revision
    : params.revision;
  if (typeof requestedRevision !== "number" || !Number.isInteger(requestedRevision)) {
    return { status: 400, body: { error: "'revision' (integer) is required; there is no implicit latest revision" } };
  }
  const revision = publishedRevisions.find((item) => item.revision === requestedRevision);
  if (!revision) return { status: 400, body: { error: `revision ${requestedRevision} is not published for this automation` } };
  let accountId = params.accountId;
  if (accountId === undefined && params.defaultLatestRevision) {
    accountId = (db.prepare(`SELECT id FROM accounts WHERE tenant_id = ? ORDER BY id LIMIT 1`).get(principal.tenantId) as { id: string } | undefined)?.id;
  }
  if (typeof accountId !== "string" || !accountId) return { status: 400, body: { error: "'accountId' is required" } };
  const account = db.prepare(`SELECT id FROM accounts WHERE id = ? AND tenant_id = ?`).get(accountId, principal.tenantId);
  if (!account) return { status: 403, body: { error: "account is not available to this key" } };
  const created = await ctx.runs.create({
    tenantId: principal.tenantId,
    automationId: row.id,
    revision: revision.revision,
    definition: JSON.parse(revision.definition) as AutomationDefinition,
    accountId,
    callerId: principal.keyId,
    kind: "endpoint",
    input: params.input,
    idempotencyKey: params.idempotencyKey ?? null
  });
  if (!created.ok) return { status: created.status, body: { error: created.error, ...(created.details ? { details: created.details } : {}) } };
  const run = ctx.runs.get(created.run.id)!;
  const links = {
    self: `${ctx.publicBaseUrl}/v1/automations/${row.id}/runs/${run.id}`,
    result: `${ctx.publicBaseUrl}/v1/automations/${row.id}/runs/${run.id}/result`,
    evidence: `${ctx.publicBaseUrl}/v1/automations/${row.id}/runs/${run.id}/evidence`
  };
  return { status: created.reused ? 200 : 202, body: { ...runView(run), links } };
}

export function getRun(ctx: OperationsContext, principal: Principal, automationId: string, runId: string): OperationResponse {
  const run = getScopedRun(ctx.runs, principal.tenantId, automationId, runId);
  if (!run) return { status: 404, body: { error: "run not found" } };
  const verification = ctx.runs.events(runId).find(({ event }) => event.type === "verification")?.event ?? null;
  const body: Record<string, unknown> = { state: run.state, verification };
  if (run.state === "completed") {
    const result = runResult(run);
    if (result) body.result = result;
  }
  if (run.failure) body.failure = JSON.parse(run.failure) as Record<string, unknown>;
  if (run.state === "awaiting_auth" && run.connection_id) {
    body.handoffUrl = `${ctx.studioBaseUrl.replace(/\/+$/, "")}/#/connections/${encodeURIComponent(run.connection_id)}`;
    body.message = "A human must sign in using the Pixie Studio handoff before invoking this operation again.";
  }
  return { status: isTerminal(run.state) ? 200 : 202, body };
}

export function getScopedRun(runs: RunManager, tenantId: string, automationId: string, runId: string) {
  const run = runs.get(runId);
  return run && run.tenant_id === tenantId && run.automation_id === automationId && run.kind === "endpoint" ? run : undefined;
}

export function published(db: DatabaseSync, id: string, tenantId: string): AutomationRow | undefined {
  return db.prepare(`SELECT * FROM automations WHERE id = ? AND tenant_id = ? AND EXISTS (SELECT 1 FROM revisions r WHERE r.automation_id = automations.id)`)
    .get(id, tenantId) as unknown as AutomationRow | undefined;
}

export function revisions(db: DatabaseSync, id: string): RevisionRow[] {
  return db.prepare(`SELECT * FROM revisions WHERE automation_id = ? ORDER BY revision`).all(id) as unknown as RevisionRow[];
}
