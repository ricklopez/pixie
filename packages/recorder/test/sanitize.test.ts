import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeEvent, sanitizeUrl } from "../src/sanitize.js";

test("query values and fragments are redacted", () => {
  assert.equal(sanitizeUrl("http://127.0.0.1:4174/demo-portal/members?memberId=DEMO-1001#x"), "http://127.0.0.1:4174/demo-portal/members?memberId=%3Credacted%3E");
  assert.equal(sanitizeUrl("http://user:pw@host/path"), "http://host/path");
});

test("input events keep presence and length but never the value", () => {
  const { event } = sanitizeEvent(
    { kind: "input", url: "http://a/b", isMainFrame: true, hasValue: true, valueLength: 9, target: { tag: "input", label: "Member ID", inputType: "text", selectorHints: ["label=Member ID"] } },
    1,
    10
  );
  assert.equal(event.kind, "input");
  assert.equal(event.valueLength, 9);
  assert.ok(!JSON.stringify(event).includes("DEMO"));
});

test("subframe, uploads and unknown events are recorded as unsupported with warnings", () => {
  const sub = sanitizeEvent({ kind: "click", url: "http://a/", isMainFrame: false }, 1, 0);
  assert.equal(sub.event.kind, "unsupported");
  assert.equal(sub.warning?.code, "subframe");
  const upload = sanitizeEvent({ kind: "input", url: "http://a/", isMainFrame: true, target: { tag: "input", inputType: "file" } }, 2, 0);
  assert.equal(upload.warning?.code, "file-upload");
  const drag = sanitizeEvent({ kind: "dragstart", url: "http://a/", isMainFrame: true }, 3, 0);
  assert.equal(drag.warning?.code, "unsupported-event");
});

test("password field text is dropped", () => {
  const { event } = sanitizeEvent({ kind: "input", url: "http://a/", isMainFrame: true, target: { tag: "input", inputType: "password", text: "secret" } }, 1, 0);
  assert.equal(event.target?.text, null);
});
