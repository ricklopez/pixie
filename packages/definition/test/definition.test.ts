import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  compatibility,
  definitionChecksum,
  eligibilityOverviewDefinition,
  hackerNewsFrontPageDefinition,
  HN_ORIGIN,
  inputJsonSchema,
  outputJsonSchema,
  suggestFromRecording,
  TODO_TEMPLATES,
  todoDefinition,
  todoScript,
  validateDefinition,
  validateInput,
  verifyExtraction,
  type RawExtraction
} from "../src/index.js";

const def = eligibilityOverviewDefinition();

test("reference definition validates and has a stable checksum", async () => {
  const result = validateDefinition(def, { allowLoopback: true });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(def.keyFields, ["memberId"]);
  const a = await definitionChecksum(def);
  const b = await definitionChecksum(JSON.parse(JSON.stringify({ ...def, name: def.name })));
  assert.equal(a, b);
  const changed = await definitionChecksum({ ...def, name: "Renamed" });
  assert.notEqual(a, changed);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
});

test("Todo templates use the exact list-item text identity", () => {
  for (const template of TODO_TEMPLATES) {
    const definition = todoDefinition(template);
    assert.deepEqual(definition.keyFields, ["tasks.text"]);
    const result = validateDefinition(definition, { allowLoopback: true });
    assert.ok(result.ok, `${template}: ${JSON.stringify(result)}`);
  }
});

test("Hacker News front-page definition validates with read-only identity and list fields", () => {
  const hn = hackerNewsFrontPageDefinition();
  const result = validateDefinition(hn);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(hn.id, "hn-front-page");
  assert.equal(hn.name, "Hacker News front page");
  assert.equal(hn.startUrl, `${HN_ORIGIN}/news`);
  assert.deepEqual(hn.allowedOrigins, [HN_ORIGIN]);
  assert.deepEqual(hn.keyFields, ["stories.fields.id"]);
  assert.deepEqual(hn.checkpoints[0]?.allowedEffects, []);
  assert.deepEqual(todoScript(hn, {}), [{ operation: "DONE" }]);
  assert.match(JSON.stringify(outputJsonSchema(hn)), /"fields"/);
});

test("loopback origins are rejected unless the synthetic exception is enabled", () => {
  const strict = validateDefinition(def);
  assert.ok(!strict.ok && strict.issues.some((i) => i.path.startsWith("allowedOrigins")));
  const http = validateDefinition({ ...def, startUrl: "http://example.com/x", allowedOrigins: ["http://example.com"] });
  assert.ok(!http.ok && http.issues.some((i) => /https/.test(i.message)));
  const priv = validateDefinition({ ...def, startUrl: "https://10.0.0.1/x", allowedOrigins: ["https://10.0.0.1"] });
  assert.ok(!priv.ok && priv.issues.some((i) => /private-network/.test(i.message)));
});

test("definitions require an identity assertion and known bindings", () => {
  const noIdentity = validateDefinition({ ...def, assertions: def.assertions.filter((a) => a.kind !== "equalsInput") }, { allowLoopback: true });
  assert.ok(!noIdentity.ok && noIdentity.issues.some((i) => /identity/.test(i.message)));
  const badBinding = validateDefinition({ ...def, inputs: [{ ...def.inputs[0]!, binding: { checkpointId: "nope", targetLabel: "Member ID" } }] }, { allowLoopback: true });
  assert.ok(!badBinding.ok && badBinding.issues.some((i) => i.path === "inputs[0].binding.checkpointId"));
  const badType = validateDefinition({ ...def, outputs: [{ ...def.outputs[0]!, type: "money" }] }, { allowLoopback: true });
  assert.ok(!badType.ok && badType.issues.some((i) => i.path === "outputs[0].type"));
});

test("json schemas follow the typed fields", () => {
  const input = inputJsonSchema(def);
  assert.deepEqual(input.required, ["memberId"]);
  assert.deepEqual(validateInput(input, { memberId: "DEMO-1002" }), []);
  assert.ok(validateInput(input, {}).length);
  assert.ok(validateInput(input, { memberId: "x", extra: 1 }).some((e) => /unknown input/.test(e)));
  const output = outputJsonSchema(def);
  assert.deepEqual(output.properties.observedAt, { type: "string", format: "date-time" });
  assert.deepEqual(output.properties.effectiveFrom, { type: "string", format: "date" });
});

