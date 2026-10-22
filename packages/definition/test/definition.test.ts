import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  definitionChecksum,
  eligibilityOverviewDefinition,
  inputJsonSchema,
  outputJsonSchema,
  suggestFromRecording,
  validateDefinition,
  validateInput,
  verifyExtraction,
  type RawExtraction
} from "../src/index.js";

const def = eligibilityOverviewDefinition();

test("reference definition validates and has a stable checksum", async () => {
  const result = validateDefinition(def, { allowLoopback: true });
  assert.ok(result.ok, JSON.stringify(result));
  const a = await definitionChecksum(def);
  const b = await definitionChecksum(JSON.parse(JSON.stringify({ ...def, name: def.name })));
  assert.equal(a, b);
  const changed = await definitionChecksum({ ...def, name: "Renamed" });
  assert.notEqual(a, changed);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
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
