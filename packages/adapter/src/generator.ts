import { canonicalJson, sha256 } from "./canonical.js";
import type { AutomationDefinition } from "@gateway/definition";
import type { RecordedEvent } from "@gateway/recorder";
import type { RecordingInput, GeneratedAdapter, UnsupportedStep } from "./types.js";

export const GENERATOR_ID = "pixie-recorded-adapter";
export const GENERATOR_VERSION = "1.0.0";

function stableLocator(event: RecordedEvent): Record<string, string> | undefined {
  const target = event.target;
  if (!target) return undefined;
  if (target.label) return { label: target.label };
  if (target.role && (target.name ?? target.text)) return { role: target.role, name: target.name ?? target.text! };
  if (target.name) return { name: target.name };
  if (target.id) return { id: target.id };
  if (target.text) return { text: target.text };
  const hint = target.selectorHints.find((value: string) => /^(#|[a-z][a-z0-9_-]*\[)/i.test(value));
  return hint ? { css: hint } : undefined;
}

function inputFor(definition: AutomationDefinition, event: RecordedEvent): string | undefined {
  const label = event.target?.label ?? event.target?.name ?? event.target?.text;
  return definition.inputs.find((field) => field.binding.targetLabel === label)?.name;
}

function locatorExpression(locator: Record<string, string>): string {
  return `locate(page, ${JSON.stringify(locator)})`;
}

function eventSource(event: RecordedEvent, definition: AutomationDefinition, unsupported: UnsupportedStep[]): string | undefined {
  const locator = stableLocator(event);
  if (event.kind === "navigate") return undefined;
  if (!locator) {
    unsupported.push({ seq: event.seq, kind: event.kind, reason: "recorded target has no stable semantic locator evidence" });
    return undefined;
  }
  const target = locatorExpression(locator);
  if (event.kind === "input") {
    const input = inputFor(definition, event);
    if (!input) {
      unsupported.push({ seq: event.seq, kind: event.kind, reason: "input event is not bound to a caller input" });
      return undefined;
    }
    return `await (await ${target}).fill(String(input[${JSON.stringify(input)}] ?? ""));`;
  }
  if (event.kind === "select") {
    if (!event.optionLabel) {
      unsupported.push({ seq: event.seq, kind: event.kind, reason: "select event has no recorded option label" });
      return undefined;
    }
    return `await (await ${target}).selectOption({ label: ${JSON.stringify(event.optionLabel)} });`;
  }
  if (event.kind === "keypress") return `await (await ${target}).press(${JSON.stringify(event.key ?? "Enter")});`;
  if (event.kind === "click" || event.kind === "submit") return `await (await ${target}).click();`;
  unsupported.push({ seq: event.seq, kind: event.kind, reason: event.reason ?? "event cannot be represented by the script engine" });
  return undefined;
}

export function generateAdapter(recording: RecordingInput, definition: AutomationDefinition): GeneratedAdapter {
  const unsupported: UnsupportedStep[] = [];
  const events = [...recording.events].sort((a, b) => a.seq - b.seq);
  const outputs = definition.outputs ?? [];
  const lists = Object.fromEntries(Object.entries(definition.lists ?? {}).map(([name, spec]) => [
    name,
    spec.fields === undefined ? spec : { ...spec, fields: { ...spec.fields } }
  ]));
  if (!outputs.length) unsupported.push({ seq: Number.MAX_SAFE_INTEGER, kind: "output", reason: "definition has no supported output locators" });
  const extractors = outputs.map((field) => {
    if (field.extractor.kind === "listItems" && !definition.lists?.[field.extractor.list]) {
      unsupported.push({
        seq: Number.MAX_SAFE_INTEGER,
        kind: "output",
        reason: `output '${field.name}' has no reviewed list locator`
      });
    }
    return field;
  });
  const body = events.flatMap((event) => {
    const line = eventSource(event, definition, unsupported);
    return line ? [`  ${line}`, "  await checkpoint(page);"] : [];
  });
  const source = unsupported.length ? "" : [
    `// ${GENERATOR_ID}@${GENERATOR_VERSION}`,
    `// definition-sha256: ${sha256(canonicalJson(definition))}`,
    'import { locate, checkpoint, extractOutputs } from "@gateway/adapter/runtime";',
    "",
    "export async function run(page, input) {",
    ...body,
    `  return await extractOutputs(page, ${JSON.stringify(extractors)}, ${JSON.stringify(lists)});`,
    "}",
    ""
  ].join("\n");
  return {
    source,
    hash: sha256(source),
    unsupported,
    generator: "recorded",
    generatorVersion: GENERATOR_VERSION
  };
}
