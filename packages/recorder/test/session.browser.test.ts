import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchControlledChrome } from "../src/chrome.js";
import { RecordingSession } from "../src/session.js";

const enabled = process.env.GATEWAY_BROWSER_TESTS === "1";

test("records a real demonstration in the controlled browser", { skip: !enabled && "set GATEWAY_BROWSER_TESTS=1" }, async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<form action="/r" style="margin:0"><label>Member ID <input name="memberId" style="position:absolute;left:100px;top:10px;width:200px;height:30px"></label><button>Search</button></form><p>${req.url}</p>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const chrome = await launchControlledChrome({ userDataDir: mkdtempSync(join(tmpdir(), "gw-chrome-")), port: 9444, headless: true });
  try {
    const session = new RecordingSession({ cdpUrl: chrome.cdpUrl, startUrl: `http://127.0.0.1:${port}/`, allowedOrigins: [`http://127.0.0.1:${port}`], screencast: true });
    await session.start();
    // Drive the page through CDP input exactly like the studio live view does.
    await session.input({ type: "mouse", event: "mousePressed", x: 200, y: 25 });
    await session.input({ type: "mouse", event: "mouseReleased", x: 200, y: 25 });
    await session.input({ type: "insertText", text: "DEMO-1001" });
    await session.input({ type: "key", event: "keyDown", key: "Enter", code: "Enter" });
    await session.input({ type: "key", event: "keyUp", key: "Enter", code: "Enter" });
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(session.status().connected);
    const result = await session.stop();
    const kinds = result.events.map((e) => e.kind);
    assert.ok(kinds.includes("input"), `expected input event in ${kinds}`);
    assert.ok(kinds.includes("navigate"));
    assert.ok(!JSON.stringify(result.events).includes("DEMO-1001"), "value must not be captured");
    assert.ok(result.events.some((e) => e.url.includes("memberId=%3Credacted%3E")));
  } finally {
    await chrome.close();
    server.close();
  }
});
