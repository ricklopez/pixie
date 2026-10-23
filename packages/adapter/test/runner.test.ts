import assert from "node:assert/strict";
import { test } from "node:test";
import { runScript, scriptChildEnvironment } from "../src/runner.js";

const request = {
  source: "export async function run() { return {}; }\n",
  cdpUrl: "ws://127.0.0.1:1",
  input: { memberId: "DEMO-1001" },
  startUrl: "http://127.0.0.1:4174/demo-portal",
  allowedOrigins: ["http://127.0.0.1:4174"],
  maxActions: 5,
  deadlineMs: 1000
};

test("script child receives only its CDP URL, input, and output path", () => {
  const oldKey = process.env.OPENAI_API_KEY;
  const oldToken = process.env.GATEWAY_CLIENT_TOKEN;
  process.env.OPENAI_API_KEY = "must-not-be-forwarded";
  process.env.GATEWAY_CLIENT_TOKEN = "must-not-be-forwarded";
  try {
    const env = scriptChildEnvironment(request, "/tmp/adapter-result.json");
    assert.deepEqual(Object.keys(env).sort(), ["BU_CDP_URL", "PIXIE_SCRIPT_INPUT", "PIXIE_SCRIPT_OUTPUT"]);
    assert.deepEqual(env, {
      BU_CDP_URL: request.cdpUrl,
      PIXIE_SCRIPT_INPUT: JSON.stringify(request.input),
      PIXIE_SCRIPT_OUTPUT: "/tmp/adapter-result.json"
    });
    assert.doesNotMatch(JSON.stringify(env), /must-not-be-forwarded/);
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    if (oldToken === undefined) delete process.env.GATEWAY_CLIENT_TOKEN;
    else process.env.GATEWAY_CLIENT_TOKEN = oldToken;
  }
});

test("script runner rejects an origin outside its allowlist before connecting", async () => {
  const result = await runScript({ ...request, allowedOrigins: ["https://example.test"] });
  assert.match(result.error ?? "", /navigation origin is not allowed/);
  assert.equal(result.providerCalls, 0);
});
