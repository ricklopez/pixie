import { canonicalJson, sha256Hex } from "./canonical.js";
import {
  ENGINE,
  ENGINE_REVISION,
  FIELD_TYPES,
  INPUT_FIELD_TYPES,
  SCHEMA_VERSION,
  type Assertion,
  type AutomationDefinition,
  type Checkpoint,
  type Condition,
  type Extractor,
  type FieldType,
  type InputField,
  type JsonSchemaObject,
  type OutputField
} from "./types.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

const ID = /^[a-z][a-z0-9-]{1,63}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ACTION_EFFECTS = new Set(["click", "type", "select", "navigate"]);
const CONDITION_KINDS = new Set(["urlMatches", "textPresent", "labelPresent", "fieldVisible", "fieldValue", "itemPresent", "itemAbsent"]);
const TEMPLATE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/;

/** Loopback is only allowed for the synthetic demo fixture; anything else must be HTTPS and non-private. */
export function validateOrigin(origin: string, { allowLoopback }: { allowLoopback: boolean }): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return "not a valid URL";
  }
  if (url.origin !== origin) return "must be a bare origin (scheme://host[:port])";
  const host = url.hostname;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (loopback) return allowLoopback ? null : "loopback origins are only allowed for the synthetic demo fixture";
  if (url.protocol !== "https:") return "non-loopback origins must use https";
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host.endsWith(".internal") || host === "metadata.google.internal")
    return "private-network and metadata destinations are rejected";
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function checkCondition(c: unknown, path: string, issues: ValidationIssue[], lists: Set<string>): void {
  if (!isRecord(c) || !CONDITION_KINDS.has(String(c.kind))) return void issues.push({ path, message: "unknown condition kind" });
  const cond = c as Condition;
  if (cond.kind === "itemPresent" || cond.kind === "itemAbsent") {
    if (!lists.has(String(cond.list))) issues.push({ path, message: "unknown list" });
    if (typeof cond.text !== "string" || !cond.text.trim()) issues.push({ path, message: "condition needs a text string" });
  } else if (cond.kind === "urlMatches") {
    try {
      new RegExp(cond.pattern);
    } catch {
      issues.push({ path, message: "pattern is not a valid regular expression" });
    }
  } else if (typeof (cond as { text?: unknown; label?: unknown }).text !== "string" && typeof (cond as { label?: unknown }).label !== "string") {
    issues.push({ path, message: "condition needs a text/label string" });
  }
}

