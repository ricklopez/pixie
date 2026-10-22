import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { ensurePageTarget, launchControlledChrome, ownsEndpoint } from "../src/chrome.js";
import { RecordingSession } from "../src/session.js";

const enabled = process.env.GATEWAY_BROWSER_TESTS === "1";

/** Reads or writes a localStorage key in the profile behind `cdpUrl`, the same storage todo.uiineed.com uses. */
async function storage(cdpUrl: string, url: string, write?: string): Promise<string | null> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const context = browser.contexts()[0]!;
    const page = await context.newPage();
    await page.goto(url);
    if (write !== undefined) await page.evaluate((v) => localStorage.setItem("pixie-isolation", v), write);
    const value = await page.evaluate(() => localStorage.getItem("pixie-isolation"));
    await page.close();
    return value;
  } finally {
    await browser.close();
  }
}

test("P7: profile state survives a graceful Chrome restart and is invisible to a second account's profile", { skip: !enabled && "set GATEWAY_BROWSER_TESTS=1" }, async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<h1>synthetic todo</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const root = mkdtempSync(join(tmpdir(), "gw-isolation-"));
  const profileA = join(root, "acct_a");
  const profileB = join(root, "acct_b");
  try {
    const a1 = await launchControlledChrome({ port: 9461, userDataDir: profileA, headless: true });
    assert.equal(await storage(a1.cdpUrl, url, "pixie-demo restart-me"), "pixie-demo restart-me");
    await a1.close();
    assert.equal(ownsEndpoint(profileA, 9461), false, "ownership marker is released on graceful close");

    // Restart on a different port: the value is stored in the profile directory, not in the process.
    const a2 = await launchControlledChrome({ port: 9462, userDataDir: profileA, headless: true });
    assert.equal(await storage(a2.cdpUrl, url), "pixie-demo restart-me");

    // A second account, launched concurrently, gets a different browser without account A's state.
    const b = await launchControlledChrome({ port: 9463, userDataDir: profileB, headless: true });
    assert.notEqual(b.cdpUrl, a2.cdpUrl);
    assert.equal(await storage(b.cdpUrl, url), null);
    assert.ok(existsSync(join(profileA, "pixie-owner.json")) && existsSync(join(profileB, "pixie-owner.json")));

    // Negative: profile B may not attach to A's running endpoint, and vice versa.
    await assert.rejects(launchControlledChrome({ port: 9462, userDataDir: profileB, headless: true }), /does not own; refusing to attach/);
    await assert.rejects(launchControlledChrome({ port: 9463, userDataDir: profileA, headless: true }), /does not own; refusing to attach/);
    await Promise.all([a2.close(), b.close()]);
  } finally {
    server.close();
  }
});

test("closed-last-tab: after every tab of an owned Chrome is closed, re-attach recovers a page target and a recording can start", { skip: !enabled && "set GATEWAY_BROWSER_TESTS=1" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-lasttab-"));
  const chrome = await launchControlledChrome({ port: 9471, userDataDir: dir, mode: "headless" });
  try {
    const browser = await chromium.connectOverCDP(chrome.cdpUrl);
    for (const page of browser.contexts().flatMap((c) => c.pages())) await page.close();
    await browser.close();
    const list = async () => (await (await fetch(`${chrome.cdpUrl}/json/list`)).json()) as { type: string }[];
    assert.equal((await list()).filter((t) => t.type === "page").length, 0, "precondition: no page targets left");
    assert.equal(await ensurePageTarget(chrome.cdpUrl), "recovered");
    assert.equal((await list()).filter((t) => t.type === "page").length, 1);
    const session = new RecordingSession({ cdpUrl: chrome.cdpUrl, startUrl: "about:blank", allowedOrigins: [] });
    await session.start();
    assert.equal(session.status().connected, true);
    await session.stop();
    // A start against an endpoint that is not a browser fails and leaves no live connection behind.
    const dead = new RecordingSession({ cdpUrl: "http://127.0.0.1:1", startUrl: "about:blank", allowedOrigins: [] });
    await assert.rejects(dead.start());
    assert.equal(dead.status().connected, false);
  } finally {
    await chrome.close();
  }
});

test("failed-start cleanup: when navigation fails after the tab was created, only that tab is closed and pre-existing tabs survive", { skip: !enabled && "set GATEWAY_BROWSER_TESTS=1" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-failnav-"));
  const chrome = await launchControlledChrome({ port: 9481, userDataDir: dir, mode: "headless" });
  try {
    const list = async () =>
      ((await (await fetch(`${chrome.cdpUrl}/json/list`)).json()) as { type: string; url: string }[]).filter((t) => t.type === "page");
    const other = await chromium.connectOverCDP(chrome.cdpUrl);
    const unrelated = await other.contexts()[0]!.newPage();
    await unrelated.goto("data:text/html,<title>keep-me</title>unrelated");
    const before = await list();
    assert.ok(before.some((t) => t.url.startsWith("data:text/html")), "precondition: unrelated tab present");

    // Connection refused on the start URL: the session's tab exists (and screencast is attached) when goto fails.
    const session = new RecordingSession({ cdpUrl: chrome.cdpUrl, startUrl: "http://127.0.0.1:1/", allowedOrigins: [], screencast: true });
    await assert.rejects(session.start());
    assert.equal(session.status().connected, false);

    const after = await list();
    assert.equal(after.length, before.length, `failed session tab must be removed (before ${before.length}, after ${after.length})`);
    assert.ok(after.some((t) => t.url.startsWith("data:text/html")), "unrelated tab must survive");
    assert.equal(unrelated.isClosed(), false);
    await other.close();
  } finally {
    await chrome.close();
  }
});
