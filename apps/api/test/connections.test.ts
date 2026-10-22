import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiKey } from "../src/auth.js";
import { now } from "../src/db.js";
import { call, testApp, TOKENS } from "./helpers.js";

test("connection handoff input is exclusive and hidden from client tokens", async () => {
  const { app, db } = await testApp();
  const otherDeveloper = createApiKey(db, "tenant_demo", "another developer", "developer", "other-developer-token");
  const controller = db.prepare(`SELECT id FROM api_keys WHERE role = 'developer' AND token_hash != (SELECT token_hash FROM api_keys WHERE role = 'developer' AND name = 'another developer') LIMIT 1`).get() as { id: string };
  db.prepare(`INSERT INTO accounts (id, tenant_id, name, portal_origin, provider, environment, created_at) VALUES (?, ?, ?, ?, 'browserbase', ?, ?)`)
    .run("acct_browserbase", "tenant_demo", "Browserbase account", "https://example.test", "production", now());
  db.prepare(`INSERT INTO connections (id, account_id, environment, provider, context_id, state, controller_key_id) VALUES (?, ?, ?, 'browserbase', ?, 'connecting', ?)`)
    .run("connection-test", "acct_browserbase", "production", "context-secret", controller.id);
  try {
    const forbidden = await call(app, otherDeveloper.token, "POST", "/studio/connections/connection-test/input", { type: "key", event: "keyDown", key: "x" });
    assert.equal(forbidden.status, 403);
    const hidden = await call(app, TOKENS.client, "POST", "/studio/connections/connection-test/input", { type: "key", event: "keyDown", key: "x" });
    assert.equal(hidden.status, 404);
    const details = await call(app, TOKENS.developer, "GET", "/studio/connections/connection-test");
    assert.equal(details.status, 200);
    const serialized = JSON.stringify({ details: details.json, rows: db.prepare(`SELECT * FROM connections`).all() });
    assert.doesNotMatch(serialized, /connectUrl|wss:\/\/|liveViewUrl/);
  } finally {
    await app.close();
    db.close();
  }
});
