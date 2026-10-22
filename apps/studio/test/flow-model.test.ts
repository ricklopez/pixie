import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, correlateDecisions, type Timeline } from "../src/flow-model";
import type { Run } from "../src/api";

function run(state: Run["state"], failure: Run["failure"] = null): Run {
  return {
    id: "r1",
    automationId: "auto-x",
    revision: 1,
    accountId: "acct",
    kind: "endpoint",
    state,
    input: { memberId: "DEMO-1002" },
    createdAt: "t",
    startedAt: "t",
    finishedAt: null,
    failure,
    metrics: null
  };
}

function timeline(events: (Record<string, unknown> & { type: string })[]): Timeline {
  return events.map((event, i) => ({ seq: i + 1, at: `2026-09-26T00:00:0${i}Z`, event }));
}

const call = (checkpointId: string, operation: string, target: string | null, choice = target ?? operation) => ({
  type: "model_call",
  checkpointId,
  model: "jev-1.13.0",
  latencyMs: 142,
  operation,
  target,
  choice,
  confidence: 0.9,
  operationProbabilities: { [operation]: 0.9 },
  targetProbabilities: target ? { [target]: 0.8 } : null
});

test("correlates each model call with the policy/action events that follow it", () => {
  const t = timeline([
    { type: "started" },
    { type: "observation", url: "u" },
    call("search", "TYPE_TEXT", "e2"),
    { type: "policy_allowed", checkpointId: "search", action: "Member ID", kind: "fill", boundInput: "memberId" },
    { type: "observation", url: "u" },
    { type: "action", checkpointId: "search", step: 1, boundInput: "memberId", page_changed: true, typedLength: 9 },
    call("search", "CLICK", "e9"),
    { type: "policy_rejected", checkpointId: "search", code: "origin", reason: "off-origin" },
    call("search", "BLOCKED", null),
    { type: "checkpoint", id: "search", status: "failed", reason: "engine reported BLOCKED" },
    { type: "finished", outcome: "blocked", reason: "blocked" }
  ]);
  const d = correlateDecisions(t);
  assert.equal(d.length, 3);
  assert.equal(d[0]!.allowed?.event.type, "policy_allowed");
  assert.equal(d[0]!.executed?.event.step, 1);
  assert.equal(d[0]!.rejected, null);
  assert.equal(d[0]!.claim, null);
  assert.deepEqual(d[0]!.operationProbabilities, { TYPE_TEXT: 0.9 });
  assert.deepEqual(d[0]!.targetProbabilities, { e2: 0.8 });
  assert.equal(d[1]!.rejected?.event.reason, "off-origin");
  assert.equal(d[1]!.executed, null);
  assert.equal(d[2]!.claim, "BLOCKED");
  assert.equal(d[2]!.claimOutcome?.event.type, "checkpoint");
  assert.equal(d[2]!.targetProbabilities, null);
});

const happened = (edges: ReturnType<typeof buildGraph>["edges"], id: string) => (edges.find((e) => e.id === id)?.data as { happened: boolean }).happened;
const status = (nodes: ReturnType<typeof buildGraph>["nodes"], id: string) => nodes.find((n) => n.id === id)!.data.status;

test("accepted run animates only the transitions backed by events", () => {
  const t = timeline([
    { type: "started" },
    { type: "observation" },
    call("search", "TYPE_TEXT", "e2"),
    { type: "policy_allowed", checkpointId: "search" },
    { type: "observation" },
    { type: "action", checkpointId: "search", step: 1 },
    { type: "extraction", outputs: {} },
    { type: "finished", outcome: "extracted" },
    { type: "verification", accepted: true }
  ]);
  const { nodes, edges } = buildGraph(run("completed"), t, correlateDecisions(t));
  for (const id of ["e-input-queue", "e-queue-observe", "e-observe-decide", "e-decide-policy", "e-policy-act", "e-act-observe", "e-observe-verify", "e-verify-result"]) assert.equal(happened(edges, id), true, id);
  for (const id of ["e-policy-stopped", "e-decide-stopped", "e-observe-stopped", "e-queue-stopped"]) assert.equal(happened(edges, id), false, id);
  assert.equal(status(nodes, "result"), "done");
  assert.equal(status(nodes, "stopped"), "idle");
  assert.equal(status(nodes, "verify"), "done");
  assert.ok(edges.every((e) => (e.data as { live: boolean }).live === false), "terminal run is replay, not live");
});

test("policy rejection that blocks the run lights the rejected path only", () => {
  const t = timeline([
    { type: "started" },
    { type: "observation" },
    call("search", "CLICK", "e9"),
    { type: "policy_rejected", checkpointId: "search", code: "origin", reason: "off-origin" },
    { type: "checkpoint", id: "search", status: "failed", reason: "policy" },
    { type: "finished", outcome: "blocked", reason: "policy rejected" }
  ]);
  const { nodes, edges } = buildGraph(run("needs_review", { reason: "policy rejected" }), t, correlateDecisions(t));
  assert.equal(happened(edges, "e-policy-stopped"), true);
  assert.equal(happened(edges, "e-policy-act"), false);
  assert.equal(happened(edges, "e-observe-verify"), false);
  assert.equal(happened(edges, "e-observe-stopped"), false);
  assert.equal(status(nodes, "policy"), "failed");
  assert.equal(status(nodes, "stopped"), "failed");
  assert.equal(nodes.find((n) => n.id === "stopped")!.data.title, "Blocked");
  assert.equal(status(nodes, "verify"), "idle");
});

test("login-required run routes observation to a warning stop", () => {
  const t = timeline([{ type: "started" }, { type: "observation" }, { type: "auth_required", url: "u", signal: {} }, { type: "finished", outcome: "auth_required", reason: "login" }]);
  const { nodes, edges } = buildGraph(run("awaiting_auth"), t, correlateDecisions(t));
  assert.equal(happened(edges, "e-observe-stopped"), true);
  assert.equal((edges.find((e) => e.id === "e-observe-stopped")!.data as { kind: string }).kind, "warn");
  assert.equal(nodes.find((n) => n.id === "stopped")!.data.title, "Login required");
  assert.equal(status(nodes, "stopped"), "warn");
});

test("cancelled and worker-failed runs stop at the queue edge; in-flight runs are live", () => {
  const cancelled = buildGraph(run("cancelled"), timeline([{ type: "started" }, { type: "state", state: "cancelled" }]), []);
  assert.equal(happened(cancelled.edges, "e-queue-stopped"), true);
  assert.equal(cancelled.nodes.find((n) => n.id === "stopped")!.data.title, "Cancelled");

  const t = timeline([{ type: "started" }, { type: "observation" }]);
  const running = buildGraph(run("running"), t, []);
  assert.equal(status(running.nodes, "observe"), "active");
  assert.equal(happened(running.edges, "e-observe-decide"), false);
  assert.equal((running.edges.find((e) => e.id === "e-queue-observe")!.data as { live: boolean }).live, true);
});
