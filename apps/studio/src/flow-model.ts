import { TERMINAL, type Run, type RunEvidence } from "./api";
import type { Edge, Node } from "@xyflow/react";

export type Timeline = RunEvidence["timeline"];
export type Ev = Timeline[number];

/** One Jev decision correlated with what the gateway did about it. Stages are distinct and event-backed. */
export interface Decision {
  seq: number;
  at: string;
  checkpointId: string;
  model: string | null;
  latencyMs: number | null;
  operation: string | null;
  target: string | null;
  choice: string;
  confidence: number | null;
  targetConfidence: number | null;
  operationProbabilities: Record<string, number> | null;
  targetProbabilities: Record<string, number> | null;
  usage: Record<string, number> | null;
  allowed: Ev | null;
  rejected: Ev | null;
  executed: Ev | null;
  claim: "DONE" | "BLOCKED" | null;
  claimOutcome: Ev | null;
}

export function correlateDecisions(timeline: Timeline): Decision[] {
  const out: Decision[] = [];
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i]!;
    if (e.event.type !== "model_call") continue;
    const m = e.event as Record<string, unknown>;
    const choice = String(m.choice);
    const d: Decision = {
      seq: e.seq,
      at: e.at,
      checkpointId: String(m.checkpointId),
      model: (m.model as string | null) ?? null,
      latencyMs: (m.latencyMs as number | null) ?? null,
      operation: (m.operation as string | null) ?? null,
      target: m.target == null ? null : String(m.target),
      choice,
      confidence: (m.confidence as number | null) ?? null,
      targetConfidence: (m.targetConfidence as number | null) ?? null,
      operationProbabilities: (m.operationProbabilities as Record<string, number> | null) ?? null,
      targetProbabilities: (m.targetProbabilities as Record<string, number> | null) ?? null,
      usage: (m.usage as Record<string, number> | null) ?? null,
      allowed: null,
      rejected: null,
      executed: null,
      claim: choice === "DONE" || choice === "BLOCKED" ? choice : null,
      claimOutcome: null
    };
    for (let j = i + 1; j < timeline.length; j++) {
      const n = timeline[j]!;
      const t = n.event.type;
      if (t === "model_call") break;
      if (t === "policy_allowed") d.allowed = n;
      else if (t === "policy_rejected") d.rejected = n;
      else if (t === "action") d.executed = n;
      else if (d.claim && (t === "checkpoint" || t === "finished")) d.claimOutcome ??= n;
    }
    out.push(d);
  }
  return out;
}

export type NodeStatus = "idle" | "active" | "done" | "failed" | "warn";
export interface StageData extends Record<string, unknown> {
  title: string;
  detail: string;
  status: NodeStatus;
  count?: number;
}

const has = (t: Timeline, type: string, pred: (e: Record<string, unknown>) => boolean = () => true) => t.some((e) => e.event.type === type && pred(e.event));
const count = (t: Timeline, type: string, pred: (e: Record<string, unknown>) => boolean = () => true) => t.filter((e) => e.event.type === type && pred(e.event)).length;

