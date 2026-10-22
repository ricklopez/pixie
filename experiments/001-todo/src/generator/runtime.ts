import type { Locator, Page } from "playwright";
import type { LocatorCandidate, PublicTask, Task } from "../shared/types.js";

export class LocatorResolutionError extends Error {}

function candidatesInPriority(scope: Page | Locator, candidate: LocatorCandidate): Locator[] {
  const possible: Locator[] = [];
  if (candidate.testid) possible.push(scope.getByTestId(candidate.testid));
  if (candidate.role && candidate.accessibleName) {
    possible.push(scope.getByRole(candidate.role as never, { name: candidate.accessibleName, exact: true }));
  }
  if (candidate.label) possible.push(scope.getByLabel(candidate.label, { exact: true }));
  if (candidate.text) possible.push(scope.getByText(candidate.text, { exact: true }));
  if (candidate.cssPath) possible.push(scope.locator(candidate.cssPath));
  return possible;
}

export async function locate(scope: Page | Locator, candidate: LocatorCandidate): Promise<Locator> {
  for (const locator of candidatesInPriority(scope, candidate)) {
    const count = await locator.count();
    if (count > 1) throw new LocatorResolutionError(`locator matched ${count} elements`);
    if (count === 1 && await locator.isVisible()) return locator;
  }
  throw new LocatorResolutionError("no captured locator matched exactly one visible element");
}

export function taskRow(page: Page, id: string): Locator {
  return page.locator(`[data-task-id="${escapeAttribute(id)}"]`);
}

export async function readVisibleTasks(page: Page): Promise<PublicTask[]> {
  return page.locator("[data-task-id]").evaluateAll((rows) =>
    rows.map((row) => ({
      id: (row as HTMLElement).dataset.taskId ?? "",
      title: row.querySelector(".task-title")?.textContent ?? "",
      done: Boolean(row.querySelector("input[type=checkbox]")?.matches(":checked"))
    }))
  );
}

export async function readVisibleTasksWithRequestId(page: Page): Promise<Task[]> {
  return page.locator("[data-task-id]").evaluateAll((rows) =>
    rows.map((row) => ({
      id: (row as HTMLElement).dataset.taskId ?? "",
      title: row.querySelector(".task-title")?.textContent ?? "",
      done: Boolean(row.querySelector("input[type=checkbox]")?.matches(":checked")),
      requestId: (row as HTMLElement).dataset.requestId ?? null
    }))
  );
}

export async function waitForTask(page: Page, requestId: string, title: string, id?: string): Promise<PublicTask> {
  await page.waitForFunction(
    ({ wantedRequestId, wantedTitle, wantedId }) => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-task-id]"));
      return rows.some((row) => {
        const rowTitle = row.querySelector(".task-title")?.textContent ?? "";
        return (wantedRequestId && row.dataset.requestId === wantedRequestId && rowTitle === wantedTitle) ||
          (wantedId && row.dataset.taskId === wantedId && rowTitle === wantedTitle) ||
          (!wantedId && rowTitle === wantedTitle);
      });
    },
    { wantedRequestId: requestId, wantedTitle: title, wantedId: id },
    { timeout: 1800 }
  );
  const tasks = await readVisibleTasksWithRequestId(page);
  const found = tasks.find((task) =>
    (requestId && task.requestId === requestId && task.title === title) ||
    (id && task.id === id && task.title === title) ||
    (!id && task.title === title)
  );
  if (!found) throw new LocatorResolutionError("written task was not confirmed in the UI");
  return { id: found.id, title: found.title, done: found.done };
}

export async function waitForTaskRemoval(page: Page, id: string): Promise<void> {
  await page.waitForFunction((wantedId) => !Array.from(document.querySelectorAll<HTMLElement>("[data-task-id]")).some((row) => row.dataset.taskId === wantedId), id, {
    timeout: 1800
  });
}

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
