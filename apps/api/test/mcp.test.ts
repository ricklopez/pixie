import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import SwaggerParser from "@apidevtools/swagger-parser";
import { TOKENS, call, publishEligibility, testApp } from "./helpers.js";

function result<T>(response: { content: { type: string; text?: string }[] }): T {
  return JSON.parse(response.content.find((item) => item.type === "text")?.text ?? "null") as T;
}

test("MCP tools share published operation behavior with REST", async () => {
  const built = await testApp();
  const address = await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = address.replace(/\/$/, "");
  const makeClient = async (token: string) => {
    const client = new Client({ name: "offline-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    }));
    return client;
  };
  try {
    const { id } = await publishEligibility(built.app, built.runs);
    const client = await makeClient(TOKENS.client);
    try {
      const listed = result<{ id: string; latestRevision: number }[]>(await client.callTool({ name: "list_operations", arguments: {} }));
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, id);
      assert.equal(listed[0]?.latestRevision, 1);
      const otherTenant = await makeClient(TOKENS.otherTenantClient);
      try {
        assert.deepEqual(result(await otherTenant.callTool({ name: "list_operations", arguments: {} })), []);
      } finally {
        await otherTenant.close();
      }

      const started = result<{ runId: string; state: string }>(await client.callTool({
        name: "invoke", arguments: { automationId: id, input: { memberId: "DEMO-1001" }, accountId: "acct_demo", idempotencyKey: "mcp-replay" }
      }));
      assert.ok(started.runId);
      assert.ok(["queued", "running", "verifying", "completed"].includes(started.state));
      const replay = result<{ runId: string }>(await client.callTool({
        name: "invoke", arguments: { automationId: id, input: { memberId: "DEMO-1001" }, accountId: "acct_demo", idempotencyKey: "mcp-replay" }
      }));
      assert.equal(replay.runId, started.runId);

      let fetched: { state: string; result?: unknown } = { state: started.state };
      for (let n = 0; n < 50; n += 1) {
        fetched = result(await client.callTool({ name: "get_run", arguments: { automationId: id, runId: started.runId } }));
        if (fetched.state === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(fetched.state, "completed");
      const restResult = await call(built.app, TOKENS.client, "GET", `/v1/automations/${id}/runs/${started.runId}/result`);
      assert.deepEqual(fetched.result, restResult.json);

      const restStart = await call(built.app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision: 1, accountId: "acct_demo", input: { memberId: "DEMO-1002" } });
      await built.runs.waitForTerminal(restStart.json.id!);
      const fromRest = result<{ result?: unknown }>(await client.callTool({ name: "get_run", arguments: { automationId: id, runId: restStart.json.id } }));
      const restValue = await call(built.app, TOKENS.client, "GET", `/v1/automations/${id}/runs/${restStart.json.id}/result`);
      assert.deepEqual(fromRest.result, restValue.json);

      const awaiting = result<{ runId: string }>(await client.callTool({
        name: "invoke", arguments: { automationId: id, input: { memberId: "DEMO-LOGIN" }, accountId: "acct_demo" }
      }));
      await built.runs.waitForTerminal(awaiting.runId);
      built.db.prepare(`UPDATE runs SET connection_id = 'connection-test' WHERE id = ?`).run(awaiting.runId);
      const handoff = result<{ state: string; handoffUrl?: string; message?: string }>(await client.callTool({
        name: "get_run", arguments: { automationId: id, runId: awaiting.runId }
      }));
      assert.equal(handoff.state, "awaiting_auth");
      assert.match(handoff.handoffUrl ?? "", /5173\/#\/connections\/connection-test/);
      assert.match(handoff.message ?? "", /human must sign in/);
      assert.doesNotMatch(handoff.handoffUrl ?? "", /browserbase|connectUrl|live-view/i);

      const invalid = await client.callTool({ name: "invoke", arguments: { automationId: id, accountId: "acct_demo", input: {} } });
      assert.equal(invalid.isError, true);
      assert.match(invalid.content[0]?.text ?? "", /invalid input/);
      const crossTenant = await makeClient(TOKENS.otherTenantClient);
      try {
        const hidden = await crossTenant.callTool({ name: "get_run", arguments: { automationId: id, runId: started.runId } });
        assert.equal(hidden.isError, true);
        assert.match(hidden.content[0]?.text ?? "", /not found/);
      } finally {
        await crossTenant.close();
      }
    } finally {
      await client.close();
    }
    for (const [token, status] of [["", 401], ["bad", 401], [TOKENS.developer, 403]] as const) {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } })
      });
      assert.equal(response.status, status);
      assert.equal((await response.json() as { jsonrpc: string }).jsonrpc, "2.0");
    }
    const openapi = await call(built.app, TOKENS.client, "GET", `/v1/automations/${id}/openapi.json`);
    await SwaggerParser.validate(openapi.json as object);
    assert.ok((openapi.json as { paths: Record<string, unknown> }).paths["/v1/automations/" + id + "/runs/{runId}/evidence"]);
  } finally {
    await built.app.close();
  }
});
