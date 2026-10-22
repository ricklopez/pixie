import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readVisibleTasks, readVisibleTasksWithRequestId } from "../generator/runtime.js";
import { blockNodeRequests, installBrowserRequestGuard, ModelCallGuard } from "./model-guard.js";
import { TODO_PREFIX, type GeneratedArgs, type Operation, type PublicTask, type Task } from "../shared/types.js";

interface ChildRequest {
  baseUrl: string;
  op: Operation;
  input: GeneratedArgs;
}

interface ChildResponse {
  result?: PublicTask | PublicTask[];
  visibleTasks: Task[];
  guard?: "needs_review" | "rejected" | "contract_revision_required";
  error?: string;
  dispatchCount: number;
  modelCallAttempts: number;
  ruleRevision: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function guardBeforeWrite(page: Page, op: Operation, input: GeneratedArgs): Promise<ChildResponse["guard"]> {
  if (op === "list") return undefined;
  const meta = await page.locator("body").evaluate((body) => ({
    revision: (body as HTMLElement).dataset.contractRevision,
    maxLength: (body as HTMLElement).dataset.titleMaxLength
  }));
  if (meta.revision === "changed" || meta.maxLength) return "contract_revision_required";
  const rows = await readVisibleTasksWithRequestId(page);
  if (op === "create") {
    if (rows.some((row) => row.title === input.title)) return "needs_review";
    return undefined;
  }
  if (!input.id) return "needs_review";
  const matchingId = rows.filter((row) => row.id === input.id);
  if (matchingId.length !== 1) return "needs_review";
  const target = matchingId[0]!;
  if (!target.title.startsWith(TODO_PREFIX)) return "rejected";
  if (rows.filter((row) => row.title === target.title).length !== 1) return "needs_review";
  if (op === "rename" && rows.some((row) => row.id !== target.id && row.title === input.newTitle)) return "needs_review";
  if (op === "rename" && typeof input.newTitle === "string" && !input.newTitle.startsWith(TODO_PREFIX)) return "rejected";
  return undefined;
}

async function readStdin(): Promise<ChildRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChildRequest;
}

async function run(request: ChildRequest): Promise<ChildResponse> {
  const modelGuard = new ModelCallGuard();
  const restoreNodeRequests = blockNodeRequests(modelGuard);
  let dispatchCount = 0;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let visibleTasks: Task[] = [];
  let ruleRevision = "unknown";
  let result: PublicTask | PublicTask[] | undefined;
  let guard: ChildResponse["guard"];
  let error: string | undefined;
  try {
    browser = await chromium.launch({ headless: true, timeout: 5000 });
    context = await browser.newContext();
    const requestId = request.input.requestId ?? "";
    await installBrowserRequestGuard(context, modelGuard, requestId, () => { dispatchCount += 1; });
    const page = await context.newPage();
    page.setDefaultTimeout(2000);
    page.setDefaultNavigationTimeout(5000);
    await page.goto(request.baseUrl, { waitUntil: "domcontentloaded", timeout: 5000 });
    ruleRevision = await page.locator("body").getAttribute("data-contract-revision") ?? "unknown";
    guard = await guardBeforeWrite(page, request.op, request.input);
    if (!guard) {
      const generatedPath = resolve(packageRoot, `generated/baseline/${request.op}.ts`);
      const moduleUrl = `${pathToFileURL(generatedPath).href}?run=${Date.now()}`;
      const generated = await import(moduleUrl) as Record<string, (page: Page, args: GeneratedArgs) => Promise<PublicTask | PublicTask[] | undefined>>;
      result = await generated[request.op]!(page, request.input);
    }
    visibleTasks = await readVisibleTasksWithRequestId(page);
    if (request.op === "list" && !guard) result = await readVisibleTasks(page);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "runner child failed";
    try {
      if (context) {
        const page = context.pages()[0];
        if (page && !page.isClosed()) visibleTasks = await readVisibleTasksWithRequestId(page);
      }
    } catch {
      visibleTasks = [];
    }
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    restoreNodeRequests();
  }
  return {
    ...(result === undefined ? {} : { result }),
    visibleTasks,
    ...(guard ? { guard } : {}),
    ...(error ? { error } : {}),
    dispatchCount,
    modelCallAttempts: modelGuard.count(),
    ruleRevision
  };
}

const main = async () => {
  try {
    const response = await run(await readStdin());
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      visibleTasks: [],
      error: error instanceof Error ? error.message : "runner child failed",
      dispatchCount: 0,
      modelCallAttempts: 0,
      ruleRevision: "unknown"
    } satisfies ChildResponse)}\n`);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
