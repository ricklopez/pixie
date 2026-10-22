import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { createPortal } from "../src/server.js";
import { lookup } from "../src/fixtures.js";

const state = { sessionActive: true };
const server = createPortal(state);
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`, { redirect: "manual" });
  return { status: res.status, text: await res.text() };
};

test("valid members render distinct data and a synthetic banner", async () => {
  const a = await get("/demo-portal/members?memberId=DEMO-1001");
  const b = await get("/demo-portal/members/DEMO-1002/benefits");
  assert.equal(a.status, 200);
  assert.match(a.text, /Synthetic demo data only/);
  assert.match(a.text, /DEMO-1001/);
  assert.match(b.text, /DEMO-1002/);
  assert.notEqual(lookup("DEMO-1001")?.plan, lookup("DEMO-1002")?.plan);
});

test("wrong-member fixture returns another member's record", async () => {
  const r = await get("/demo-portal/members?memberId=DEMO-2001");
  assert.match(r.text, /DEMO-2002/);
  assert.doesNotMatch(r.text, /<dd>DEMO-2001<\/dd>/);
});

test("incomplete fixture omits eligibility status and deductible", async () => {
  const m = lookup("DEMO-3001");
  assert.ok(m);
  assert.equal(m.eligibilityStatus, "");
  assert.ok(!m.benefits.some((b) => /deductible/i.test(b.benefit)));
});

test("unknown member and expired session states", async () => {
  assert.match((await get("/demo-portal/members?memberId=DEMO-9999")).text, /No member found/);
  state.sessionActive = false;
  assert.match((await get("/demo-portal/members?memberId=DEMO-1001")).text, /session has expired/);
  const res = await fetch(`${base}/demo-portal/admin/session`, { method: "POST", body: "state=active", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.deepEqual(await res.json(), { sessionActive: true });
});
