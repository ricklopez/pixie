import type { ListItem, OutputField, ListSpec } from "@gateway/definition";
import type { Locator, Page } from "playwright-core";

let actionCount = 0;
const scriptStarted = Number(process.env.PIXIE_SCRIPT_STARTED_AT ?? Date.now());

function checkActionBudget() {
  actionCount += 1;
  if (actionCount > Number(process.env.PIXIE_SCRIPT_MAX_ACTIONS ?? 100)) throw new Error("script action budget exhausted");
  if (Date.now() - scriptStarted > Number(process.env.PIXIE_SCRIPT_DEADLINE_MS ?? 180000)) throw new Error("script deadline exceeded");
}

export function scriptActionCount(): number {
  return actionCount;
}

const READ_LOCATOR_METHODS = new Set(["count", "isVisible", "textContent", "innerText", "allInnerTexts", "getAttribute", "first", "last", "nth", "filter"]);
const PAGE_LOCATOR_METHODS = new Set(["getByLabel", "getByRole", "getByText", "getByPlaceholder", "locator"]);

function guardedLocator(locator: Locator): Locator {
  return new Proxy(locator, {
    get(target, property, receiver) {
      if (property === "then") return undefined;
      const name = String(property);
      if (name === "locator") return (...args: unknown[]) => guardedLocator((target.locator as (...values: unknown[]) => Locator).apply(target, args));
      if (name === "all") return async () => Promise.all(await target.all().then((items) => items.map(guardedLocator)));
      if (name === "click" || name === "fill" || name === "press" || name === "selectOption") {
        return (...args: unknown[]) => {
          checkActionBudget();
          return (target[name] as (...values: unknown[]) => unknown).apply(target, args);
        };
      }
      if (READ_LOCATOR_METHODS.has(name)) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value === "function") return value.bind(target);
        return value;
      }
      throw new Error(`script locator method '${name}' is not allowed`);
    }
  });
}

export function guardScriptPage(page: Page): Page {
  return new Proxy(page, {
    get(target, property, receiver) {
      const name = String(property);
      if (PAGE_LOCATOR_METHODS.has(name)) {
        const method = Reflect.get(target, property, target) as (...args: unknown[]) => Locator;
        return (...args: unknown[]) => guardedLocator(method.apply(target, args));
      }
      if (name === "waitForLoadState" || name === "url") {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      throw new Error(`script page method '${name}' is not allowed`);
    }
  });
}

export async function locate(page: Page, candidate: { label?: string; role?: string; name?: string; id?: string; text?: string; css?: string }): Promise<Locator> {
  const candidates: Locator[] = [];
  if (candidate.label) candidates.push(page.getByLabel(candidate.label, { exact: true }));
  if (candidate.role && candidate.name) candidates.push(page.getByRole(candidate.role as never, { name: candidate.name, exact: true }));
  if (candidate.name) candidates.push(page.locator(`[name="${candidate.name.replace(/["\\]/g, "\\$&")}"]`));
  if (candidate.id) candidates.push(page.locator(`#${candidate.id.replace(/([\\.#:[\],])/g, "\\$1")}`));
  if (candidate.text) candidates.push(page.getByText(candidate.text, { exact: true }));
  if (candidate.css) candidates.push(page.locator(candidate.css));
  for (const locator of candidates) {
    const count = await locator.count();
    if (count === 1 && await locator.isVisible()) {
      return guardedLocator(locator);
    }
    if (count > 1) throw new Error(`recorded locator matched ${count} elements`);
  }
  throw new Error("recorded locator did not match one visible element");
}

export async function checkpoint(page: Page): Promise<void> {
  if (Date.now() - scriptStarted > Number(process.env.PIXIE_SCRIPT_DEADLINE_MS ?? 180000)) throw new Error("script deadline exceeded");
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
}

export async function extractOutputs(
  page: Page,
  fields: OutputField[],
  lists: Record<string, ListSpec>
): Promise<Record<string, string | ListItem[] | null>> {
  const result: Record<string, string | ListItem[] | null> = {};
  for (const field of fields) {
    const extractor = field.extractor;
    if (extractor.kind === "observedAt") {
      result[field.name] = new Date().toISOString();
      continue;
    }
    if (extractor.kind === "labelValue") {
      const label = page.getByText(extractor.label, { exact: true });
      if (await label.count() !== 1) throw new Error(`output label '${extractor.label}' did not match exactly one element`);
      result[field.name] = (await label.locator("xpath=following-sibling::*[1]").textContent())?.trim() ?? null;
      continue;
    }
    if (extractor.kind === "tableCell") {
      const table = page.getByRole("table", { name: extractor.table, exact: true });
      if (await table.count() !== 1) throw new Error(`output table '${extractor.table}' did not match exactly one table`);
      const tableRows = await table.locator("tr").all();
      const rows = await Promise.all(tableRows.map((row) => row.locator("th, td").allInnerTexts()));
      const headers = rows[0] ?? [];
      const rowIndex = headers.indexOf(extractor.column);
      const whereIndex = extractor.where ? headers.indexOf(extractor.where.column) : 0;
      if (rowIndex < 0 || whereIndex < 0) throw new Error(`output table '${extractor.table}' is missing a declared column`);
      const matching = rows.slice(1).filter((cells) =>
        cells[0] === extractor.rowLabel && (!extractor.where || cells[whereIndex] === extractor.where.equals)
      );
      if (matching.length !== 1) throw new Error(`output row '${extractor.rowLabel}' did not match exactly one row`);
      result[field.name] = matching[0]?.[rowIndex] ?? null;
      continue;
    }
    if (extractor.kind === "listItems") {
      const spec = lists[extractor.list];
      if (!spec) throw new Error(`output list '${extractor.list}' has no reviewed locator`);
      const items = await page.locator(spec.item).all();
      const values: ListItem[] = [];
      for (const item of items) {
        const text = (await item.locator(spec.text).textContent())?.trim();
        if (!text) continue;
        values.push({ text, completed: spec.completed ? (await item.locator(spec.completed).count()) > 0 : false });
      }
      result[field.name] = values;
    }
  }
  return result;
}
