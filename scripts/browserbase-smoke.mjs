import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const API = "https://api.browserbase.com";
const MAX_SESSIONS = 3;
const MAX_TOTAL_SECONDS = 600;
const MAX_SESSION_SECONDS = Math.min(300, Number(process.env.PIXIE_MAX_SESSION_SECONDS ?? 300));
const apiKey = process.env.BROWSERBASE_API_KEY;
const projectId = process.env.BROWSERBASE_PROJECT_ID;

if (!apiKey || !projectId) {
  console.error("Browserbase credentials are not configured (values are never displayed).");
  process.exit(2);
}
if (!Number.isInteger(MAX_SESSION_SECONDS) || MAX_SESSION_SECONDS < 60) {
  console.error("PIXIE_MAX_SESSION_SECONDS must be an integer between 60 and 300 for this smoke test.");
  process.exit(2);
}

const sessions = [];
let contextId;
let totalSeconds = 0;
let failed = false;
let releaseAttempts = new Map();
let finalOrphanCount = "unavailable";
const outputLines = [];
const emit = (line) => {
  outputLines.push(line);
  process.stdout.write(`${line}\n`);
};
const request = async (method, path, body) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { "X-BB-API-Key": apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok) throw new Error(`Browserbase API returned HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
};

async function release(session) {
  if (session.released) return;
  const attempts = (releaseAttempts.get(session.id) ?? 0) + 1;
  releaseAttempts.set(session.id, attempts);
  if (attempts > 2) return;
  try {
    await session.browser?.close().catch(() => undefined);
    await request("POST", `/v1/sessions/${encodeURIComponent(session.id)}`, { status: "REQUEST_RELEASE" });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const latest = await request("GET", `/v1/sessions/${encodeURIComponent(session.id)}`);
      if (!["PENDING", "RUNNING"].includes(latest.status)) {
        session.seconds = Math.max(0, Math.ceil((Date.now() - session.startedAt) / 1000));
        totalSeconds += session.seconds;
        if (totalSeconds > MAX_TOTAL_SECONDS) throw new Error("session time budget exceeded");
        session.released = true;
        emit(`released session=${session.id.slice(0, 8)} seconds=${session.seconds}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("session release was not confirmed");
  } catch {
    failed = true;
    emit(`release_failed session=${session.id.slice(0, 8)}`);
  }
}

async function openSession(label) {
  if (sessions.length >= MAX_SESSIONS) throw new Error("session count budget exceeded");
  const reservedSeconds = sessions.filter((session) => !session.released).reduce((sum, session) => sum + session.timeout, 0);
  const timeout = Math.min(MAX_SESSION_SECONDS, MAX_TOTAL_SECONDS - totalSeconds - reservedSeconds);
  if (timeout < 60) throw new Error("session time budget exhausted");
  const session = await request("POST", "/v1/sessions", {
    projectId,
    browserSettings: { context: { id: contextId, persist: true } },
    keepAlive: true,
    timeout,
    userMetadata: { pixie: "1", connectionId: "smoke" }
  });
  if (!session?.id || !session?.connectUrl) throw new Error("session response was incomplete");
  const current = { id: session.id, connectUrl: session.connectUrl, startedAt: Date.now(), browser: null, released: false, timeout };
  sessions.push(current);
  emit(`${label} session_created id=${current.id.slice(0, 8)} timeout=${timeout}`);
  return current;
}

try {
  contextId = (await request("POST", "/v1/contexts", { name: `pixie-smoke-${randomUUID().slice(0, 8)}` })).id;
  if (!contextId) throw new Error("context response was incomplete");
  emit("context_created");

  const first = await openSession("A");
  try {
    first.browser = await chromium.connectOverCDP(first.connectUrl, { timeout: 20_000 });
    const context = first.browser.contexts()[0] ?? await first.browser.newContext();
    const page = await context.newPage();
    await page.goto("https://httpbin.org/cookies/set?pixie_probe=1", { waitUntil: "domcontentloaded", timeout: 45_000 });
    emit("session_A_cookie_set");
  } catch {
    throw new Error("session A navigation failed");
  } finally {
    await release(first);
  }

  await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Number(process.env.PIXIE_CONTEXT_SYNC_WAIT_MS ?? 5000))));
  emit("context_sync_wait_complete");

  const second = await openSession("B");
  try {
    second.browser = await chromium.connectOverCDP(second.connectUrl, { timeout: 20_000 });
    const context = second.browser.contexts()[0] ?? await second.browser.newContext();
    const page = await context.newPage();
    await page.goto("https://httpbin.org/cookies", { waitUntil: "domcontentloaded", timeout: 45_000 });
    const body = await page.locator("body").innerText();
    if (!body.includes('"pixie_probe"') || !body.includes('"1"')) throw new Error("cookie missing");
    emit("session_B_cookie_persisted=true");
  } catch {
    throw new Error("session B persistence verification failed");
  } finally {
    await release(second);
  }

  const running = await request("GET", "/v1/sessions?status=RUNNING");
  const orphans = Array.isArray(running) ? running.filter((item) => item.userMetadata?.pixie === "1") : [];
  finalOrphanCount = orphans.length;
  emit(`sweeper_tagged_running=${orphans.length}`);
  if (orphans.length) failed = true;
} catch (error) {
  failed = true;
  emit(`smoke_failed=${error instanceof Error && error.message.includes("budget") ? error.message : "step_failed"}`);
} finally {
  for (const session of sessions) await release(session);
  if (contextId) {
    try {
      await request("DELETE", `/v1/contexts/${encodeURIComponent(contextId)}`);
      emit("context_deleted=true");
    } catch {
      failed = true;
      emit("context_deleted=false");
    }
  }
  try {
    const running = await request("GET", "/v1/sessions?status=RUNNING");
    finalOrphanCount = Array.isArray(running) ? running.filter((item) => item.userMetadata?.pixie === "1").length : "unavailable";
    if (finalOrphanCount !== "unavailable" && finalOrphanCount !== 0) failed = true;
  } catch {
    finalOrphanCount = "unavailable";
  }
  emit(`total_session_seconds=${totalSeconds}`);
  emit(`final_tagged_orphans=${finalOrphanCount}`);
  writeFileSync("/home/ubuntu/evidence/browserbase-smoke.txt", `${outputLines.join("\n")}\n`, { mode: 0o600 });
}

if (failed) process.exitCode = 1;
