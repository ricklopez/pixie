import assert from "node:assert/strict";
import test from "node:test";
import { hackerNewsFrontPageDefinition } from "@gateway/definition";
import { generateAdapter } from "../src/index.js";

const definition = {
  name: "recorded",
  startUrl: "http://127.0.0.1:4174",
  allowedOrigins: ["http://127.0.0.1:4174"],
  inputs: [{ name: "memberId", type: "string", required: true, binding: { targetLabel: "Member ID" } }],
  outputs: [{ name: "observedAt", type: "date", required: true, extractor: { kind: "observedAt" } }],
  assertions: [],
  effect: "read",
  authRequiredSignals: [],
  limits: { deadlineMs: 1000, maxActions: 10 },
  engine: "jev-ultrafast",
  engineRevision: "test"
} as never;

const recording = {
  events: [
    { seq: 1, at: 0, kind: "input", url: "http://127.0.0.1:4174", target: { tag: "input", role: "textbox", label: "Member ID", name: "memberId", id: null, placeholder: null, inputType: "text", text: null, selectorHints: [] }, hasValue: true, valueLength: 4 },
    { seq: 2, at: 1, kind: "click", url: "http://127.0.0.1:4174", target: { tag: "button", role: "button", label: null, name: "Search", id: null, placeholder: null, inputType: null, text: "Search", selectorHints: [] } }
  ]
} as never;

test("adapter generation is deterministic and parameterized", () => {
  const first = generateAdapter(recording, definition);
  const second = generateAdapter(recording, definition);
  assert.equal(first.source, second.source);
  assert.equal(first.hash, second.hash);
  assert.match(first.source, /input\["memberId"\]/);
  assert.match(first.source, /extractOutputs/);
  assert.equal(first.unsupported.length, 0);
});

test("unsupported events fail closed", () => {
  const generated = generateAdapter({ events: [{ seq: 1, at: 0, kind: "unsupported", url: "", reason: "popup" }] } as never, definition);
  assert.equal(generated.unsupported.length, 1);
  assert.equal(generated.source, "");
});

test("missing output locators are reported instead of producing a partial adapter", () => {
  const generated = generateAdapter(recording, { ...definition, outputs: [] } as never);
  assert.equal(generated.source, "");
  assert.equal(generated.unsupported[0]?.kind, "output");
});

test("a zero-action recording generates an extraction adapter with reviewed list fields", () => {
  const generated = generateAdapter({ events: [] }, hackerNewsFrontPageDefinition());
  assert.equal(generated.unsupported.length, 0);
  assert.match(generated.source, /extractOutputs/);
  assert.match(generated.source, /"fields"/);
  assert.match(generated.source, /"id":\{"attribute":"id"\}/);
});
