import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getClientToken, getToken, setClientToken, setToken, type Account, type Automation, type Run } from "./api";
import { AutomationPage } from "./AutomationPage";
import { RunInspector } from "./RunInspector";

type Route = { page: "home" } | { page: "automation"; id: string; tab?: string } | { page: "run"; runId: string };

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "automations" && parts[1]) return { page: "automation", id: parts[1], tab: parts[2] };
  if (parts[0] === "runs" && parts[1]) return { page: "run", runId: parts[1] };
  return { page: "home" };
}

export function navigate(path: string) {
  location.hash = path;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [token, setTokenState] = useState(getToken());
  const [me, setMe] = useState<{ tenantId: string; name: string; role: string } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) return;
    try {
      const [who, list, accts] = await Promise.all([
        api<{ tenantId: string; name: string; role: string }>("GET", "/studio/me"),
        api<Automation[]>("GET", "/studio/automations"),
        api<Account[]>("GET", "/studio/accounts")
      ]);
      setMe(who);
      setAutomations(list);
      setAccounts(accts);
      setAuthError(null);
    } catch (e) {
      setMe(null);
      setAuthError(e instanceof ApiError && (e.status === 401 || e.status === 403) ? "This token is not a developer key for any tenant." : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, token]);

  if (!me) {
    return (
      <div className="main" style={{ maxWidth: 520, margin: "60px auto" }}>
        <div className="panel">
          <h2>Pixie Studio</h2>
          <p className="muted">Sign in with a developer API key. Local development seeds <code>dev-token-local</code> (developer) and <code>client-token-local</code> (client).</p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              setToken(String(form.get("token") ?? ""));
              setTokenState(getToken());
            }}
          >
            <input name="token" placeholder="developer API key" defaultValue={token} style={{ flex: 1 }} />
            <button type="submit">Sign in</button>
          </form>
          {authError && <p className="error">{authError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1 className="brand"><span aria-hidden="true">✦</span> pixie <small>STUDIO</small></h1>
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          {me.name} · {me.tenantId}
        </div>
        <a className={`item ${route.page === "home" ? "active" : ""}`} onClick={() => navigate("/")}>
          Automations
        </a>
        <div className="muted" style={{ fontSize: 12, margin: "12px 0 4px" }}>Recent</div>
        {automations.map((a) => (
          <a key={a.id} className={`item ${route.page === "automation" && route.id === a.id ? "active" : ""}`} onClick={() => navigate(`/automations/${a.id}`)}>
            {a.name} <span className="badge">{a.state}</span>
          </a>
        ))}
        <div style={{ marginTop: 24 }}>
          <button
            className="secondary"
            onClick={() => {
              setToken("");
              setTokenState("");
              setMe(null);
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="main"><div className="workspace-bar"><span>WORKSPACE / {route.page === "run" ? "RUN INSPECTOR" : route.page === "automation" ? "AUTOMATION" : "OVERVIEW"}</span><a href="https://pixie.so" target="_blank" rel="noreferrer">Pixie framework ↗</a></div>
        {route.page === "home" && <Home automations={automations} accounts={accounts} refresh={refresh} />}
        {route.page === "automation" && <AutomationPage id={route.id} tab={route.tab} accounts={accounts} onChanged={refresh} />}
        {route.page === "run" && <RunInspector runId={route.runId} />}
      </main>
    </div>
  );
}

function Home({ automations, accounts, refresh }: { automations: Automation[]; accounts: Account[]; refresh: () => Promise<void> }) {
  const [workspaceView, setWorkspaceView] = useState("Automations");
  const [name, setName] = useState("Eligibility overview");
  const [startUrl, setStartUrl] = useState("http://127.0.0.1:4174/demo-portal");
  const [template, setTemplate] = useState<"blank" | "eligibility-overview">("blank");
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [clientToken, setClientTokenState] = useState(getClientToken());
  const [secretAccount, setSecretAccount] = useState(accounts[0]?.id ?? "");
  const [secretStatus, setSecretStatus] = useState<string | null>(null);

  useEffect(() => {
    api<Run[]>("GET", "/studio/runs").then(setRuns).catch(() => setRuns([]));
  }, [automations]);

  return (
    <>
      <div className="page-heading"><p className="eyebrow">FROM BROWSER TO API</p><h1>Your automation workspace.</h1><p className="muted">Build, test, and publish. Every run leaves a trail.</p></div>
      <div className="stat-grid">
        <div><span>Automations</span><strong>{automations.length}</strong></div>
        <div><span>Published</span><strong>{automations.filter(a => a.state === "published").length}</strong></div>
        <div><span>Browser accounts</span><strong>{accounts.length}</strong></div>
      </div>
      <nav className="tabs view-tabs" aria-label="Workspace views">{["Automations", "Runs", "Connections & keys"].map(v => <button key={v} className={workspaceView === v ? "active" : ""} aria-pressed={workspaceView === v} onClick={() => setWorkspaceView(v)}>{v}</button>)}</nav>
      <section hidden={workspaceView !== "Automations"}>
      <div className="panel">
        <h2>New automation</h2>
        <p className="muted">
          Start from a blank draft and record the workflow in a dedicated browser, or start from the reviewed eligibility-overview template (still requires a passing test before publishing).
        </p>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const created = await api<Automation>("POST", "/studio/automations", { name, startUrl, ...(template === "eligibility-overview" ? { template } : {}) });
              await refresh();
              navigate(`/automations/${created.id}`);
            } catch (err) {
              setError(err instanceof ApiError ? JSON.stringify(err.body) : String(err));
            }
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" />
          <input value={startUrl} onChange={(e) => setStartUrl(e.target.value)} placeholder="start URL" style={{ width: 340 }} />
          <select value={template} onChange={(e) => setTemplate(e.target.value as "blank" | "eligibility-overview")}>
            <option value="blank">blank (record first)</option>
            <option value="eligibility-overview">template: eligibility overview</option>
          </select>
          <button type="submit">Create</button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>

      <div className="panel">
        <h2>Automations</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Revisions</th>
              <th>Start URL</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {automations.map((a) => (
              <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/automations/${a.id}`)}>
                <td>{a.name}</td>
                <td>
                  <span className={`badge ${a.state === "published" ? "ok" : "active"}`}>{a.state}</span>
                </td>
                <td>{a.revisions.length ? a.revisions.map((r) => `v${r.revision}`).join(", ") : "—"}</td>
                <td className="muted">{a.definition.startUrl}</td>
                <td className="muted">{new Date(a.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
            {!automations.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No automations yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      </section>
      <section hidden={workspaceView !== "Connections & keys"}>
      <div className="grid2">
        <div className="panel">
          <h2>Accounts</h2>
          <p className="muted">Portal accounts belong to this tenant. Secrets are stored server-side, passed only to the worker for that account's runs, and never returned by any API.</p>
          <table>
            <thead>
              <tr>
                <th>Id</th>
                <th>Name</th>
                <th>Portal origin</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <code>{a.id}</code>
                  </td>
                  <td>{a.name}</td>
                  <td className="muted">{a.portalOrigin}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <form
            className="row"
            style={{ marginTop: 10 }}
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const ref = String(form.get("ref") ?? "");
              const value = String(form.get("value") ?? "");
              if (!ref || !value) return;
              await api("PUT", `/studio/accounts/${secretAccount}/secrets`, { [ref]: value });
              setSecretStatus(`stored secret '${ref}' for ${secretAccount} (value not shown again)`);
              e.currentTarget.reset();
            }}
          >
            <select value={secretAccount} onChange={(e) => setSecretAccount(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}
                </option>
              ))}
            </select>
            <input name="ref" placeholder="secret ref (e.g. portalPassword)" />
            <input name="value" type="password" placeholder="synthetic value" />
            <button type="submit" className="secondary">
              Store secret
            </button>
          </form>
          {secretStatus && <p className="muted">{secretStatus}</p>}
        </div>
        <div className="panel">
          <h2>Client key for the API explorer</h2>
          <p className="muted">The explorer invokes published endpoints exactly like an external client, with a client-role key rather than your developer key.</p>
          <div className="row">
            <input
              type="password"
              value={clientToken}
              onChange={(e) => {
                setClientToken(e.target.value);
                setClientTokenState(e.target.value);
              }}
              placeholder="client API key"
              style={{ flex: 1 }}
            />
            <button
              className="secondary"
              onClick={async () => {
                const created = await api<{ id: string; token: string }>("POST", "/studio/api-keys", { name: "studio explorer", role: "client" });
                setClientToken(created.token);
                setClientTokenState(created.token);
              }}
            >
              Mint new client key
            </button>
          </div>
        </div>
      </div>

      </section>
      <section hidden={workspaceView !== "Runs"}>
      <div className="panel">
        <h2>Recent runs</h2>
        <RunTable runs={runs} />
      </div>
      </section>
    </>
  );
}

export function RunTable({ runs }: { runs: Run[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Kind</th>
          <th>Revision</th>
          <th>Account</th>
          <th>Input</th>
          <th>State</th>
          <th>Engine</th>
          <th>Model calls / actions / ms</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/runs/${r.id}`)}>
            <td>
              <code>{r.id.slice(0, 8)}</code>
            </td>
            <td>{r.kind}</td>
            <td>{r.revision || "draft"}</td>
            <td>
              <code>{r.accountId}</code>
            </td>
            <td>
              <code>{JSON.stringify(r.input)}</code>
            </td>
            <td>
              <StateBadge state={r.state} />
            </td>
            <td className="muted">{r.metrics?.engine ?? "—"}</td>
            <td className="muted">{r.metrics ? `${r.metrics.modelCalls} / ${r.metrics.actions} / ${r.metrics.elapsedMs}` : "—"}</td>
            <td className="muted">{new Date(r.createdAt).toLocaleTimeString()}</td>
          </tr>
        ))}
        {!runs.length && (
          <tr>
            <td colSpan={9} className="muted">
              No runs yet.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function StateBadge({ state }: { state: string }) {
  const cls = state === "completed" ? "ok" : state === "needs_review" || state === "awaiting_auth" ? "warn" : state === "failed" || state === "cancelled" ? "bad" : "active";
  return <span className={`badge ${cls}`}>{state}</span>;
}
