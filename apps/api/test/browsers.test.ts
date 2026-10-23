import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ControlledChromeOptions, EndpointHealth } from "@gateway/recorder";
import { BrowserPool, isValidAccountId, profileDirName, recorderProfile } from "../src/browsers.js";
import { call, publishEligibility, testApp, TOKENS } from "./helpers.js";

function fakePool(root: string, busyPorts: number[] = [], delayMs = 0, failing: string[] = [], ensureUsable?: (cdpUrl: string) => Promise<EndpointHealth>) {
  const launches: ControlledChromeOptions[] = [];
  const closed: string[] = [];
  const recovered: string[] = [];
  const pool = new BrowserPool({
    root,
    basePort: 9500,
    mode: "headless",
    ensureUsable: ensureUsable ?? (async () => "ready"),
    onRecovered: (name) => void recovered.push(name),
    portInUse: async (port) => busyPorts.includes(port),
    launch: async (options) => {
      launches.push(options);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (failing.some((f) => options.userDataDir.includes(f))) throw new Error(`fake launch failure for ${options.userDataDir}`);
      return { cdpUrl: `http://127.0.0.1:${options.port}`, process: null, executable: "fake", close: async () => void closed.push(options.userDataDir) };
    }
  });
  return { pool, launches, closed, recovered };
}

test("P7: a cached owned Chrome whose last tab closed is recovered in place; a dead one is relaunched on the same port", async () => {
  const root = mkdtempSync(join(tmpdir(), "gw-pool-"));
  const health = new Map<string, EndpointHealth>();
  const { pool, launches, closed, recovered } = fakePool(root, [], 0, [], async (url) => health.get(url) ?? "ready");
  const a = await pool.cdpUrlFor("acct_a");
  health.set(a, "recovered");
  assert.equal(await pool.cdpUrlFor("acct_a"), a);
  assert.deepEqual(recovered, ["acct_a"]);
  assert.equal(launches.length, 1, "recovery never relaunches or touches another profile");
  health.set(a, "unreachable");
  assert.equal(await pool.cdpUrlFor("acct_a"), a, "the freed port is reused by the relaunch");
  assert.equal(launches.length, 2);
  assert.deepEqual(closed, [pool.profileDir("acct_a")]);
  assert.equal(launches[1].userDataDir, pool.profileDir("acct_a"));
  await pool.closeAll();
});

test("P7: each account gets its own profile directory and CDP port; the same account reuses its browser", async () => {
  const root = mkdtempSync(join(tmpdir(), "gw-pool-"));
  const { pool, launches, closed } = fakePool(root, [9501]);
  const a = await pool.cdpUrlFor("acct_a");
  const b = await pool.cdpUrlFor("acct_b");
  const recorder = await pool.cdpUrlFor(recorderProfile("tenant_demo"));
  assert.notEqual(a, b);
  assert.notEqual(b, recorder);
  assert.equal(a, "http://127.0.0.1:9500");
  assert.equal(b, "http://127.0.0.1:9502", "skips a port that already serves a foreign CDP endpoint");
  assert.equal(await pool.cdpUrlFor("acct_a"), a);
  assert.deepEqual(
    launches.map((l) => l.userDataDir),
    [pool.profileDir("acct_a"), pool.profileDir("acct_b"), pool.profileDir(recorderProfile("tenant_demo"))]
  );
  assert.match(profileDirName("acct_a"), /^acct_a-[0-9a-f]{12}$/);
  // Concurrent first requests for one account launch exactly one browser.
  const [c1, c2] = await Promise.all([pool.cdpUrlFor("acct_c"), pool.cdpUrlFor("acct_c")]);
  assert.equal(c1, c2);
  assert.equal(launches.length, 4);
  await pool.closeAll();
  assert.equal(closed.length, 4);
});

test("P7 negative: ids differing only by case never map to one profile directory (case-insensitive volumes)", async () => {
  const root = mkdtempSync(join(tmpdir(), "gw-pool-"));
  const { pool } = fakePool(root);
  const upper = pool.profileDir("acct_A");
  const lower = pool.profileDir("acct_a");
  assert.notEqual(upper.toLowerCase(), lower.toLowerCase());
  assert.notEqual(pool.profileDir(recorderProfile("tenant_demo")).toLowerCase(), pool.profileDir(recorderProfile("tenant_DEMO")).toLowerCase());
  assert.notEqual(await pool.cdpUrlFor("acct_A"), await pool.cdpUrlFor("acct_a"));
});