test("compatibility classifies initial, optional, required, removed, and semantic contract changes", () => {
  const baseline = {
    inputs: [{ name: "memberId", type: "string" as const, required: true, source: { kind: "caller" as const }, binding: { checkpointId: "search", targetLabel: "Member ID" } }],
    outputs: [{ name: "status", type: "string" as const, required: true, extractor: { kind: "labelValue" as const, checkpointId: "result", label: "Status" } }],
    effect: "read" as const,
    assertions: [{ kind: "required" as const, output: "status" }],
    allowedOrigins: ["https://portal.example"],
    limits: { maxActions: 5, deadlineMs: 10_000 },
    keyFields: ["status"]
  };
  const result = (next: typeof baseline) => compatibility(baseline, next);

  assert.deepEqual(compatibility(null, baseline), { level: "major", changes: [{ path: "contract", kind: "initial" }] });
  assert.equal(result({ ...baseline, outputs: [...baseline.outputs, { name: "note", type: "string", required: false, extractor: { kind: "labelValue", checkpointId: "result", label: "Note" } }] }).level, "minor");
  assert.deepEqual(result({ ...baseline, inputs: [...baseline.inputs, { name: "region", type: "string", required: false, source: { kind: "caller" }, binding: { checkpointId: "search", targetLabel: "Region" } }] }).level, "minor");
  assert.equal(result({ ...baseline, inputs: [...baseline.inputs, { name: "region", type: "string", required: true, source: { kind: "caller" }, binding: { checkpointId: "search", targetLabel: "Region" } }] }).level, "major");
  assert.equal(result({ ...baseline, outputs: [] }).level, "major");
  assert.equal(result({ ...baseline, outputs: [{ ...baseline.outputs[0]!, type: "number" }] }).level, "major");
  assert.equal(result({ ...baseline, outputs: [{ ...baseline.outputs[0]!, description: "A different status meaning" }] }).level, "major");
  assert.equal(result({ ...baseline, inputs: [{ ...baseline.inputs[0]!, required: false }] }).level, "minor");
  assert.equal(result({ ...baseline, inputs: [{ ...baseline.inputs[0]!, required: false, type: "number" }] }).level, "major");
  assert.equal(result({ ...baseline, outputs: [{ ...baseline.outputs[0]!, required: false }] }).level, "major");
  assert.equal(result({ ...baseline, keyFields: ["memberId"] }).level, "major");
  assert.equal(result({ ...baseline, effect: "write" }).level, "major");
  assert.equal(result({ ...baseline, assertions: [] }).level, "major");
  assert.equal(result({ ...baseline, allowedOrigins: ["https://other.example"] }).level, "major");
  assert.equal(result({ ...baseline, limits: { maxActions: 6, deadlineMs: 10_000 } }).level, "major");
});

test("compatibility treats implementation-only changes as adapter revisions", () => {
  const contract = {
    inputs: [],
    outputs: [{ name: "status", type: "string" as const, required: true, extractor: { kind: "labelValue" as const, checkpointId: "result", label: "Status" } }],
    effect: "read" as const,
    assertions: [],
    allowedOrigins: ["https://portal.example"],
    limits: { maxActions: 5, deadlineMs: 10_000 }
  };
  assert.deepEqual(compatibility(contract, { ...contract, outputs: [{ ...contract.outputs[0]!, extractor: { ...contract.outputs[0]!.extractor, label: "Status text" } }] }), {
    level: "adapter",
    changes: []
  });
});

const observedAt = "2026-09-26T12:00:00.000Z";
const good: Record<string, RawExtraction> = {
  memberId: { value: "DEMO-1002", source: "label Member ID" },
  eligibilityStatus: { value: "Active", source: "label" },
  plan: { value: "Synthetic HMO Plus", source: "label" },
  effectiveFrom: { value: "2026-03-01", source: "label" },
  effectiveTo: { value: "2027-02-28", source: "label" },
  portalAsOf: { value: "2026-09-24", source: "label" },
  annualMaximum: { value: "$2,000.00", source: "table" },
  annualMaximumRemaining: { value: "$650.00", source: "table" },
  annualMaximumPeriod: { value: "Plan year", source: "table" },
  deductible: { value: "$75.00", source: "table" },
  deductibleRemaining: { value: "$25.00", source: "table" },
  deductibleNetwork: { value: "In network", source: "table" }
};

