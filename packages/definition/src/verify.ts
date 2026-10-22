import type { AutomationDefinition, FieldType, JsonSchemaObject } from "./types.js";

/** Raw extraction reported by the worker: text observed on the page, or null when not found. */
export interface ListItem {
  text: string;
  completed: boolean;
}

/** Worker-side before/after DOM comparison of a declared write checkpoint. */
export interface MutationCheck {
  checkpointId: string;
  kind: "create" | "update" | "delete";
  ok: boolean;
  reason: string | null;
  before: number;
  after: number;
}

export interface RawExtraction {
  value: string | ListItem[] | null;
  checkpointId?: string;
  /** Sanitized description of where the value was read (label/table/row/column). */
  source: string;
}

export interface VerificationCheck {
  id: string;
  kind: string;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  accepted: boolean;
  data: Record<string, JsonValue>;
  checks: VerificationCheck[];
  /** Why the result cannot be accepted, in order of discovery. */
  reasons: string[];
}

export type JsonValue = string | number | boolean | ListItem[];

function isListItems(v: unknown): v is ListItem[] {
  return Array.isArray(v) && v.every((i) => !!i && typeof i === "object" && typeof (i as ListItem).text === "string" && typeof (i as ListItem).completed === "boolean");
}

export function coerce(type: FieldType, raw: string | ListItem[]): JsonValue | null {
  if (type === "list") return isListItems(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  switch (type) {
    case "string":
      return text;
    case "number": {
      const cleaned = text.replace(/[$,\s]/g, "");
      if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
      return Number(cleaned);
    }
    case "boolean": {
      const lower = text.toLowerCase();
      if (["true", "yes", "y", "active", "eligible"].includes(lower)) return true;
      if (["false", "no", "n", "inactive", "ineligible"].includes(lower)) return false;
      return null;
    }
    case "date":
      return toIsoDate(text);
  }
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function toIsoDate(text: string): string | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(text);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (m) return valid(Number(m[3]), Number(m[1]), Number(m[2]));
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(text);
  if (m) {
    const month = MONTHS[(m[1] ?? "").toLowerCase()];
    if (month) return valid(Number(m[3]), month, Number(m[2]));
  }
  return null;
}

function valid(y: number, mo: number, d: number): string | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

export function validateInput(schema: JsonSchemaObject, input: unknown): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["input must be an object"];
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (!(key in schema.properties)) errors.push(`unknown input '${key}'`);
  for (const key of schema.required) if (obj[key] === undefined || obj[key] === null || obj[key] === "") errors.push(`input '${key}' is required`);
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = obj[key];
    if (v === undefined) continue;
    if (prop.type === "string" && typeof v !== "string") errors.push(`input '${key}' must be a string`);
    if (prop.type === "string" && typeof v === "string" && prop.format === "date" && !toIsoDate(v)) errors.push(`input '${key}' must be an ISO date (YYYY-MM-DD)`);
    if (prop.type === "number" && typeof v !== "number") errors.push(`input '${key}' must be a number`);
    if (prop.type === "boolean" && typeof v !== "boolean") errors.push(`input '${key}' must be a boolean`);
  }
  return errors;
}

/**
 * Independent verification of a worker's extraction. This does not consult the model: every check is a
 * deterministic comparison between typed values, the caller's exact inputs and the reviewed assertions.
 */
