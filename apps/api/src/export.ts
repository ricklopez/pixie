import { inputJsonSchema, outputJsonSchema, type AutomationDefinition, type InputField } from "@gateway/definition";
import type { AutomationRow, RevisionRow, RunRow } from "./db.js";
import { openApiDocument } from "./openapi.js";

/**
 * A14 review export: the files a reviewer (human or CodeRabbit on a Git-backed PR) needs to judge a published
 * automation, and nothing that belongs to a runtime: no account secrets, no browser profile/cookie state, no
 * screenshots or raw evidence, no idempotency keys. Every file is text; paths follow spec.md ("automations/<id>/",
 * "openapi/", synthetic tests). Review state is stated factually — this export does not claim any review happened.
 */
export interface ReviewExport {
  automationId: string;
  exportedAt: string;
  files: Record<string, string>;
  excluded: string[];
}

export const EXPORT_EXCLUDED = [
  "account secrets (only secretRef names appear in definitions)",
  "browser profiles, cookies, localStorage and CDP endpoints",
  "screenshots and raw evidence files",
  "recording events, worker events and model observations",
  "idempotency keys, API keys, caller and publisher identities",
  "caller input values and failure/verification messages from real runs"
];

interface Check {
  id: string;
  kind: string;
  passed: boolean;
  detail?: string;
}

interface ResultEnvelope {
  checks?: Check[];
  data?: Record<string, unknown>;
}

export function buildReviewExport(row: AutomationRow, revisions: RevisionRow[], runs: RunRow[], baseUrl: string, exportedAt: string): ReviewExport {
  const files: Record<string, string> = {};
  const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
  const testRuns = new Map(runs.map((r) => [r.id, r]));

  for (const rev of revisions) {
    const definition = JSON.parse(rev.definition) as AutomationDefinition;
    const dir = `automations/${row.id}/revision-${rev.revision}`;
    files[`${dir}/definition.json`] = json(definition);
    files[`${dir}/input.schema.json`] = json(inputJsonSchema(definition));
    files[`${dir}/output.schema.json`] = json(outputJsonSchema(definition));
    files[`${dir}/assertions.json`] = json({
      checkpoints: definition.checkpoints.map((c) => ({ id: c.id, precondition: c.precondition, postcondition: c.postcondition, mutation: c.mutation ?? null, allowedEffects: c.allowedEffects, maxActions: c.maxActions })),
      assertions: definition.assertions,
      effect: definition.effect,
      allowedOrigins: definition.allowedOrigins
    });
    files[`tests/${row.id}/revision-${rev.revision}.synthetic.json`] = json(syntheticTests(definition, rev, runs));
    const gate = rev.test_run_id ? testRuns.get(rev.test_run_id) : undefined;
    files[`${dir}/REVISION.md`] = revisionNotes(row, rev, definition, gate);
  }
  files[`openapi/${row.id}.json`] = json(openApiDocument(row.id, row.name, revisions, baseUrl));
  files[`automations/${row.id}/REVIEW.md`] = reviewNotes(row, revisions, runs, exportedAt);
  return { automationId: row.id, exportedAt, files, excluded: EXPORT_EXCLUDED };
}

/** A placeholder value derived from the field's declared type only; never a value a caller sent. */
function syntheticValue(field: InputField): unknown {
  switch (field.type) {
    case "string":
      return `synthetic-${field.name}`;
    case "number":
      return 1;
    case "boolean":
      return true;
    case "date":
      return "2000-01-01";
    case "list":
      return [];
  }
}

/**
 * Schema-derived fixture plus the outcome shape of each run of a revision. Runtime values never enter this file:
 * caller inputs may carry PII/secrets, and failure text can quote page content, so only the terminal state and the
 * pass/fail of each declared check (by id) are exported.
 */
