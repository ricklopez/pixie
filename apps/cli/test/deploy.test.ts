import assert from "node:assert/strict";
import { test } from "node:test";
import { MockRenderProvider, RenderProvider, runDeployCommand } from "../src/deploy.js";

function capture() {
  const lines: string[] = [];
  return { lines, out: { log: (value: string) => lines.push(value), error: (value: string) => lines.push(`ERR ${value}`) } };
}

test("deploy services prints service names only and runtime refuses without opt-in flags", async () => {
  const provider = new MockRenderProvider([{ id: "srv-1", name: "runtime", type: "web_service" }]);
  const output = capture();
  assert.equal(await runDeployCommand("services", provider, {}, output.out), 0);
  assert.deepEqual(output.lines, ["runtime"]);
  const refused = capture();
  assert.equal(await runDeployCommand("runtime", provider, {}, refused.out), 1);
  assert.match(refused.lines[0] ?? "", /PIXIE_RENDER_SERVICE_ID/);
  assert.deepEqual(provider.calls, ["listServices"]);
});

test("mock Render provider lists, deploys and reports status", async () => {
  const env = { PIXIE_RENDER_SERVICE_ID: "srv-runtime", PIXIE_ALLOW_RENDER_DEPLOY: "1" };
  const provider = new MockRenderProvider(undefined, env);
  assert.equal((await provider.listServices())[0]?.name, "pixie-runtime");
  const output = capture();
  assert.equal(await runDeployCommand("runtime", provider, env, output.out), 0);
  const deployment = provider.deploys.get("srv-runtime")!;
  assert.equal(deployment.status, "created");
  assert.equal(await runDeployCommand("status", provider, env, output.out), 0);
  assert.deepEqual(output.lines, [`${deployment.id} ${deployment.status}`, `${deployment.id} ${deployment.status}`]);
  await assert.rejects(new MockRenderProvider([], env).triggerDeploy("srv-runtime"), /service not found/);
});

test("Render provider uses the documented read endpoints and gates deploy mutations", async () => {
  const calls: { url: string; method: string }[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method });
    const value = url.endsWith("/services?limit=20")
      ? [{ service: { id: "srv-1", name: "runtime", type: "web_service" } }]
      : url.endsWith("/services/srv-1/deploys?limit=1")
        ? [{ id: "dep-1", status: "live" }]
        : method === "POST"
          ? { id: "dep-2", status: "created" }
          : { id: "srv-1", name: "runtime", type: "web_service" };
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  };
  const env = { PIXIE_RENDER_SERVICE_ID: "srv-1", PIXIE_ALLOW_RENDER_DEPLOY: "1" };
  const provider = new RenderProvider("never-log-this-token", env, fetcher);
  assert.equal((await provider.listServices())[0]?.name, "runtime");
  assert.equal((await provider.deployStatus("srv-1"))?.status, "live");
  assert.equal((await provider.triggerDeploy("srv-1")).id, "dep-2");
  assert.deepEqual(calls.map(({ method, url }) => [method, url.split("api.render.com/v1")[1]]), [
    ["GET", "/services?limit=20"],
    ["GET", "/services/srv-1/deploys?limit=1"],
    ["GET", "/services/srv-1"],
    ["POST", "/services/srv-1/deploys"]
  ]);

  let requests = 0;
  const blocked = new RenderProvider("key", {}, async () => {
    requests += 1;
    return new Response("{}", { status: 200 });
  });
  await assert.rejects(blocked.triggerDeploy("srv-1"), /PIXIE_RENDER_SERVICE_ID/);
  assert.equal(requests, 0);

  const mismatch = new RenderProvider("key", {
    PIXIE_RENDER_SERVICE_ID: "other-service",
    PIXIE_ALLOW_RENDER_DEPLOY: "1"
  }, async () => {
    requests += 1;
    return new Response("{}", { status: 200 });
  });
  await assert.rejects(mismatch.triggerDeploy("srv-1"), /PIXIE_RENDER_SERVICE_ID/);
  assert.equal(requests, 0);
});
