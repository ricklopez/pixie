import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { doctorChecks, init, loadProject, main } from "../src/main.js";

const capture = () => {
  const lines: string[] = [];
  return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) } };
};

test("pixie init scaffolds a project once and refuses to overwrite a non-empty directory", async () => {
  const dir = resolve(mkdtempSync(resolve(tmpdir(), "pixie-init-")), "proj");
  const { lines, out } = capture();
  assert.equal(init(dir, out), 0);
  assert.ok(existsSync(resolve(dir, "pixie.json")));
  assert.ok(!existsSync(resolve(dir, ".env")), "init must not create a secrets file");
  assert.equal(loadProject(dir).accountId, "acct_todo");
  writeFileSync(resolve(dir, "pixie.json"), JSON.stringify({ accountId: "acct_mine" }));
  assert.equal(init(dir, out), 1);
  assert.equal(loadProject(dir).accountId, "acct_mine", "existing pixie.json untouched");
  assert.ok(lines.some((l) => l.includes("refusing")));
  assert.equal(readFileSync(resolve(dir, ".env.example"), "utf8").includes("TYPESAFE_API_KEY="), true);
});

test("pixie doctor reports a missing live model variable as a failure and unreachable services as warnings", async () => {
  const project = { ...loadProject("/nonexistent"), apiUrl: "http://127.0.0.1:1", studioUrl: "http://127.0.0.1:1" };
  const checks = await doctorChecks(project, { PATH: process.env.PATH }, mkdtempSync(resolve(tmpdir(), "pixie-empty-")));
  const byName = (prefix: string) => checks.find((c) => c.name.startsWith(prefix))!;
  assert.deepEqual([byName("TYPESAFE_API_KEY").ok, byName("TYPESAFE_API_KEY").level], [false, "fail"]);
  assert.equal(byName("worker environment").ok, false);
  assert.equal(byName("gateway built").ok, false);
  assert.deepEqual([byName("API at").ok, byName("API at").level], [false, "warn"]);
  const scripted = await doctorChecks({ ...project, engine: "scripted" }, { PATH: process.env.PATH });
  assert.deepEqual([byName("TYPESAFE_API_KEY").level, scripted.find((c) => c.name.startsWith("TYPESAFE"))!.ok], ["fail", true]);
});

test("pixie test and publish drive the Studio API and surface refusals instead of pretending", async () => {
  const requests: { method: string; url: string; auth: string | undefined }[] = [];
  let polls = 0;
  const server = createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/studio/automations/auto-1/test") return send(202, { id: "run-1", state: "queued" });
    if (req.url === "/studio/runs/run-1") {
      polls += 1;
      return send(200, {
        run: { id: "run-1", state: polls < 2 ? "running" : "needs_review", failure: { reason: "independent verification rejected the extracted result" } },
        verification: { accepted: false, checks: [{ id: "mutation:add", passed: false, detail: "count unchanged" }], reasons: [] },
        data: null,
        screenshots: [{}]
      });
    }
    if (req.url === "/studio/automations/auto-1/publish") return send(409, { error: "only automations in state 'ready' can be published" });
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const cwd = mkdtempSync(resolve(tmpdir(), "pixie-proj-"));
  writeFileSync(resolve(cwd, "pixie.json"), JSON.stringify({ apiUrl: `http://127.0.0.1:${port}`, accountId: "acct_x" }));
  const previous = process.cwd();
  process.chdir(cwd);
  process.env.GATEWAY_DEV_TOKEN = "tok";
  try {
    const t = capture();
    assert.equal(await main(["test", "auto-1", "--input", "{\"title\":\"pixie-demo x\"}"], t.out), 1);
    assert.ok(t.lines.some((l) => l === "state: needs_review"));
    assert.ok(t.lines.some((l) => l.includes("FAIL  mutation:add count unchanged")));
    assert.ok(!t.lines.some((l) => l.startsWith("data:")), "unaccepted runs expose no data");
    assert.equal(requests[0]!.auth, "Bearer tok");

    const p = capture();
    assert.equal(await main(["publish", "auto-1"], p.out), 1);
    assert.ok(p.lines.some((l) => l.includes("publish refused: HTTP 409")));

    const u = capture();
    assert.equal(await main(["record"], u.out), 2);
    assert.ok(u.lines.some((l) => l.includes("unknown command")));
  } finally {
    process.chdir(previous);
    server.close();
  }
});