test("verification accepts a correct typed extraction", () => {
  const v = verifyExtraction(def, { memberId: "DEMO-1002" }, good, observedAt);
  assert.ok(v.accepted, v.reasons.join("; "));
  assert.equal(v.data.annualMaximum, 2000);
  assert.equal(v.data.deductibleRemaining, 25);
  assert.equal(v.data.observedAt, observedAt);
  assert.equal(v.data.effectiveTo, "2027-02-28");
});

test("verification rejects wrong identity without touching the extraction", () => {
  const v = verifyExtraction(def, { memberId: "DEMO-2001" }, { ...good, memberId: { value: "DEMO-2002", source: "label" } }, observedAt);
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.some((r) => /identity mismatch/.test(r)));
  assert.equal(v.checks.find((c) => c.kind === "equalsInput")?.passed, false);
});

test("verification rejects missing required outputs and never fabricates defaults", () => {
  const partial = { ...good, eligibilityStatus: { value: "", source: "label" } } as Record<string, RawExtraction>;
  delete partial.deductible;
  const v = verifyExtraction(def, { memberId: "DEMO-1002" }, partial, observedAt);
  assert.equal(v.accepted, false);
  assert.ok(!("deductible" in v.data));
  assert.ok(!("eligibilityStatus" in v.data));
  assert.ok(v.reasons.some((r) => /required output 'deductible' missing/.test(r)));
  const badNumber = verifyExtraction(def, { memberId: "DEMO-1002" }, { ...good, deductible: { value: "n/a", source: "table" } }, observedAt);
  assert.ok(!badNumber.accepted && !("deductible" in badNumber.data));
});

test("list size and unique-field assertions accept valid items and reject short, duplicate, and null fields", () => {
  const hn = hackerNewsFrontPageDefinition();
  const item = (id: string | null) => ({ text: `story-${id}`, completed: false, fields: { id } });
  const verifyStories = (items: ReturnType<typeof item>[]) =>
    verifyExtraction(hn, {}, { stories: { value: items, source: "list stories" } }, observedAt);
  const tenUnique = Array.from({ length: 10 }, (_, i) => item(String(i)));

  assert.equal(verifyStories(tenUnique).accepted, true);
  const nine = verifyStories(tenUnique.slice(0, 9));
  assert.equal(nine.accepted, false);
  assert.equal(nine.checks.find((check) => check.kind === "listMinItems")?.passed, false);
  const duplicate = verifyStories([...tenUnique.slice(0, 9), item("0")]);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.checks.find((check) => check.kind === "listUniqueField")?.passed, false);
  const missing = verifyStories([...tenUnique.slice(0, 9), item(null)]);
  assert.equal(missing.accepted, false);
  assert.equal(missing.checks.find((check) => check.kind === "listUniqueField")?.passed, false);
});

test("recording review proposes checkpoints and inputs without values", () => {
  const s = suggestFromRecording([
    { seq: 1, kind: "navigate", url: "http://127.0.0.1:4174/demo-portal" },
    { seq: 2, kind: "input", url: "http://127.0.0.1:4174/demo-portal", target: { label: "Member ID", name: "memberId", placeholder: null, inputType: "text", tag: "INPUT" } },
    { seq: 3, kind: "click", url: "http://127.0.0.1:4174/demo-portal", target: { label: null, name: null, placeholder: null, inputType: null, tag: "BUTTON" } },
    { seq: 4, kind: "navigate", url: "http://127.0.0.1:4174/demo-portal/members?memberId=%3Credacted%3E" },
    { seq: 5, kind: "unsupported", url: "http://127.0.0.1:4174/demo-portal/members" }
  ]);
  assert.equal(s.checkpoints.length, 2);
  assert.equal(s.inputs[0]?.name, "memberId");
  assert.equal(s.inputs[0]?.binding.targetLabel, "Member ID");
  assert.deepEqual(s.checkpoints[0]?.allowedEffects, ["type", "click"]);
  assert.equal(s.unbound.length, 1);
  assert.ok(!JSON.stringify(s).includes("DEMO-"));
});
