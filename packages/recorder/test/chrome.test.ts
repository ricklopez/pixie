import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensurePageTarget, launchControlledChrome, ownsEndpoint, resolveChromeExecutable } from "../src/chrome.js";

function fakeCdpServer(targets: { type: string }[] | null = null) {
  const server = createServer((req, res) => {
    if (req.url === "/json/list" && targets) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(targets));
    } else if (req.method === "PUT" && req.url === "/json/new?about:blank" && targets) {
      targets.push({ type: "page" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "new", type: "page", url: "about:blank" }));
    } else if (req.url === "/json/version") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Browser: "Chrome/999 (someone else's browser)", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/x" }));
    } else res.writeHead(404).end();
  });
  return new Promise<{ port: number; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, close: () => server.close() }));
  });
}

test("refuses to attach to a CDP endpoint the profile did not launch", async () => {
  const fake = await fakeCdpServer();
  try {
    const userDataDir = mkdtempSync(join(tmpdir(), "pixie-profile-"));
    await assert.rejects(launchControlledChrome({ port: fake.port, userDataDir, executable: "/nonexistent/chrome" }), /does not own; refusing to attach/);
    assert.equal(ownsEndpoint(userDataDir, fake.port), false);
  } finally {
    fake.close();
  }
});

test("ownership requires marker, live pid and Chrome's DevToolsActivePort to agree", async () => {
  const fake = await fakeCdpServer();
  try {
    const userDataDir = mkdtempSync(join(tmpdir(), "pixie-profile-"));
    writeFileSync(join(userDataDir, "pixie-owner.json"), JSON.stringify({ port: fake.port, pid: process.pid, startedAt: "now" }));
    assert.equal(ownsEndpoint(userDataDir, fake.port), false, "no DevToolsActivePort yet");
    writeFileSync(join(userDataDir, "DevToolsActivePort"), `${fake.port}\n/devtools/browser/x`);
    assert.equal(ownsEndpoint(userDataDir, fake.port), true);
    writeFileSync(join(userDataDir, "pixie-owner.json"), JSON.stringify({ port: fake.port, pid: 2 ** 22 - 1, startedAt: "now" }));
    assert.equal(ownsEndpoint(userDataDir, fake.port), false, "stale pid");
    // A marker for a different port never grants the occupied one.
    writeFileSync(join(userDataDir, "pixie-owner.json"), JSON.stringify({ port: fake.port + 1, pid: process.pid, startedAt: "now" }));
    await assert.rejects(launchControlledChrome({ port: fake.port, userDataDir, executable: "/nonexistent/chrome" }), /refusing to attach/);
  } finally {
    fake.close();
  }
});

test("Chrome discovery: env override, macOS bundle paths, explicit error", () => {
  assert.equal(resolveChromeExecutable("/x/chrome", "darwin", () => false), "/x/chrome");
  assert.equal(resolveChromeExecutable(undefined, "darwin", (p) => p.includes("Chromium.app")), "/Applications/Chromium.app/Contents/MacOS/Chromium");
  assert.throws(() => resolveChromeExecutable(undefined, "darwin", () => false), /GATEWAY_CHROME_PATH/);
  assert.equal(resolveChromeExecutable(undefined, "linux", () => false), "google-chrome");
});

test("closed-last-tab: /json/version healthy but /json/list empty is recovered by opening about:blank; a dead endpoint is reported", async () => {
  const targets: { type: string }[] = [];
  const server = await fakeCdpServer(targets);
  const url = `http://127.0.0.1:${server.port}`;
  assert.equal(await ensurePageTarget(url), "recovered");
  assert.deepEqual(targets, [{ type: "page" }]);
  assert.equal(await ensurePageTarget(url), "ready");
  server.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await ensurePageTarget(url), "unreachable");
  // A server without /json/list (not a Chrome we own) is never "fixed".
  const foreign = await fakeCdpServer(null);
  assert.equal(await ensurePageTarget(`http://127.0.0.1:${foreign.port}`), "unreachable");
  foreign.close();
});
