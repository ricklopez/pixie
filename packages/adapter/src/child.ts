import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

function originAllowed(url: string, allowedOrigins: string[]): boolean {
  try {
    return allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

async function main() {
  const [sourcePath, configJson = "{}"] = process.argv.slice(2);
  const outputPath = process.env.PIXIE_SCRIPT_OUTPUT;
  const cdpUrl = process.env.BU_CDP_URL;
  const inputValues = JSON.parse(process.env.PIXIE_SCRIPT_INPUT ?? "{}") as Record<string, string | number | boolean>;
  const config = JSON.parse(configJson) as { allowedOrigins?: string[]; startUrl?: string; maxActions?: number; deadlineMs?: number };
  const allowedOrigins = config.allowedOrigins ?? [];
  const startUrl = config.startUrl ?? "";
  const maxActions = config.maxActions ?? 100;
  const deadlineMs = config.deadlineMs ?? 180000;
  const started = Date.now();
  process.env.PIXIE_SCRIPT_STARTED_AT = String(started);
  process.env.PIXIE_SCRIPT_MAX_ACTIONS = String(maxActions);
  process.env.PIXIE_SCRIPT_DEADLINE_MS = String(deadlineMs);
  let actions = 0;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let result: Record<string, unknown> = { actions, providerCalls: 0, attemptedSecrets: false };
  try {
    if (!sourcePath || !outputPath || !cdpUrl) throw new Error("script child missing required environment");
    if (!originAllowed(startUrl, allowedOrigins)) throw new Error("script navigation origin is not allowed");
    browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    let blockedOrigin: string | undefined;
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (!originAllowed(url, allowedOrigins) && !["data:", "about:", "blob:"].some((prefix) => url.startsWith(prefix))) {
        blockedOrigin = new URL(url).origin;
        await route.abort();
        return;
      }
      await route.continue();
    });
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: Math.min(deadlineMs, 30000) });
    if (blockedOrigin) throw new Error(`script request origin is not allowed: ${blockedOrigin}`);
    const module = await import(`${pathToFileURL(sourcePath).href}?hash=${Date.now()}`) as { run: (page: unknown, input: Record<string, string | number | boolean>) => Promise<unknown> };
    const wrappedPage = new Proxy(page, {
      get(target, property, receiver) {
        if (property === "goto") {
          return async (...args: unknown[]) => {
            actions += 1;
            if (actions > maxActions || Date.now() - started > deadlineMs) throw new Error("script action budget exhausted");
            const url = String(args[0] ?? "");
            if (!originAllowed(url, allowedOrigins)) throw new Error("script navigation origin is not allowed");
            return (target.goto as unknown as (...items: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const scriptResult = await module.run(wrappedPage, inputValues);
    if (blockedOrigin) throw new Error(`script request origin is not allowed: ${blockedOrigin}`);
    result = { result: scriptResult, actions, providerCalls: 0, attemptedSecrets: false, finalUrl: page.url() };
  } catch (error) {
    result = { ...result, actions, providerCalls: 0, attemptedSecrets: false, error: error instanceof Error ? error.message : "script execution failed" };
  } finally {
    await browser?.close().catch(() => undefined);
    await writeFile(outputPath!, JSON.stringify(result));
  }
}

await main();
