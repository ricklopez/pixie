import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { AddressInfo } from "node:net";
import { openSqliteDatabase } from "../shared/sqlite.js";
import type { SqliteDatabase } from "../shared/sqlite.js";
import type { Task, Variant } from "../shared/types.js";

export const DEFAULT_HARNESS_TOKEN = "pixie-local-harness";

export interface FixtureOptions {
  variant?: Variant;
  dbPath?: string;
  harnessToken?: string;
  port?: number;
}

export interface FixtureServer {
  server: http.Server;
  baseUrl: string;
  variant: Variant;
  close(): Promise<void>;
  state(): Task[];
  reset(rows?: Task[]): void;
  injectFault(fault: string): void;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character);

function makeDatabase(path: string): SqliteDatabase {
  const db = openSqliteDatabase(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      done INTEGER NOT NULL CHECK(done IN (0, 1)),
      request_id TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS fixture_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_request_id_unique ON tasks(request_id)");
  return db;
}

function readTasks(db: SqliteDatabase): Task[] {
  return db.prepare("SELECT id, title, done, request_id AS requestId FROM tasks ORDER BY rowid").all()
    .map((row) => ({
      id: String(row.id),
      title: String(row.title),
      done: Number(row.done) === 1,
      requestId: row.requestId === null ? null : String(row.requestId)
    }));
}

function renderTask(task: Task, variant: Variant): string {
  const menu = variant === "locator-break";
  const requestMarker = task.requestId === null ? "" : ` data-request-id="${escapeHtml(task.requestId)}"`;
  const rename = menu
    ? `<button type="button" data-testid="task-actions" aria-label="Row actions">Actions</button>
       <div class="row-menu" hidden><button type="button" data-testid="edit-title">Change title</button></div>
       <button type="button" data-testid="delete-task" aria-label="Delete task">Delete</button>`
    : `<button type="button" data-testid="rename-task" aria-label="Rename task">Rename</button>
       <button type="button" data-testid="delete-task" aria-label="Delete task">Delete</button>`;
  return `<li class="task-row${task.done ? " is-done" : ""}" data-task-id="${escapeHtml(task.id)}" data-testid="task-row"${requestMarker}>
    <span class="task-title">${escapeHtml(task.title)}</span>
    <label><input type="checkbox" data-testid="task-done" ${task.done ? "checked" : ""}> Done</label>
    ${rename}
    <div class="editor" hidden>
      <label>${menu ? "Item title" : "New title"}
        <input type="text" data-testid="${menu ? "item-title" : "rename-input"}" aria-label="${menu ? "Item title" : "New title"}">
      </label>
      <button type="button" data-testid="${menu ? "commit-title" : "save-rename"}">${menu ? "Save title" : "Save rename"}</button>
      ${variant === "rule-change" ? '<label>Reason <input data-testid="rename-reason" aria-label="Reason" required></label>' : ""}
    </div>
  </li>`;
}

function renderPage(tasks: Task[], variant: Variant): string {
  const changed = variant === "locator-break";
  const cosmetic = variant === "cosmetic";
  const maxLength = variant === "rule-change" ? ' maxlength="20"' : "";
  const fieldTestId = "new-task-title";
  const fieldName = "Task title";
  const buttonTestId = "create-task";
  const buttonText = "Add task";
  const taskMarkup = tasks.map((task) => renderTask(task, variant)).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pixie synthetic todos</title>
<style>
body{font:16px system-ui,sans-serif;margin:32px auto;max-width:820px;padding:0 20px;background:#f7f8fa;color:#20242a}
header{display:flex;align-items:center;justify-content:space-between}
.notice{background:#e7f3ff;border:1px solid #b7d9f6;padding:10px;border-radius:5px}
form,li{background:white;border:1px solid #d3d8df;border-radius:6px;padding:12px;margin:10px 0}
ul{list-style:none;padding:0}.task-row{display:flex;align-items:center;gap:12px}.task-title{flex:1}
.is-done .task-title{text-decoration:line-through;color:#68717d}
button,input{font:inherit;padding:7px}.editor[hidden],.row-menu[hidden]{display:none}
.cosmetic main{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,2fr);gap:12px}
.cosmetic #task-list{grid-column:1;grid-row:1}.cosmetic #create-form{grid-column:2;grid-row:1}
.cosmetic li{border-radius:14px;box-shadow:0 2px 10px #0001}
</style></head>
<body data-ui-variant="${variant}" data-contract-revision="${variant === "rule-change" ? "changed" : "frozen"}" data-title-max-length="${variant === "rule-change" ? "20" : ""}">
<header><h1>Pixie synthetic todos</h1><span>Local fixture · synthetic data</span></header>
<p class="notice">This page is a disposable local test fixture. Task state is stored in SQLite.</p>
${variant === "rule-change" ? '<p role="alert" data-testid="business-rule">Updated rule: titles are limited to 20 characters and rename requires a reason.</p>' : ""}
<main class="${cosmetic ? "cosmetic" : ""}">
  <form id="create-form">
    <label>${fieldName}<input type="text" data-testid="${fieldTestId}" aria-label="${fieldName}"${maxLength}></label>
    <button type="submit" data-testid="${buttonTestId}">${buttonText}</button>
  </form>
  <ul id="task-list" aria-label="Tasks">${taskMarkup}</ul>
</main>
<script>
(() => {
  const list = document.querySelector("#task-list");
  const encode = (value) => JSON.stringify(value);
  const addTask = (task) => {
    const li = document.createElement("li");
    li.className = "task-row";
    li.dataset.taskId = task.id;
    li.dataset.testid = "task-row";
    if (task.requestId) li.dataset.requestId = task.requestId;
    li.innerHTML = \`<span class="task-title"></span><label><input type="checkbox" data-testid="task-done"> Done</label>
      ${changed ? '<button type="button" data-testid="task-actions" aria-label="Row actions">Actions</button><div class="row-menu" hidden><button data-testid="edit-title">Change title</button></div><button type="button" data-testid="delete-task" aria-label="Delete task">Delete</button>' : '<button type="button" data-testid="rename-task" aria-label="Rename task">Rename</button><button type="button" data-testid="delete-task" aria-label="Delete task">Delete</button>'}
      <div class="editor" hidden><label>${changed ? "Item title" : "New title"}<input type="text" data-testid="${changed ? "item-title" : "rename-input"}" aria-label="${changed ? "Item title" : "New title"}"></label><button type="button" data-testid="${changed ? "commit-title" : "save-rename"}">${changed ? "Save title" : "Save rename"}</button></div>\`;
    li.querySelector(".task-title").textContent = task.title;
    list.append(li);
  };
  const send = async (path, method, payload) => {
    const response = await fetch(path, {method, headers: {"content-type":"application/json"}, body: encode(payload)});
    if (!response.ok) throw new Error((await response.json()).error || "fixture write failed");
    return response.json();
  };
  document.querySelector("#create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const field = document.querySelector("[data-testid='${fieldTestId}']");
    try {
      const task = await send("/__app/tasks", "POST", {title: field.value});
      addTask(task);
      field.value = "";
    } catch (error) {
      document.body.dataset.lastError = error.message;
    }
  });
  list.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const row = button.closest("[data-task-id]");
    if (button.dataset.testid === "task-actions") {
      row.querySelector(".row-menu").hidden = false;
      return;
    }
    const renameButton = button.dataset.testid === "rename-task" || button.dataset.testid === "edit-title";
    const deleteButton = button.dataset.testid === "delete-task";
    if (renameButton) {
      row.querySelector(".editor").hidden = false;
      return;
    }
    if (deleteButton) {
      try {
        await send("/__app/tasks/" + encodeURIComponent(row.dataset.taskId), "DELETE", {});
        row.remove();
      } catch (error) {
        document.body.dataset.lastError = error.message;
      }
      return;
    }
    if (button.dataset.testid === "save-rename" || button.dataset.testid === "commit-title") {
      const newTitle = row.querySelector(".editor input[type=text]").value;
      const reason = row.querySelector("[data-testid='rename-reason']")?.value;
      try {
        const task = await send("/__app/tasks/" + encodeURIComponent(row.dataset.taskId), "PATCH", {newTitle, ...(reason ? {reason} : {})});
        row.dataset.requestId = task.requestId || "";
        row.querySelector(".task-title").textContent = task.title;
        row.classList.toggle("is-done", task.done);
        row.querySelector(".editor").hidden = true;
      } catch (error) {
        document.body.dataset.lastError = error.message;
      }
    }
  });
  list.addEventListener("change", (event) => {
    if (event.target.matches("[data-testid='task-done']")) {
      const row = event.target.closest("[data-task-id]");
      row.classList.toggle("is-done", event.target.checked);
    }
  });
})();
</script></body></html>`;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
    if (chunks.reduce((length, part) => length + part.length, 0) > 32_768) throw new Error("request body too large");
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function seedAmbiguous(db: SqliteDatabase): void {
  db.prepare("INSERT OR IGNORE INTO tasks (id, title, done, request_id) VALUES (?, ?, ?, NULL)")
    .run("a0000000-0000-4000-8000-000000000001", "pixie-demo Duplicate-looking task", 0);
  db.prepare("INSERT OR IGNORE INTO tasks (id, title, done, request_id) VALUES (?, ?, ?, NULL)")
    .run("a0000000-0000-4000-8000-000000000002", "pixie-demo Duplicate-looking task", 1);
}

export async function startFixture(options: FixtureOptions = {}): Promise<FixtureServer> {
  const variant = options.variant ?? "baseline";
  const harnessToken = options.harnessToken ?? DEFAULT_HARNESS_TOKEN;
  const db = makeDatabase(options.dbPath ?? ":memory:");
  if (variant === "ambiguous") seedAmbiguous(db);
  const getFault = () => db.prepare("SELECT value FROM fixture_meta WHERE key='fault'").get()?.value as string | undefined;
  const clearFault = () => db.prepare("DELETE FROM fixture_meta WHERE key='fault'").run();
  const setFault = (fault: string) =>
    db.prepare("INSERT INTO fixture_meta (key, value) VALUES ('fault', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(fault);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    const path = url.pathname;
    try {
      if (request.method === "GET" && path === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(renderPage(readTasks(db), variant));
        return;
      }
      if (["/__state", "/__reset", "/__fault"].includes(path) && request.headers["x-harness-token"] !== harnessToken) {
        sendJson(response, 403, { error: "harness authorization required" });
        return;
      }
      if (request.method === "GET" && path === "/__state") {
        sendJson(response, 200, { rows: readTasks(db) });
        return;
      }
      if (request.method === "POST" && path === "/__reset") {
        const body = await readBody(request);
        db.exec("DELETE FROM tasks");
        const rows = Array.isArray(body.rows) ? body.rows as Task[] : [];
        for (const row of rows) {
          db.prepare("INSERT INTO tasks (id, title, done, request_id) VALUES (?, ?, ?, ?)")
            .run(row.id, row.title, row.done ? 1 : 0, row.requestId);
        }
        if (!rows.length && variant === "ambiguous") seedAmbiguous(db);
        clearFault();
        sendJson(response, 200, { rows: readTasks(db) });
        return;
      }
      if (request.method === "POST" && path === "/__fault") {
        const body = await readBody(request);
        const fault = String(body.fault ?? "");
        if (!["create:after-persist-drop", "create:before-persist-fail", "create:after-confirm-drop"].includes(fault)) {
          sendJson(response, 400, { error: "unsupported fault" });
          return;
        }
        setFault(fault);
        sendJson(response, 200, { fault });
        return;
      }
      if (request.method === "POST" && path === "/__app/tasks") {
        const body = await readBody(request);
        const title = String(body.title ?? "");
        const requestId = String(request.headers["x-request-id"] ?? "");
        const fault = getFault();
        if (fault === "create:before-persist-fail") {
          clearFault();
          sendJson(response, 503, { error: "injected create failure before persist" });
          return;
        }
        if (variant === "rule-change" && (title.length > 20 || !String(body.reason ?? "").trim())) {
          sendJson(response, 422, { error: "business rule changed: title limit 20 and reason required" });
          return;
        }
        if (!title || !requestId) {
          sendJson(response, 400, { error: "title and request id are required" });
          return;
        }
        const existing = readTasks(db).find((task) => task.requestId === requestId);
        if (existing) {
          if (existing.title !== title) {
            sendJson(response, 409, { error: "request id reused with a different title" });
            return;
          }
          clearFault();
          sendJson(response, 200, existing);
          return;
        }
        const row: Task = { id: randomUUID(), title, done: false, requestId };
        db.prepare("INSERT INTO tasks (id, title, done, request_id) VALUES (?, ?, 0, ?)").run(row.id, row.title, row.requestId);
        if (fault === "create:after-persist-drop") {
          clearFault();
          request.socket.destroy();
          return;
        }
        clearFault();
        sendJson(response, 201, row);
        if (fault === "create:after-confirm-drop") setImmediate(() => request.socket.destroy());
        return;
      }
      const taskPath = path.match(/^\/__app\/tasks\/([^/]+)$/);
      if (taskPath && request.method === "PATCH") {
        const body = await readBody(request);
        const id = decodeURIComponent(taskPath[1] ?? "");
        const existing = readTasks(db).find((row) => row.id === id);
        if (!existing) {
          sendJson(response, 404, { error: "task not found" });
          return;
        }
        const requestId = String(request.headers["x-request-id"] ?? "");
        const newTitle = String(body.newTitle ?? "");
        if (variant === "rule-change" && (newTitle.length > 20 || !String(body.reason ?? "").trim())) {
          sendJson(response, 422, { error: "business rule changed: title limit 20 and reason required" });
          return;
        }
        db.prepare("UPDATE tasks SET title=?, request_id=? WHERE id=?").run(newTitle, requestId, id);
        sendJson(response, 200, { ...existing, title: newTitle, requestId });
        return;
      }
      if (taskPath && request.method === "DELETE") {
        const id = decodeURIComponent(taskPath[1] ?? "");
        const existing = readTasks(db).find((row) => row.id === id);
        if (!existing) {
          sendJson(response, 404, { error: "task not found" });
          return;
        }
        db.prepare("DELETE FROM tasks WHERE id=?").run(id);
        sendJson(response, 200, { deleted: id });
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (!response.headersSent) sendJson(response, 400, { error: error instanceof Error ? error.message : "bad request" });
      else response.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    variant,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    },
    state: () => readTasks(db),
    reset(rows = []) {
      db.exec("DELETE FROM tasks");
      for (const row of rows) {
        db.prepare("INSERT INTO tasks (id, title, done, request_id) VALUES (?, ?, ?, ?)")
          .run(row.id, row.title, row.done ? 1 : 0, row.requestId);
      }
      if (!rows.length && variant === "ambiguous") seedAmbiguous(db);
      clearFault();
    },
    injectFault: setFault
  };
}

export async function fetchHarnessState(baseUrl: string, token = DEFAULT_HARNESS_TOKEN): Promise<Task[]> {
  const response = await fetch(`${baseUrl}/__state`, { headers: { "x-harness-token": token } });
  if (!response.ok) throw new Error(`fixture state read failed: ${response.status}`);
  return ((await response.json()) as { rows: Task[] }).rows;
}

export async function resetFixture(baseUrl: string, rows: Task[] = [], token = DEFAULT_HARNESS_TOKEN): Promise<Task[]> {
  const response = await fetch(`${baseUrl}/__reset`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ rows })
  });
  if (!response.ok) throw new Error(`fixture reset failed: ${response.status}`);
  return ((await response.json()) as { rows: Task[] }).rows;
}

export async function setFixtureFault(baseUrl: string, fault: string, token = DEFAULT_HARNESS_TOKEN): Promise<void> {
  const response = await fetch(`${baseUrl}/__fault`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ fault })
  });
  if (!response.ok) throw new Error(`fixture fault injection failed: ${response.status}`);
}
