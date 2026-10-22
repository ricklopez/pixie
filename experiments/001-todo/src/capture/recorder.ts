import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Locator, Page } from "playwright";
import type { CapturedAction, CapturedActionKind, LocatorCandidate, Operation, Trace } from "../shared/types.js";

export const CAPTURE_VERSION = "pixie-demo-capture/1.0.0";

const require = createRequire(import.meta.url);
const playwrightPackage = require("playwright/package.json") as { version: string };

interface DemonstrationStep {
  kind: CapturedActionKind;
  locator: Locator;
  inputBinding?: string;
  scopeBinding?: string;
  execute?: () => Promise<unknown>;
}

export function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input);
    if (["127.0.0.1", "localhost", "fixture.local"].includes(url.hostname)) {
      url.hostname = "fixture.local";
      url.port = "";
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid://redacted";
  }
}

async function locatorCandidates(locator: Locator): Promise<LocatorCandidate[]> {
  if (await locator.count() !== 1) return [];
  return locator.evaluate((element) => {
    const node = element as HTMLElement;
    const tag = node.tagName.toLowerCase();
    const testid = node.getAttribute("data-testid") ?? undefined;
    const ariaLabel = node.getAttribute("aria-label")?.trim();
    const labels = "labels" in node ? (node as HTMLInputElement).labels : null;
    const label = labels?.[0]?.textContent?.trim() || node.closest("label")?.textContent?.trim() || undefined;
    const text = tag === "input" || tag === "textarea" ? undefined : node.innerText?.replace(/\s+/g, " ").trim();
    const accessibleName = ariaLabel || label || text;
    const implicitRole =
      node.getAttribute("role") ??
      (tag === "button" ? "button" : tag === "input" ? ((node as HTMLInputElement).type === "checkbox" ? "checkbox" : "textbox") : undefined);
    let current: HTMLElement | null = node;
    const parts: string[] = [];
    while (current && current !== document.body && parts.length < 5) {
      const siblingIndex = current.parentElement
        ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current?.tagName).indexOf(current) + 1
        : 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblingIndex})`);
      current = current.parentElement;
    }
    return [{
      ...(testid ? { testid } : {}),
      ...(implicitRole ? { role: implicitRole } : {}),
      ...(accessibleName ? { accessibleName } : {}),
      ...(label ? { label } : {}),
      ...(text ? { text } : {}),
      cssPath: parts.join(" > ")
    }];
  });
}

export async function recordDemonstration(
  page: Page,
  operation: Operation,
  inputs: string[],
  steps: DemonstrationStep[]
): Promise<Trace> {
  const actions: CapturedAction[] = [];
  for (const step of steps) {
    const urlBefore = sanitizeUrl(page.url());
    const candidates = await locatorCandidates(step.locator);
    if (step.execute) await step.execute();
    const urlAfter = sanitizeUrl(page.url());
    actions.push({
      kind: step.kind,
      ...(step.inputBinding ? { inputBinding: step.inputBinding } : {}),
      ...(step.scopeBinding ? { scopeBinding: step.scopeBinding } : {}),
      locatorCandidates: candidates,
      urlBefore,
      urlAfter,
      sanitized: true
    });
  }
  const version = await page.context().browser()?.version();
  return {
    traceVersion: 1,
    operation,
    demonstrationSource: "synthetic-scripted",
    inputs: [...inputs],
    actions,
    versions: {
      capture: CAPTURE_VERSION,
      playwright: playwrightPackage.version,
      chromium: version ?? "unknown"
    }
  };
}

export function playwrightVersion(): string {
  return playwrightPackage.version;
}

export function readCapturedTrace(path: string): Trace {
  return JSON.parse(readFileSync(path, "utf8")) as Trace;
}
