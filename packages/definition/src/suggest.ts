import type { Checkpoint, InputField } from "./types.js";

/** Minimal event shape shared with @gateway/recorder (kept structural to avoid a runtime dependency). */
export interface ReviewEvent {
  seq: number;
  kind: string;
  url: string;
  target?: { label: string | null; name: string | null; placeholder: string | null; inputType: string | null; tag: string } | undefined;
}

export interface Suggestion {
  checkpoints: Checkpoint[];
  inputs: InputField[];
  /** Recording events that could not be turned into a reviewed step, so the reviewer sees them. */
  unbound: ReviewEvent[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "step";
const ident = (s: string) => {
  const parts = s.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/);
  const joined = parts.map((p, i) => (i === 0 ? p.toLowerCase() : p[0]?.toUpperCase() + p.slice(1).toLowerCase())).join("");
  return /^[A-Za-z_]/.test(joined) ? joined : `field_${joined}`;
};

/**
 * Proposes checkpoints (one per page the demonstration visited) and inputs (one per typed field) from a
 * sanitized recording. Every proposal is a draft the developer must confirm; nothing here is executable.
 */
export function suggestFromRecording(events: ReviewEvent[]): Suggestion {
  const checkpoints: Checkpoint[] = [];
  const inputs: InputField[] = [];
  const unbound: ReviewEvent[] = [];
  let current: Checkpoint | null = null;
  const used = new Set<string>();

  for (const e of events) {
    if (e.kind === "navigate") {
      const path = safePath(e.url);
      let id = slug(path.replace(/^\/+/, "").replace(/\?.*$/, "") || "start");
      while (used.has(id)) id = `${id}-2`;
      used.add(id);
      current = {
        id,
        objective: `Complete the demonstrated actions on ${path}.`,
        precondition: [{ kind: "urlMatches", pattern: escapeRegExp(path.split("?")[0] ?? path) }],
        postcondition: [],
        allowedEffects: [],
        maxActions: 6
      };
      const previous = checkpoints[checkpoints.length - 1];
      if (previous) previous.postcondition.push({ kind: "urlMatches", pattern: escapeRegExp(path.split("?")[0] ?? path) });
      checkpoints.push(current);
      continue;
    }
    if (!current) {
      unbound.push(e);
      continue;
    }
    if (e.kind === "input" && e.target) {
      const label = e.target.label ?? e.target.placeholder ?? e.target.name ?? `field ${e.seq}`;
      if (!current.allowedEffects.includes("type")) current.allowedEffects.push("type");
      if (e.target.inputType === "password") {
        inputs.push({ name: ident(label), type: "string", required: true, source: { kind: "accountSecret", secretRef: `account:${ident(label)}` }, binding: { checkpointId: current.id, targetLabel: label, eventSeq: e.seq } });
      } else {
        inputs.push({ name: ident(label), type: "string", required: true, source: { kind: "caller" }, binding: { checkpointId: current.id, targetLabel: label, eventSeq: e.seq } });
      }
      current.precondition.push({ kind: "fieldVisible", label });
      continue;
    }
    if (e.kind === "click" || e.kind === "submit" || e.kind === "keypress") {
      if (!current.allowedEffects.includes("click")) current.allowedEffects.push("click");
      continue;
    }
    if (e.kind === "select") {
      if (!current.allowedEffects.includes("select")) current.allowedEffects.push("select");
      continue;
    }
    unbound.push(e);
  }
  for (const cp of checkpoints) {
    const names = inputs.filter((i) => i.binding.checkpointId === cp.id).map((i) => `{{${i.name}}}`);
    if (names.length) cp.objective = `Enter ${names.join(", ")} into the demonstrated fields and continue as demonstrated.`;
  }
  return { checkpoints, inputs, unbound };
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