export function verifyExtraction(
  def: AutomationDefinition,
  input: Record<string, JsonValue>,
  extraction: Record<string, RawExtraction>,
  observedAt: string,
  mutations: MutationCheck[] = []
): VerificationResult {
  const checks: VerificationCheck[] = [];
  const reasons: string[] = [];
  const data: Record<string, JsonValue> = {};

  // Every declared write must have been confirmed from the DOM by the worker's before/after comparison.
  for (const cp of def.checkpoints) {
    if (!cp.mutation) continue;
    const check = mutations.find((m) => m.checkpointId === cp.id);
    const passed = !!check && check.ok;
    const detail = check ? (check.ok ? `${check.kind} confirmed: ${check.before} -> ${check.after} items` : `${check.kind} not confirmed: ${check.reason ?? "unknown"}`) : "worker reported no mutation check";
    checks.push({ id: `mutation:${cp.id}`, kind: "mutation", passed, detail });
    if (!passed) reasons.push(`write at checkpoint '${cp.id}' ${detail}`);
  }

  for (const field of def.outputs) {
    if (field.extractor.kind === "observedAt") {
      data[field.name] = observedAt;
      continue;
    }
    const raw = extraction[field.name];
    const present = raw !== undefined && raw.value !== null && (typeof raw.value !== "string" || raw.value.trim() !== "");
    if (!present) {
      const detail = raw ? `no value found at ${raw.source}` : "worker reported no extraction for this output";
      checks.push({ id: `output:${field.name}`, kind: "extracted", passed: !field.required, detail });
      if (field.required) reasons.push(`required output '${field.name}' missing: ${detail}`);
      continue;
    }
    const typed = coerce(field.type, raw.value as string | ListItem[]);
    if (typed === null) {
      const detail = `observed text cannot be read as ${field.type}`;
      checks.push({ id: `output:${field.name}`, kind: "typed", passed: false, detail });
      reasons.push(`output '${field.name}' ${detail}`);
      continue;
    }
    data[field.name] = typed;
    checks.push({ id: `output:${field.name}`, kind: "typed", passed: true, detail: `${field.type} from ${raw.source}` });
  }

  def.assertions.forEach((assertion, i) => {
    const id = `assertion:${i}:${assertion.kind}`;
    switch (assertion.kind) {
      case "equalsInput": {
        const out = data[assertion.output];
        const inp = input[assertion.input];
        const passed = out !== undefined && inp !== undefined && String(out).trim().toUpperCase() === String(inp).trim().toUpperCase();
        checks.push({ id, kind: assertion.kind, passed, detail: passed ? `${assertion.output} matches input ${assertion.input}` : `${assertion.output}=${fmt(out)} does not match input ${assertion.input}=${fmt(inp)}` });
        if (!passed) reasons.push(`identity mismatch: ${assertion.output} does not equal input ${assertion.input}`);
        break;
      }
      case "required": {
        const passed = data[assertion.output] !== undefined;
        checks.push({ id, kind: assertion.kind, passed, detail: passed ? `${assertion.output} present` : `${assertion.output} missing` });
        if (!passed) reasons.push(`required output '${assertion.output}' missing`);
        break;
      }
      case "oneOf": {
        const v = data[assertion.output];
        const passed = v !== undefined && assertion.values.includes(String(v));
        checks.push({ id, kind: assertion.kind, passed, detail: passed ? `${assertion.output} in allowed set` : `${assertion.output}=${fmt(v)} not in [${assertion.values.join(", ")}]` });
        if (!passed) reasons.push(`output '${assertion.output}' outside allowed values`);
        break;
      }
      case "dateNotAfter": {
        const a = data[assertion.earlier];
        const b = data[assertion.later];
        const passed = typeof a === "string" && typeof b === "string" && a <= b;
        checks.push({ id, kind: assertion.kind, passed, detail: passed ? `${assertion.earlier} <= ${assertion.later}` : `${assertion.earlier}=${fmt(a)} is after ${assertion.later}=${fmt(b)}` });
        if (!passed) reasons.push(`date order violated: ${assertion.earlier} after ${assertion.later}`);
        break;
      }
      case "listContainsInput":
      case "listExcludesInput": {
        const list = data[assertion.output];
        const inp = input[assertion.input];
        const matches = isListItems(list) && typeof inp === "string" ? list.filter((i) => i.text.trim() === inp.trim()).length : -1;
        const passed = matches >= 0 && (assertion.kind === "listContainsInput" ? matches === 1 : matches === 0);
        const detail = matches < 0 ? `${assertion.output} is not a list or ${assertion.input} is not text` : `${matches} item(s) equal input ${assertion.input}`;
        checks.push({ id, kind: assertion.kind, passed, detail });
        if (!passed) reasons.push(`${assertion.kind}: ${assertion.output} has ${detail}`);
        break;
      }
    }
  });

  return { accepted: reasons.length === 0, data, checks, reasons };
}

const fmt = (v: unknown) => (v === undefined ? "<missing>" : JSON.stringify(v));
