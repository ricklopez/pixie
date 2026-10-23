/**
 * Synthetic eligibility portal. Clearly labeled demo fixture; not a payer integration.
 * Server-rendered HTML so both a human and the engine see the same plain controls.
 */
import http from "node:http";
import { URL } from "node:url";
import { lookup, type Member } from "./fixtures.js";

export interface PortalState {
  sessionActive: boolean;
  labelVariant?: boolean;
}

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)} · Synthetic Eligibility Portal</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#f4f6f8;color:#1b1f23}
header{background:#22324a;color:#fff;padding:12px 24px;display:flex;justify-content:space-between;align-items:center}
.banner{background:#ffe9a8;color:#5a4300;padding:6px 24px;font-size:14px}
main{max-width:860px;margin:24px auto;background:#fff;padding:24px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
dl{display:grid;grid-template-columns:220px 1fr;gap:6px 16px}dt{color:#555}dd{margin:0;font-weight:600}
table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}th{background:#f0f3f6}
input,button{font:inherit;padding:8px 10px}button{background:#22324a;color:#fff;border:0;border-radius:4px;cursor:pointer}
.muted{color:#666;font-size:14px}a{color:#0b57d0}
</style></head><body>
<header><strong>Synthetic Eligibility Portal</strong><nav><a style="color:#fff" href="/demo-portal">Home</a></nav></header>
<div class="banner">Synthetic demo data only. Members, plans and amounts are fictional.</div>
<main>${body}</main></body></html>`;
}

function loginPage(next: string): string {
  return layout(
    "Sign in",
    `<h1>Sign in</h1><p class="muted">Your portal session has expired. Sign in to continue.</p>
<form method="post" action="/demo-portal/login">
<input type="hidden" name="next" value="${escape(next)}">
<p><label>Username <input name="username" autocomplete="username"></label></p>
<p><label>Password <input name="password" type="password" autocomplete="current-password"></label></p>
<button type="submit">Sign in</button></form>`
  );
}

function searchPage(message = "", label = "Member ID"): string {
  return layout(
    "Member search",
    `<h1>Member search</h1>
${message ? `<p role="alert">${escape(message)}</p>` : ""}
<form method="get" action="/demo-portal/members">
<p><label>${label} <input name="memberId" placeholder="DEMO-1001" required></label></p>
<button type="submit">Search</button></form>
<p class="muted">Try DEMO-1001 or DEMO-1002. DEMO-2001 returns another member's record; DEMO-3001 is incomplete.</p>`
  );
}

function summary(member: Member): string {
  return `<dl>
<dt>Member ID</dt><dd>${escape(member.memberId)}</dd>
<dt>Name</dt><dd>${escape(member.name)}</dd>
<dt>Eligibility status</dt><dd>${escape(member.eligibilityStatus)}</dd>
<dt>Plan</dt><dd>${escape(member.plan)}</dd>
<dt>Effective from</dt><dd>${escape(member.effectiveFrom)}</dd>
<dt>Effective to</dt><dd>${escape(member.effectiveTo)}</dd>
<dt>Source date</dt><dd>${escape(member.sourceDate)}</dd>
</dl>`;
}

function memberPage(member: Member): string {
  return layout(
    "Member result",
    `<h1>Member result</h1>${summary(member)}
<p><a href="/demo-portal/members/${encodeURIComponent(member.memberId)}/benefits">View benefits overview</a></p>
<p><a href="/demo-portal">New search</a></p>`
  );
}

function benefitsPage(member: Member): string {
  const rows = member.benefits
    .map(
      (r) =>
        `<tr><td>${escape(r.benefit)}</td><td>${escape(r.period)}</td><td>${escape(r.network)}</td><td>${escape(r.amount)}</td><td>${escape(r.remaining)}</td></tr>`
    )
    .join("");
  return layout(
    "Benefits overview",
    `<h1>Benefits overview</h1>${summary(member)}
<h2>Benefits</h2>
<table aria-label="Benefits"><thead><tr><th>Benefit</th><th>Period</th><th>Network</th><th>Amount</th><th>Remaining</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">No benefit rows available.</td></tr>'}</tbody></table>
<h2>Qualifications</h2><ul>${member.qualifications.map((q) => `<li>${escape(q)}</li>`).join("")}</ul>
<p><a href="/demo-portal">New search</a></p>`
  );
}

export function createPortal(state: PortalState = { sessionActive: true }): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: string, type = "text/html; charset=utf-8", headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
      res.end(body);
    };
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" ) return send(302, "", "text/plain", { location: "/demo-portal" });

    // Synthetic operator controls: force the login-required state or restore it.
    if (path === "/demo-portal/admin/session") {
      if (req.method === "POST") {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const wanted = params.get("state") ?? url.searchParams.get("state");
        if (wanted === "expired") state.sessionActive = false;
        else if (wanted === "active") state.sessionActive = true;
        else return send(400, JSON.stringify({ error: "state must be expired|active" }), "application/json");
      }
      return send(200, JSON.stringify({ sessionActive: state.sessionActive }), "application/json");
    }

    if (path === "/demo-portal/login" && req.method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      state.sessionActive = true;
      const next = params.get("next") ?? "/demo-portal";
      return send(302, "", "text/plain", { location: next.startsWith("/demo-portal") ? next : "/demo-portal" });
    }

    if (!path.startsWith("/demo-portal")) return send(404, layout("Not found", "<h1>Not found</h1>"));

    if (!state.sessionActive) return send(200, loginPage(url.pathname + url.search));

    if (path === "/demo-portal/admin/label-variant") {
      if (req.method === "POST") {
        const form = new URLSearchParams(await readBody(req));
        state.labelVariant = form.get("enabled") === "true";
      }
      return send(200, JSON.stringify({ enabled: state.labelVariant === true }), "application/json");
    }

    if (path === "/demo-portal") return send(200, searchPage("", state.labelVariant || url.searchParams.get("variant") === "label" ? "Subscriber ID" : "Member ID"));

    if (path === "/demo-portal/members") {
      const memberId = url.searchParams.get("memberId") ?? "";
      if (!memberId.trim()) return send(200, searchPage("Enter a member ID."));
      const member = lookup(memberId);
      if (!member) return send(200, searchPage(`No member found for ${memberId}.`));
      return send(200, memberPage(member));
    }

    const benefits = path.match(/^\/demo-portal\/members\/([^/]+)\/benefits$/);
    if (benefits) {
      const member = lookup(decodeURIComponent(benefits[1] ?? ""));
      if (!member) return send(404, layout("Not found", "<h1>Member not found</h1>"));
      return send(200, benefitsPage(member));
    }
    return send(404, layout("Not found", "<h1>Not found</h1>"));
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const isMain = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORTAL_PORT ?? 4174);
  createPortal().listen(port, "127.0.0.1", () => {
    console.log(`Synthetic portal listening on http://127.0.0.1:${port}/demo-portal`);
  });
}
