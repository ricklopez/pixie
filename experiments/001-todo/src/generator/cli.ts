import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { recordDemonstration } from "../capture/recorder.js";
import { startFixture } from "../fixture/server.js";
import type { Task, Trace } from "../shared/types.js";
import { generateAll } from "./generator.js";
import { readVisibleTasks } from "./runtime.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const traceDir = resolve(packageRoot, "capture/traces");
const generatedDir = resolve(packageRoot, "generated/baseline");

const targetId = "11111111-1111-4111-8111-111111111111";
const targetRow: Task = { id: targetId, title: "pixie-demo capture target", done: false, requestId: null };

async function run(): Promise<void> {
  const fixture = await startFixture({ variant: "baseline" });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();
    let requestId = "";
    await context.route("**/__app/**", async (route) => {
      await route.continue({ headers: { ...route.request().headers(), "x-request-id": requestId } });
    });
    const page = await context.newPage();
    const traces: Trace[] = [];

    fixture.reset([]);
    await page.goto(fixture.baseUrl);
    requestId = "22222222-2222-4222-8222-222222222222";
    const createTitle = "pixie-demo capture example";
    traces.push(await recordDemonstration(page, "create", ["title", "requestId"], [
      { kind: "fill", inputBinding: "title", locator: page.getByTestId("new-task-title"), execute: () => page.getByTestId("new-task-title").fill(createTitle) },
      { kind: "click", locator: page.getByTestId("create-task"), execute: async () => {
        await page.getByTestId("create-task").click();
        await page.waitForFunction((wanted) => Array.from(document.querySelectorAll<HTMLElement>("[data-request-id]")).some((row) => row.dataset.requestId === wanted), requestId);
      } }
    ]));

    fixture.reset([targetRow]);
    await page.goto(fixture.baseUrl);
    const row = page.locator(`[data-task-id="${targetId}"]`);
    requestId = "33333333-3333-4333-8333-333333333333";
    const newTitle = "pixie-demo renamed";
    traces.push(await recordDemonstration(page, "rename", ["id", "newTitle", "requestId"], [
      { kind: "click", scopeBinding: "id", locator: row.getByTestId("rename-task"), execute: () => row.getByTestId("rename-task").click() },
      { kind: "fill", scopeBinding: "id", inputBinding: "newTitle", locator: row.getByTestId("rename-input"), execute: () => row.getByTestId("rename-input").fill(newTitle) },
      { kind: "click", scopeBinding: "id", locator: row.getByTestId("save-rename"), execute: async () => {
        await row.getByTestId("save-rename").click();
        await page.waitForFunction(({ id, title }) => {
          const current = document.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
          return current?.querySelector(".task-title")?.textContent === title;
        }, { id: targetId, title: newTitle });
      } }
    ]));

    fixture.reset([targetRow]);
    await page.goto(fixture.baseUrl);
    const deleteRow = page.locator(`[data-task-id="${targetId}"]`);
    requestId = "44444444-4444-4444-8444-444444444444";
    traces.push(await recordDemonstration(page, "delete", ["id", "requestId"], [
      { kind: "click", scopeBinding: "id", locator: deleteRow.getByTestId("delete-task"), execute: async () => {
        await deleteRow.getByTestId("delete-task").click();
        await page.waitForFunction((id) => !document.querySelector(`[data-task-id="${id}"]`), targetId);
      } }
    ]));

    fixture.reset([targetRow]);
    await page.goto(fixture.baseUrl);
    traces.push(await recordDemonstration(page, "list", [], [
      { kind: "read-list", locator: page.locator(`[data-task-id="${targetId}"]`), execute: () => readVisibleTasks(page) }
    ]));

    await mkdir(traceDir, { recursive: true });
    await mkdir(generatedDir, { recursive: true });
    for (const trace of traces) {
      await writeFile(resolve(traceDir, `${trace.operation}.json`), `${JSON.stringify(trace, null, 2)}\n`);
    }
    const generated = generateAll(traces);
    for (const operation of ["create", "list", "rename", "delete"] as const) {
      await writeFile(resolve(generatedDir, `${operation}.ts`), generated[operation].source);
    }
    const manifest = Object.fromEntries(Object.entries(generated).map(([operation, entry]) => [operation, {
      generator: "pixie-template-generator@1.0.0",
      traceHash: entry.traceHash,
      outputHash: entry.outputHash
    }]));
    await writeFile(resolve(generatedDir, "hashes.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify({ operations: Object.keys(generated), hashes: manifest }, null, 2));
    await context.close();
  } finally {
    await browser?.close();
    await fixture.close();
  }
}

await run();