/** Builds nodes/edges purely from recorded events; an edge is animated only if the transition it represents happened. */
export function buildGraph(run: Run, timeline: Timeline, decisions: Decision[]) {
  const finished = timeline.find((e) => e.event.type === "finished")?.event as (Record<string, unknown> & { outcome?: string; reason?: string }) | undefined;
  const verification = timeline.find((e) => e.event.type === "verification")?.event as (Record<string, unknown> & { accepted?: boolean; reasons?: string[] }) | undefined;
  const terminal = TERMINAL.includes(run.state);
  const started = has(timeline, "started");
  const observations = count(timeline, "observation");
  const modelCalls = decisions.length;
  const proposals = decisions.filter((d) => !d.claim).length;
  const allowed = count(timeline, "policy_allowed");
  const rejected = count(timeline, "policy_rejected");
  const actions = count(timeline, "action");
  const extraction = has(timeline, "extraction");
  const authRequired = has(timeline, "auth_required");
  const failedCheckpoint = has(timeline, "checkpoint", (e) => e.status === "failed");
  const outcome = finished?.outcome;
  const engine = (timeline.find((e) => e.event.type === "engine_selected")?.event as { engine?: string } | undefined)?.engine;
  const live = !terminal;

  const status = (reached: boolean, active: boolean, bad = false): NodeStatus => (bad ? "failed" : active && live ? "active" : reached ? "done" : "idle");
  const x = (col: number) => col * 190;

  const nodes: Node<StageData>[] = [
    { id: "input", type: "stage", position: { x: x(0), y: 120 }, data: { title: "API input", detail: `${run.kind} · ${Object.keys(run.input).length} field(s)`, status: "done" } },
    { id: "queue", type: "stage", position: { x: x(1), y: 120 }, data: { title: "Validation / queue", detail: engine ? `engine ${engine}` : run.state === "queued" ? "waiting for account slot" : "validated", status: status(true, run.state === "queued", outcome === "failed" && !started) } },
    { id: "observe", type: "stage", position: { x: x(2), y: 120 }, data: { title: "Observation", detail: observations ? `${observations} page observation(s)` : "no observation yet", status: status(observations > 0, run.state === "running" && observations > 0 && modelCalls === 0), count: observations } },
    { id: "decide", type: "stage", position: { x: x(3), y: 120 }, data: { title: "Jev decision", detail: modelCalls ? `${modelCalls} model call(s)${live ? "" : ` · ${proposals} action proposal(s)`}` : "no decision yet", status: status(modelCalls > 0, run.state === "running" && modelCalls > 0 && !terminal), count: modelCalls } },
    { id: "policy", type: "stage", position: { x: x(4), y: 120 }, data: { title: "Policy check", detail: allowed + rejected ? `${allowed} allowed · ${rejected} rejected` : "nothing checked yet", status: status(allowed + rejected > 0, false, rejected > 0 && outcome === "blocked"), count: allowed + rejected } },
    { id: "act", type: "stage", position: { x: x(5), y: 120 }, data: { title: "Browser action", detail: actions ? `${actions} executed` : "none executed", status: status(actions > 0, false), count: actions } },
    { id: "verify", type: "stage", position: { x: x(4), y: 300 }, data: { title: "Independent verification", detail: verification ? (verification.accepted ? "all checks passed" : (verification.reasons ?? []).join("; ") || "rejected") : extraction ? "verifying" : "no extraction reached", status: status(!!verification, run.state === "verifying", verification ? !verification.accepted : false) } },
    { id: "result", type: "stage", position: { x: x(5), y: 300 }, data: { title: run.state === "completed" ? "Result: accepted" : run.state === "needs_review" ? "Result: needs review" : "Result", detail: run.state === "completed" ? "typed data exposed" : run.state === "needs_review" ? "no data exposed" : terminal ? run.state : "pending", status: run.state === "completed" ? "done" : run.state === "needs_review" ? "warn" : "idle" } },
    { id: "stopped", type: "stage", position: { x: x(2), y: 300 }, data: { title: authRequired ? "Login required" : outcome === "blocked" ? "Blocked" : run.state === "cancelled" ? "Cancelled" : "Failed", detail: finished?.reason ? String(finished.reason).slice(0, 90) : run.failure?.reason?.slice(0, 90) ?? "not reached", status: outcome && outcome !== "extracted" ? (authRequired ? "warn" : "failed") : run.state === "failed" || run.state === "cancelled" ? "failed" : "idle" } }
  ];

  const edge = (id: string, source: string, target: string, happened: boolean, label?: string, kind: "ok" | "bad" | "warn" = "ok", sourceHandle?: string, targetHandle?: string): Edge => ({
    id,
    source,
    target,
    sourceHandle,
    targetHandle,
    type: "flow",
    label,
    data: { happened, kind, live: happened && live }
  });

  const edges: Edge[] = [
    edge("e-input-queue", "input", "queue", true),
    edge("e-queue-observe", "queue", "observe", started && observations > 0),
    edge("e-observe-decide", "observe", "decide", modelCalls > 0),
    edge("e-decide-policy", "decide", "policy", proposals > 0, proposals ? `${proposals}` : undefined),
    edge("e-policy-act", "policy", "act", allowed > 0, allowed ? `${allowed} allowed` : undefined),
    edge("e-act-observe", "act", "observe", actions > 0, actions ? `${actions} re-observed` : undefined, "ok", "top", "top"),
    edge("e-observe-verify", "observe", "verify", extraction, extraction ? "extraction" : undefined, "ok", "bottom", "top"),
    edge("e-verify-result", "verify", "result", !!verification, verification ? (verification.accepted ? "accepted" : "rejected") : undefined, verification && !verification.accepted ? "warn" : "ok"),
    edge("e-policy-stopped", "policy", "stopped", rejected > 0 && outcome === "blocked", rejected && outcome === "blocked" ? `${rejected} rejected` : undefined, "bad", "bottom", "top"),
    edge("e-decide-stopped", "decide", "stopped", decisions.some((d) => d.claim && d.claimOutcome), decisions.some((d) => d.claim && d.claimOutcome) ? "unverified claim" : undefined, "bad", "bottom", "top"),
    edge("e-observe-stopped", "observe", "stopped", authRequired || (failedCheckpoint && rejected === 0 && !decisions.some((d) => d.claim)), authRequired ? "auth signal" : failedCheckpoint ? "condition unmet" : undefined, authRequired ? "warn" : "bad", "bottom", "top"),
    edge("e-queue-stopped", "queue", "stopped", (outcome === "failed" && !extraction) || run.state === "cancelled" || (run.state === "failed" && !finished), outcome === "failed" ? "worker failure" : run.state === "cancelled" ? "cancelled" : undefined, "bad", "bottom", "top")
  ];
  return { nodes, edges };
}
