import { canonicalJson } from "./canonical.js";
import type { AutomationDefinition, InputField, OutputField } from "./types.js";

export type CompatibilityLevel = "major" | "minor" | "adapter";

export interface CompatibilityChange {
  path: string;
  kind: string;
}

export type CompatibilityDefinition = Pick<
  AutomationDefinition,
  "inputs" | "outputs" | "effect" | "assertions" | "allowedOrigins" | "limits"
> &
  Partial<Pick<AutomationDefinition, "repository" | "method" | "keyFields">>;

export interface CompatibilityResult {
  level: CompatibilityLevel;
  changes: CompatibilityChange[];
}

export function compatibility(prev: CompatibilityDefinition | null, next: CompatibilityDefinition): CompatibilityResult {
  if (!prev) return { level: "major", changes: [{ path: "contract", kind: "initial" }] };

  const changes: CompatibilityChange[] = [];
  compareFields("inputs", prev.inputs, next.inputs, changes);
  compareFields("outputs", prev.outputs, next.outputs, changes);
  compareContractValue("identity", prev.keyFields ?? [], next.keyFields ?? [], "identity_changed", changes);
  compareContractValue("operation.effect", prev.effect, next.effect, "effect_changed", changes);
  compareContractValue("operation.allowedOrigins", prev.allowedOrigins, next.allowedOrigins, "allowed_origins_changed", changes);
  compareContractValue("operation.limits", prev.limits, next.limits, "limits_changed", changes);
  compareContractValue("operation.checks", prev.assertions, next.assertions, "checks_changed", changes);
  compareContractValue("operation.repository", prev.repository, next.repository, "repository_changed", changes);
  compareContractValue("operation.method", prev.method, next.method, "method_changed", changes);

  const hasMajor = changes.some(({ kind }) => kind.endsWith("_major") || kind === "required_input_added" || kind === "output_added_required");
  if (hasMajor) return { level: "major", changes };
  if (changes.length) return { level: "minor", changes };
  return { level: "adapter", changes };
}

function compareFields(
  direction: "inputs" | "outputs",
  previous: (InputField | OutputField)[],
  next: (InputField | OutputField)[],
  changes: CompatibilityChange[]
) {
  const before = new Map(previous.map((field) => [field.name, field]));
  const after = new Map(next.map((field) => [field.name, field]));
  const isInput = direction === "inputs";
  const major = (path: string, kind: string) => changes.push({ path, kind: `${kind}_major` });

  for (const [name, oldField] of before) {
    const path = `${direction}.${name}`;
    const newField = after.get(name);
    if (!newField) {
      major(path, `field_removed`);
      continue;
    }
    if (oldField.type !== newField.type) major(`${path}.type`, "type_changed");
    if (oldField.description !== newField.description) major(`${path}.description`, "meaning_changed");
    if (oldField.required !== newField.required) {
      if (isInput && oldField.required && !newField.required) {
        changes.push({ path: `${path}.required`, kind: "input_became_optional" });
      } else {
        major(`${path}.required`, `${direction.slice(0, -1)}_requiredness_changed`);
      }
    }
  }

  for (const [name, field] of after) {
    if (before.has(name)) continue;
    if (isInput) {
      if (field.required) changes.push({ path: `${direction}.${name}`, kind: "required_input_added" });
      else changes.push({ path: `${direction}.${name}`, kind: "optional_input_added" });
    } else if (field.required) {
      changes.push({ path: `${direction}.${name}`, kind: "output_added_required" });
    } else {
      changes.push({ path: `${direction}.${name}`, kind: "optional_output_added" });
    }
  }
}

function compareContractValue(path: string, previous: unknown, next: unknown, kind: string, changes: CompatibilityChange[]) {
  if (canonicalJson(previous) !== canonicalJson(next)) changes.push({ path, kind: `${kind}_major` });
}
