// source: human-authored-test-candidate
import type { Page } from "playwright";

interface RenameArgs {
  id: string;
  newTitle: string;
  requestId: string;
}

export async function rename(page: Page, args: RenameArgs): Promise<{ id: string; title: string; done: boolean }> {
  const escapedId = args.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const row = page.locator(`[data-task-id="${escapedId}"]`);
  if (await row.count() !== 1) throw new Error("candidate target id is not exact");
  const currentTitle = await row.locator(".task-title").textContent();
  const titleMatches = await page.locator(".task-title").allTextContents();
  if (titleMatches.filter((title) => title === currentTitle).length !== 1) {
    throw new Error("candidate title is ambiguous");
  }

  const menu = row.getByRole("button", { name: "Row actions", exact: true });
  if (await menu.count() === 1) {
    await menu.click();
    await row.getByRole("button", { name: "Change title", exact: true }).click();
  } else {
    await row.getByRole("button", { name: "Rename task", exact: true }).click();
  }
  const changedEditor = row.getByRole("textbox", { name: "Item title", exact: true });
  const baselineEditor = row.getByRole("textbox", { name: "New title", exact: true });
  const editor = await changedEditor.count() === 1 ? changedEditor : baselineEditor;
  if (await editor.count() !== 1) throw new Error("candidate could not identify the title editor");
  await editor.fill(args.newTitle);
  const changedSave = row.getByRole("button", { name: "Save title", exact: true });
  const baselineSave = row.getByRole("button", { name: "Save rename", exact: true });
  const save = await changedSave.count() === 1 ? changedSave : baselineSave;
  if (await save.count() !== 1) throw new Error("candidate could not identify the save control");
  await save.click();
  await page.waitForFunction(({ id, newTitle, requestId }) => {
    const target = document.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
    if (!target) return false;
    return target.querySelector(".task-title")?.textContent === newTitle && target.dataset.requestId === requestId;
  }, args, { timeout: 1800 });
  return {
    id: args.id,
    title: args.newTitle,
    done: await row.locator("input[type=checkbox]").isChecked()
  };
}