test("P7: concurrent first launches for distinct accounts reserve distinct ports; a failed launch releases its port", async () => {
  const root = mkdtempSync(join(tmpdir(), "gw-pool-"));
  const { pool, launches } = fakePool(root, [], 30, [profileDirName("acct_fail")]);
  const urls = await Promise.all(["acct_a", "acct_b", "acct_c", recorderProfile("tenant_demo")].map((n) => pool.cdpUrlFor(n)));
  assert.equal(new Set(urls).size, 4, `ports must be unique across pending launches, got ${urls.join(", ")}`);
  assert.deepEqual(launches.map((l) => l.port).sort(), [9500, 9501, 9502, 9503]);
  await assert.rejects(pool.cdpUrlFor("acct_fail"), /fake launch failure/);
  assert.equal(await pool.cdpUrlFor("acct_d"), "http://127.0.0.1:9504", "the failed launch's port is reusable");
  assert.equal(pool.profiles().length, 5);
});

test("P7 negative: GATEWAY_CDP_URL is a single shared browser, so a second account is refused rather than sharing state", async () => {
  const pool = new BrowserPool({ root: mkdtempSync(join(tmpdir(), "gw-pool-")), basePort: 9500, mode: "headless", fixedCdpUrl: "http://127.0.0.1:9222" });
  assert.equal(await pool.cdpUrlFor("acct_a"), "http://127.0.0.1:9222");
  assert.equal(await pool.cdpUrlFor("acct_a"), "http://127.0.0.1:9222");
  await assert.rejects(pool.cdpUrlFor("acct_b"), /single shared browser already in use by profile "acct_a"/);
  await assert.rejects(pool.cdpUrlFor(recorderProfile("tenant_other")), /refused to preserve account isolation/);
});

test("P7 negative: account ids that could escape the profile root are refused, in the pool and at the API", async () => {
  const root = mkdtempSync(join(tmpdir(), "gw-pool-"));
  const { pool, launches } = fakePool(root);
  for (const bad of ["../acct_a", "acct/../a", "", ".hidden", "acct a", "_recorder", "a".repeat(70)]) {
    assert.equal(isValidAccountId(bad), false, bad);
    await assert.rejects(pool.cdpUrlFor(bad), /invalid browser profile name/);
  }
  await assert.rejects(pool.cdpUrlFor("_recorder_../x"), /invalid browser profile name/);
  assert.throws(() => recorderProfile("../t"), /invalid tenant id/);
  assert.equal(launches.length, 0);

  const { app, shutdown } = await testApp();
  const traversal = await call(app, TOKENS.developer, "POST", "/studio/accounts", { id: "../acct_demo", name: "x", portalOrigin: "http://127.0.0.1:4174" });
  assert.equal(traversal.status, 400);
  const duplicate = await call(app, TOKENS.developer, "POST", "/studio/accounts", { id: "acct_other", name: "steal other tenant's profile", portalOrigin: "http://127.0.0.1:4174" });
  assert.equal(duplicate.status, 409, "an id owned by another tenant cannot be re-created to reach its browser profile");
  const list = await call(app, TOKENS.developer, "GET", "/studio/accounts");
  assert.deepEqual(
    list.json.map((a: { id: string }) => a.id),
    ["acct_demo"],
    "only the caller's tenant accounts (and their browser state) are visible"
  );
  await shutdown();
});

test("P7: the worker for a run receives the CDP endpoint of that run's account only", async () => {
  const { app, runs, runner, shutdown } = await testApp();
  const { id, revision } = await publishEligibility(app, runs);
  const started = await call(app, TOKENS.client, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1002" } });
  assert.equal(started.status, 202);
  await runs.waitForTerminal(started.json.id!);
  assert.deepEqual([...new Set(runner.commands.map((c) => c.accountId))], ["acct_demo"]);
  // A client of another tenant cannot route a run into this account's browser.
  const foreign = await call(app, TOKENS.otherTenantClient, "POST", `/v1/automations/${id}/runs`, { revision, accountId: "acct_demo", input: { memberId: "DEMO-1002" } });
  assert.notEqual(foreign.status, 202);
  assert.equal(runner.commands.length, 3); // the test run, publication smoke, and client run
  await shutdown();
});