export function validateDefinition(input: unknown, options: { allowLoopback?: boolean } = {}): { ok: true; definition: AutomationDefinition } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });
  if (!isRecord(input)) return { ok: false, issues: [{ path: "", message: "definition must be an object" }] };
  const d = input;
  if (d.schemaVersion !== SCHEMA_VERSION) push("schemaVersion", `must be ${SCHEMA_VERSION}`);
  if (typeof d.id !== "string" || !ID.test(d.id)) push("id", "must be a lowercase slug");
  if (typeof d.name !== "string" || !d.name.trim()) push("name", "required");
  if (d.engine !== ENGINE) push("engine", `must be ${ENGINE}`);
  if (typeof d.engineRevision !== "string" || !/^[0-9a-f]{40}$/.test(d.engineRevision)) push("engineRevision", "must be a full commit sha");
  if (d.effect !== "read" && d.effect !== "write") push("effect", "must be 'read' or 'write'");
  const lists = new Set<string>();
  if (d.lists !== undefined) {
    if (!isRecord(d.lists)) push("lists", "must be an object");
    else
      for (const [name, spec] of Object.entries(d.lists)) {
        if (!NAME.test(name)) push(`lists.${name}`, "list name must be an identifier");
        if (!isRecord(spec) || typeof spec.item !== "string" || !spec.item.trim() || typeof spec.text !== "string" || !spec.text.trim()) push(`lists.${name}`, "item and text selectors are required");
        else lists.add(name);
      }
  }
  (Array.isArray(d.affordances) ? d.affordances : []).forEach((a, i) => {
    if (!isRecord(a) || typeof a.selector !== "string" || !a.selector.trim() || typeof a.label !== "string" || !a.label.trim() || !["button", "textbox"].includes(String(a.role)))
      push(`affordances[${i}]`, "selector, label and role (button|textbox) are required");
    else if (a.activate !== undefined && !["click", "dblclick"].includes(String(a.activate))) push(`affordances[${i}].activate`, "must be click or dblclick");
  });
  const allowLoopback = options.allowLoopback ?? false;
  const origins = Array.isArray(d.allowedOrigins) ? (d.allowedOrigins as unknown[]) : [];
  if (!origins.length) push("allowedOrigins", "at least one origin is required");
  origins.forEach((o, i) => {
    const err = typeof o === "string" ? validateOrigin(o, { allowLoopback }) : "must be a string";
    if (err) push(`allowedOrigins[${i}]`, err);
  });
  if (typeof d.startUrl !== "string") push("startUrl", "required");
  else {
    try {
      const start = new URL(d.startUrl);
      if (!origins.includes(start.origin)) push("startUrl", "must be within allowedOrigins");
    } catch {
      push("startUrl", "not a valid URL");
    }
  }

  const checkpoints = Array.isArray(d.checkpoints) ? (d.checkpoints as unknown[]) : [];
  if (!checkpoints.length) push("checkpoints", "at least one checkpoint is required");
  const checkpointIds = new Set<string>();
  checkpoints.forEach((c, i) => {
    const p = `checkpoints[${i}]`;
    if (!isRecord(c)) return push(p, "must be an object");
    const cp = c as Partial<Checkpoint>;
    if (typeof cp.id !== "string" || !ID.test(cp.id)) push(`${p}.id`, "must be a lowercase slug");
    else if (checkpointIds.has(cp.id)) push(`${p}.id`, "duplicate checkpoint id");
    else checkpointIds.add(cp.id);
    if (typeof cp.objective !== "string" || !cp.objective.trim()) push(`${p}.objective`, "required");
    if (!Array.isArray(cp.postcondition) || !cp.postcondition.length) push(`${p}.postcondition`, "at least one observable postcondition is required");
    (Array.isArray(cp.precondition) ? cp.precondition : []).forEach((x, j) => checkCondition(x, `${p}.precondition[${j}]`, issues, lists));
    (Array.isArray(cp.postcondition) ? cp.postcondition : []).forEach((x, j) => checkCondition(x, `${p}.postcondition[${j}]`, issues, lists));
    if (cp.mutation !== undefined) {
      const m = cp.mutation;
      if (d.effect !== "write") push(`${p}.mutation`, "mutations require effect 'write'");
      if (!isRecord(m) || !["create", "update", "delete"].includes(String(m.kind))) push(`${p}.mutation.kind`, "must be create, update or delete");
      else {
        if (!lists.has(String(m.list))) push(`${p}.mutation.list`, "unknown list");
        if (m.kind !== "create" && (typeof m.target !== "string" || !TEMPLATE.test(m.target))) push(`${p}.mutation.target`, "update/delete need a target template referencing an input");
        if (m.kind !== "delete" && (typeof m.value !== "string" || !TEMPLATE.test(m.value))) push(`${p}.mutation.value`, "create/update need a value template referencing an input");
        if (m.guardAt !== undefined) {
          const at = checkpoints.slice(0, i).findIndex((o) => isRecord(o) && o.id === m.guardAt);
          if (at < 0) push(`${p}.mutation.guardAt`, "must name an earlier checkpoint");
        }
      }
    }
    if (!Array.isArray(cp.allowedEffects) || cp.allowedEffects.some((e) => !ACTION_EFFECTS.has(e))) push(`${p}.allowedEffects`, "unknown effect");
    if (typeof cp.maxActions !== "number" || cp.maxActions < 1 || cp.maxActions > 60) push(`${p}.maxActions`, "must be 1..60");
  });

  const inputs = Array.isArray(d.inputs) ? (d.inputs as unknown[]) : [];
  const inputNames = new Set<string>();
  inputs.forEach((f, i) => {
    const p = `inputs[${i}]`;
    if (!isRecord(f)) return push(p, "must be an object");
    const field = f as Partial<InputField>;
    if (typeof field.name !== "string" || !NAME.test(field.name)) push(`${p}.name`, "must be an identifier");
    else if (inputNames.has(field.name)) push(`${p}.name`, "duplicate input name");
    else inputNames.add(field.name);
    if (!INPUT_FIELD_TYPES.includes(field.type as FieldType)) push(`${p}.type`, `must be one of ${INPUT_FIELD_TYPES.join(", ")}`);
    if (typeof field.required !== "boolean") push(`${p}.required`, "required flag must be boolean");
    if (!isRecord(field.source) || !["caller", "accountSecret"].includes(String(field.source.kind))) push(`${p}.source`, "must be caller or accountSecret");
    else if (field.source.kind === "accountSecret" && typeof field.source.secretRef !== "string") push(`${p}.source.secretRef`, "required");
    if (!isRecord(field.binding)) push(`${p}.binding`, "confirmed field binding is required");
    else {
      if (!checkpointIds.has(String(field.binding.checkpointId))) push(`${p}.binding.checkpointId`, "unknown checkpoint");
      if (typeof field.binding.targetLabel !== "string" || !field.binding.targetLabel.trim()) push(`${p}.binding.targetLabel`, "confirmed target label is required");
    }
  });

  const outputs = Array.isArray(d.outputs) ? (d.outputs as unknown[]) : [];
  if (!outputs.length) push("outputs", "at least one output is required");
  const outputNames = new Set<string>();
  outputs.forEach((f, i) => {
    const p = `outputs[${i}]`;
    if (!isRecord(f)) return push(p, "must be an object");
    const field = f as Partial<OutputField>;
    if (typeof field.name !== "string" || !NAME.test(field.name)) push(`${p}.name`, "must be an identifier");
    else if (outputNames.has(field.name)) push(`${p}.name`, "duplicate output name");
    else outputNames.add(field.name);
    if (!FIELD_TYPES.includes(field.type as FieldType)) push(`${p}.type`, `must be one of ${FIELD_TYPES.join(", ")}`);
    if (typeof field.required !== "boolean") push(`${p}.required`, "required flag must be boolean");
    const ex = field.extractor as Partial<Extractor> | undefined;
    if (!isRecord(ex)) push(`${p}.extractor`, "required");
    else if (ex.kind === "labelValue") {
      if (!checkpointIds.has(String(ex.checkpointId))) push(`${p}.extractor.checkpointId`, "unknown checkpoint");
      if (typeof ex.label !== "string" || !ex.label.trim()) push(`${p}.extractor.label`, "required");
    } else if (ex.kind === "tableCell") {
      if (!checkpointIds.has(String(ex.checkpointId))) push(`${p}.extractor.checkpointId`, "unknown checkpoint");
      for (const k of ["table", "rowLabel", "column"] as const) if (typeof ex[k] !== "string" || !ex[k]) push(`${p}.extractor.${k}`, "required");
    } else if (ex.kind === "listItems") {
      if (!checkpointIds.has(String(ex.checkpointId))) push(`${p}.extractor.checkpointId`, "unknown checkpoint");
      if (!lists.has(String(ex.list))) push(`${p}.extractor.list`, "unknown list");
      if (field.type !== "list") push(`${p}.type`, "listItems outputs must be typed list");
    } else if (ex.kind === "observedAt") {
      if (field.type !== "date") push(`${p}.type`, "observedAt outputs must be typed date");
    } else push(`${p}.extractor.kind`, "unsupported extractor; only labelValue, tableCell, listItems and observedAt are implemented");
    if (field.type === "list" && ex?.kind !== "listItems") push(`${p}.type`, "list outputs need a listItems extractor");
  });

  const assertions = Array.isArray(d.assertions) ? (d.assertions as unknown[]) : [];
  assertions.forEach((a, i) => {
    const p = `assertions[${i}]`;
    if (!isRecord(a)) return push(p, "must be an object");
    const as = a as Partial<Assertion>;
    switch (as.kind) {
      case "equalsInput":
        if (!outputNames.has(String(as.output))) push(`${p}.output`, "unknown output");
        if (!inputNames.has(String(as.input))) push(`${p}.input`, "unknown input");
        break;
      case "required":
        if (!outputNames.has(String(as.output))) push(`${p}.output`, "unknown output");
        break;
      case "oneOf":
        if (!outputNames.has(String(as.output))) push(`${p}.output`, "unknown output");
        if (!Array.isArray(as.values) || !as.values.length) push(`${p}.values`, "required");
        break;
      case "dateNotAfter":
        if (!outputNames.has(String(as.earlier)) || !outputNames.has(String(as.later))) push(p, "unknown output");
        break;
      case "listContainsInput":
      case "listExcludesInput":
        if (!outputNames.has(String(as.output))) push(`${p}.output`, "unknown output");
        if (!inputNames.has(String(as.input))) push(`${p}.input`, "unknown input");
        break;
      default:
        push(`${p}.kind`, "unsupported assertion kind");
    }
  });
  const hasIdentityCheck = assertions.some((a) => isRecord(a) && ["equalsInput", "listContainsInput", "listExcludesInput"].includes(String(a.kind)));
  if (inputs.length && !hasIdentityCheck) push("assertions", "declare at least one exact-match identity check (equalsInput/listContainsInput/listExcludesInput) between an output and an input");

  if (!isRecord(d.limits) || typeof d.limits.maxActions !== "number" || typeof d.limits.deadlineMs !== "number") push("limits", "maxActions and deadlineMs are required");
  else {
    if (d.limits.maxActions < 1 || d.limits.maxActions > 60) push("limits.maxActions", "must be 1..60");
    if (d.limits.deadlineMs < 1000 || d.limits.deadlineMs > 600_000) push("limits.deadlineMs", "must be 1s..600s");
  }
  (Array.isArray(d.authRequiredSignals) ? d.authRequiredSignals : []).forEach((x, j) => checkCondition(x, `authRequiredSignals[${j}]`, issues, lists));

  if (issues.length) return { ok: false, issues };
  return { ok: true, definition: d as unknown as AutomationDefinition };
}

