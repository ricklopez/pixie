import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { evidenceTest } from "../src/test-support/evidence.js";
import { readCapturedTrace } from "../src/capture/recorder.js";
import { OptInUltrafastSource } from "../src/capture/ultrafast-source.js";
import { verifyContractLock } from "../src/contract/lock.js";
import { startFixture } from "../src/fixture/server.js";
import { generateAll, generateModule, GeneratorGap } from "../src/generator/generator.js";
import { OptInPaidRepairProvider } from "../src/repair/provider.js";
import { proposeRepair } from "../src/repair/propose.js";
import { blockNodeRequests, installBrowserRequestGuard, ModelCallGuard } from "../src/runner/model-guard.js";
import type { Trace } from "../src/shared/types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

evidenceTest("verifies the frozen contract lock and deterministic generated source hashes", async () => {
  await verifyContractLock();
  const traces = (["create", "list", "rename", "delete"] as const)
    .map((operation) => readCapturedTrace(resolve(packageRoot, `capture/traces/${operation}.json`)));
  const generated = generateAll(traces);
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "generated/baseline/hashes.json"), "utf8")) as Record<
    string,
    { traceHash: string; outputHash: string }
  >;
  for (const operation of ["create", "list", "rename", "delete"] as const) {
    const generatedSource = await readFile(resolve(packageRoot, `generated/baseline/${operation}.ts`), "utf8");
    assert.equal(generated[operation].source, generatedSource);
    assert.equal(generated[operation].traceHash, manifest[operation]?.traceHash);
    assert.equal(generated[operation].outputHash, manifest[operation]?.outputHash);
    assert.doesNotMatch(generated[operation].source, /capture example|capture target|pixie-demo renamed/);
  }
});

evidenceTest("fails closed with GeneratorGap when a trace action has no locator", async () => {
  const trace = readCapturedTrace(resolve(packageRoot, "capture/traces/create.json"));
  const missingLocator: Trace = {
    ...trace,
    actions: trace.actions.map((action, index) => index === 0 ? { ...action, locatorCandidates: [] } : action)
  };
  assert.throws(() => generateModule(missingLocator), (error: unknown) => error instanceof GeneratorGap);
  const unnamedRole: Trace = {
    ...trace,
    actions: trace.actions.map((action, index) => index === 0
      ? { ...action, locatorCandidates: [{ role: "textbox" }] }
      : action)
  };
  assert.throws(() => generateModule(unnamedRole), (error: unknown) => error instanceof GeneratorGap);
});

evidenceTest("counts only named model hosts for local request-blocking instrumentation", async () => {
  const guard = new ModelCallGuard();
  for (const host of [
    "api.openai.com",
    "api.typesafe.ai",
    "api.anthropic.com",
    "generativelanguage.googleapis.com"
  ]) {
    assert.equal(guard.checkUrl(`https://${host}/v1/test`), true);
  }
  assert.equal(guard.checkNodeArguments([{ hostname: "api.typesafe.ai", protocol: "https:", path: "/v1/test" }]), true);
  assert.equal(guard.checkUrl("http://127.0.0.1:4174/__state"), false);
  assert.equal(guard.count(), 5);
});

evidenceTest("blocks model-host requests in Node fetch/http/https and Playwright without network access", async () => {
  const nodeGuard = new ModelCallGuard();
  const restoreNodeRequests = blockNodeRequests(nodeGuard);
  try {
    await assert.rejects(fetch("https://api.openai.com/v1/test"), /model host blocked/);
    assert.throws(() => http.get("http://api.typesafe.ai/v1/test"), /model host blocked/);
    assert.throws(() => https.get("https://api.anthropic.com/v1/test"), /model host blocked/);
    assert.throws(() => http.request("http://127.0.0.1:4174/", { hostname: "api.typesafe.ai" }), /model host blocked/);
    assert.equal(nodeGuard.count(), 4);
  } finally {
    restoreNodeRequests();
  }

  const fixture = await startFixture({ variant: "baseline" });
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const browserGuard = new ModelCallGuard();
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await installBrowserRequestGuard(context, browserGuard, "", () => {});
    const page = await context.newPage();
    await page.goto(fixture.baseUrl);
    const outcome = await page.evaluate(async () => {
      try {
        await fetch("https://api.anthropic.com/v1/test");
        return "unexpected-success";
      } catch {
        return "blocked";
      }
    });
    assert.equal(outcome, "blocked");
    assert.equal(browserGuard.count(), 1);
  } finally {
    await context?.close();
    await browser?.close();
    await fixture.close();
  }
});

evidenceTest("refuses paid authoring/provider calls without explicit opt-in and sanitizes proposals", async () => {
  const oldFlag = process.env.PIXIE_ALLOW_PAID_EXPERIMENT;
  delete process.env.PIXIE_ALLOW_PAID_EXPERIMENT;
  try {
    await assert.rejects(new OptInUltrafastSource().author("create"), /paid Ultrafast authoring is disabled/);
    await assert.rejects(new OptInPaidRepairProvider().propose({
      failedStep: "test",
      sanitizedDomExcerpt: "",
      contract: {},
      allowedScope: "generated/candidate/rename.ts"
    }), /paid repair is disabled/);
  } finally {
    if (oldFlag !== undefined) process.env.PIXIE_ALLOW_PAID_EXPERIMENT = oldFlag;
  }
  const proposal = proposeRepair("locator-break", "rename", "locator timeout", '<input value="private"><a href="https://example.test/path?token=secret">go</a>', {});
  assert.doesNotMatch(proposal.sanitizedDomExcerpt, /private|secret|\?token/);
  assert.equal(proposal.allowedScope, "generated/locator-break/rename.ts");
});
