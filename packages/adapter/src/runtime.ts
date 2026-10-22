import type { Locator, Page } from "playwright-core";

let actionCount = 0;
const scriptStarted = Number(process.env.PIXIE_SCRIPT_STARTED_AT ?? Date.now());

function checkActionBudget() {
  actionCount += 1;
  if (actionCount > Number(process.env.PIXIE_SCRIPT_MAX_ACTIONS ?? 100)) throw new Error("script action budget exhausted");
  if (Date.now() - scriptStarted > Number(process.env.PIXIE_SCRIPT_DEADLINE_MS ?? 180000)) throw new Error("script deadline exceeded");
}

export async function locate(page: Page, candidate: { label?: string; role?: string; name?: string; id?: string; text?: string; css?: string }): Promise<Locator> {
  const candidates: Locator[] = [];
  if (candidate.label) candidates.push(page.getByLabel(candidate.label, { exact: true }));
  if (candidate.role && candidate.name) candidates.push(page.getByRole(candidate.role as never, { name: candidate.name, exact: true }));
  if (candidate.id) candidates.push(page.locator(`#${candidate.id.replace(/([\\.#:[\],])/g, "\\$1")}`));
  if (candidate.text) candidates.push(page.getByText(candidate.text, { exact: true }));
  if (candidate.css) candidates.push(page.locator(candidate.css));
  for (const locator of candidates) {
    const count = await locator.count();
    if (count === 1 && await locator.isVisible()) {
      return new Proxy(locator, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (["click", "fill", "press", "selectOption"].includes(String(property)) && typeof value === "function") {
            return (...args: unknown[]) => {
              checkActionBudget();
              return (value as (...items: unknown[]) => unknown).apply(target, args);
            };
          }
          return value;
        }
      });
    }
    if (count > 1) throw new Error(`recorded locator matched ${count} elements`);
  }
  throw new Error("recorded locator did not match one visible element");
}

export async function checkpoint(page: Page): Promise<void> {
  if (Date.now() - scriptStarted > Number(process.env.PIXIE_SCRIPT_DEADLINE_MS ?? 180000)) throw new Error("script deadline exceeded");
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
}