function fieldSchema(type: FieldType): Record<string, unknown> {
  switch (type) {
    case "string":
      return { type: "string", minLength: 1 };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date" };
    case "list":
      return {
        type: "array",
        items: { type: "object", properties: { text: { type: "string" }, completed: { type: "boolean" } }, required: ["text", "completed"], additionalProperties: false }
      };
  }
}

export function inputJsonSchema(def: AutomationDefinition): JsonSchemaObject {
  const callerInputs = def.inputs.filter((i) => i.source.kind === "caller");
  return {
    type: "object",
    properties: Object.fromEntries(callerInputs.map((i) => [i.name, { ...fieldSchema(i.type), ...(i.description ? { description: i.description } : {}) }])),
    required: callerInputs.filter((i) => i.required).map((i) => i.name),
    additionalProperties: false
  };
}

export function outputJsonSchema(def: AutomationDefinition): JsonSchemaObject {
  return {
    type: "object",
    properties: Object.fromEntries(
      def.outputs.map((o) => [
        o.name,
        {
          ...(o.extractor.kind === "observedAt" ? { type: "string", format: "date-time" } : fieldSchema(o.type)),
          ...(o.description ? { description: o.description } : {})
        }
      ])
    ),
    required: def.outputs.filter((o) => o.required).map((o) => o.name),
    additionalProperties: false
  };
}

/** Content checksum of a definition. Revision numbers and storage metadata are not part of it. */
export function definitionChecksum(def: AutomationDefinition): Promise<string> {
  return sha256Hex(canonicalJson(def));
}

export function newDefinition(partial: Pick<AutomationDefinition, "id" | "name" | "startUrl" | "allowedOrigins">): AutomationDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    engine: ENGINE,
    engineRevision: ENGINE_REVISION,
    effect: "read",
    inputs: [],
    outputs: [],
    checkpoints: [],
    assertions: [],
    limits: { maxActions: 60, deadlineMs: 120_000 },
    authRequiredSignals: [],
    ...partial
  };
}
