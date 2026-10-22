import type { DatabaseSync } from "node:sqlite";
import type { RunRow } from "./db.js";
import type { RunManager } from "./runs.js";

export function runView(run: RunRow) {
  return {
    id: run.id,
    automationId: run.automation_id,
    revision: run.revision,
    accountId: run.account_id,
    kind: run.kind,
    state: run.state,
    input: JSON.parse(run.input) as Record<string, unknown>,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    failure: run.failure ? (JSON.parse(run.failure) as Record<string, unknown>) : null,
    metrics: run.metrics ? (JSON.parse(run.metrics) as Record<string, unknown>) : null
  };
}

/** Verified result only. Runs that were not accepted expose failure details, never data. */
export function runResult(run: RunRow) {
  if (run.state !== "completed" || !run.result) return null;
  const result = JSON.parse(run.result) as { data: Record<string, unknown>; checks: unknown[]; observedAt: string; finalUrl: string };
  return { runId: run.id, automationId: run.automation_id, revision: run.revision, accepted: true as const, data: result.data, checks: result.checks, observedAt: result.observedAt };
}

/** Sanitized evidence: action history, model decisions, verification checks and authorized screenshot links. */
export function runEvidence(db: DatabaseSync, runs: RunManager, run: RunRow, evidenceBasePath: string) {
  const events = runs.events(run.id);
  const result = run.result ? (JSON.parse(run.result) as { checks: unknown[]; rawExtraction: Record<string, unknown>; finalUrl: string; data: Record<string, unknown> }) : null;
  const screenshots = (db.prepare(`SELECT name FROM evidence WHERE run_id = ? ORDER BY rowid`).all(run.id) as { name: string }[]).map((s) => ({
    name: s.name,
    url: `${evidenceBasePath}/${s.name}`
  }));
  return {
    run: runView(run),
    timeline: events,
    checkpoints: events.filter((e) => e.event.type === "checkpoint").map((e) => e.event),
    modelDecisions: events.filter((e) => e.event.type === "model_call").map((e) => e.event),
    actions: events.filter((e) => e.event.type === "action").map((e) => e.event),
    policyRejections: events.filter((e) => e.event.type === "policy_rejected").map((e) => e.event),
    verification: events.find((e) => e.event.type === "verification")?.event ?? null,
    rawExtraction: result?.rawExtraction ?? null,
    data: run.state === "completed" ? result?.data ?? null : null,
    finalUrl: result?.finalUrl ?? null,
    screenshots
  };
}