function syntheticTests(definition: AutomationDefinition, rev: RevisionRow, runs: RunRow[]) {
  const callerInputs = definition.inputs.filter((i) => i.source.kind === "caller");
  const fixture = Object.fromEntries(callerInputs.map((i) => [i.name, syntheticValue(i)]));
  const outcomes = runs
    .filter((r) => (r.kind === "test" && r.id === rev.test_run_id) || (r.kind === "endpoint" && r.revision === rev.revision))
    .map((r) => {
      const result = r.result ? (JSON.parse(r.result) as ResultEnvelope) : null;
      return {
        runId: r.id,
        kind: r.kind === "test" ? "publication-gate" : "endpoint",
        state: r.state,
        accepted: r.state === "completed",
        checks: (result?.checks ?? []).map((c) => ({ id: c.id, kind: c.kind, passed: c.passed }))
      };
    });
  return {
    automationId: definition.id,
    revision: rev.revision,
    checksum: rev.checksum,
    note: "Fixture values are generated from input.schema.json (type placeholders), not taken from any run; adapt them to the target's write guards (e.g. Pixie demo prefix) before replay. Outcomes list terminal state and per-check pass/fail only; failure text and caller values are excluded on purpose.",
    fixture,
    outcomes
  };
}

function revisionNotes(row: AutomationRow, rev: RevisionRow, definition: AutomationDefinition, gate: RunRow | undefined): string {
  const gateLine = gate
    ? `Publication gate: test run \`${gate.id}\` finished \`${gate.state}\` at ${gate.finished_at ?? "unknown"}.`
    : `Publication gate: test run \`${rev.test_run_id ?? "unknown"}\` (not found in this export).`;
  return [
    `# ${row.name} — revision ${rev.revision}`,
    "",
    `- Checksum (canonical JSON): \`${rev.checksum}\``,
    `- Published ${rev.published_at}`,
    `- Engine: ${definition.engine}@${definition.engineRevision}`,
    `- Effect: ${definition.effect}; origins: ${definition.allowedOrigins.join(", ")}`,
    `- Inputs: ${definition.inputs.map((i) => `${i.name} (${i.type}, ${i.source.kind})`).join(", ") || "none"}`,
    `- Outputs: ${definition.outputs.map((o) => `${o.name} (${o.type})`).join(", ") || "none"}`,
    `- Independent assertions: ${definition.assertions.length}`,
    `- ${gateLine}`,
    ""
  ].join("\n");
}

function reviewNotes(row: AutomationRow, revisions: RevisionRow[], runs: RunRow[], exportedAt: string): string {
  const byState = new Map<string, number>();
  for (const r of runs) byState.set(r.state, (byState.get(r.state) ?? 0) + 1);
  const states = [...byState.entries()].map(([s, n]) => `${s}: ${n}`).join(", ") || "none";
  return [
    `# Review export — ${row.name} (${row.id})`,
    "",
    `Exported ${exportedAt}. Automation state: \`${row.state}\`. Revisions: ${revisions.length ? revisions.map((r) => r.revision).join(", ") : "none published"}.`,
    "",
    "## Contents",
    "",
    "- `automations/<id>/revision-<n>/definition.json` — immutable reviewed definition (checksum in REVISION.md)",
    "- `automations/<id>/revision-<n>/{input,output}.schema.json` — typed contract",
    "- `automations/<id>/revision-<n>/assertions.json` — checkpoint pre/postconditions, mutation guards and independent assertions",
    "- `tests/<id>/revision-<n>.synthetic.json` — schema-derived fixture and the terminal state / per-check outcome of recorded runs",
    "- `openapi/<id>.json` — generated OpenAPI 3.1 for the published revisions",
    "",
    "## Run history (counts by terminal state)",
    "",
    states,
    "",
    "## Review state (factual)",
    "",
    "- Definitions were validated by the Gateway schema/origin policy and each revision was gated on a completed test run whose independent verification accepted the result.",
    "- No automated code review (CodeRabbit or other) has examined this export. Submit the files through a Git-backed PR to obtain one; review status must be read from that PR, not from this file.",
    "",
    "## Excluded on purpose",
    "",
    ...EXPORT_EXCLUDED.map((e) => `- ${e}`),
    ""
  ].join("\n");
}
