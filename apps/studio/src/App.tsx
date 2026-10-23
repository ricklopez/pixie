import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { api, ApiError, getClientToken, getToken, setClientToken, setToken, type Account, type Automation, type Connection, type Run, type SpendSummary } from "./api";
import { AutomationPage } from "./AutomationPage";
import { RunInspector } from "./RunInspector";

type Route = { page: "home" } | { page: "automation"; id: string; tab?: string } | { page: "run"; runId: string } | { page: "connection"; id: string };

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "automations" && parts[1]) return { page: "automation", id: parts[1], tab: parts[2] };
  if (parts[0] === "runs" && parts[1]) return { page: "run", runId: parts[1] };
  if (parts[0] === "connections" && parts[1]) return { page: "connection", id: parts[1] };
  return { page: "home" };
}

export function navigate(path: string) {
  location.hash = path;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [token, setTokenState] = useState(getToken());
  const [me, setMe] = useState<{ tenantId: string; name: string; role: string; publicApiUrl: string } | null>(null);
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
        api<{ tenantId: string; name: string; role: string; publicApiUrl: string }>("GET", "/studio/me"),
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
        {route.page === "automation" && <AutomationPage id={route.id} tab={route.tab} accounts={accounts} publicApiUrl={me.publicApiUrl} onChanged={refresh} />}
        {route.page === "run" && <RunInspector runId={route.runId} />}
        {route.page === "connection" && <ConnectionHandoff id={route.id} />}
      </main>
    </div>
  );
}

function Home({ automations, accounts, refresh }: { automations: Automation[]; accounts: Account[]; refresh: () => Promise<void> }) {
  const [workspaceView, setWorkspaceView] = useState("Automations");
  const [name, setName] = useState("Eligibility overview");
  const [startUrl, setStartUrl] = useState("http://127.0.0.1:4174/demo-portal");
  const [template, setTemplate] = useState<"blank" | "eligibility-overview" | "hn-front-page">("blank");
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [clientToken, setClientTokenState] = useState(getClientToken());
  const [secretAccount, setSecretAccount] = useState(accounts[0]?.id ?? "");
  const [secretStatus, setSecretStatus] = useState<string | null>(null);

  useEffect(() => {
    api<Run[]>("GET", "/studio/runs").then(setRuns).catch(() => setRuns([]));
    api<SpendSummary>("GET", "/studio/spend").then(setSpend).catch(() => setSpend(null));
    api<Connection[]>("GET", "/studio/connections").then(setConnections).catch(() => setConnections([]));
  }, [automations]);

  const startConnection = async (account: Account) => {
    try {
      const connection = await api<Connection>("POST", "/studio/connections", { accountId: account.id, environment: account.environment ?? "local" });
      await api("POST", `/studio/connections/${encodeURIComponent(connection.id)}/connect`);
      navigate(`/connections/${connection.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? JSON.stringify(e.body) : String(e));
    }
  };

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
          Start from a blank draft, the reviewed eligibility-overview template, or the read-only Hacker News front-page template.
        </p>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const created = await api<Automation>("POST", "/studio/automations", { name, startUrl, ...(template !== "blank" ? { template } : {}) });
              await refresh();
              navigate(`/automations/${created.id}`);
            } catch (err) {
              setError(err instanceof ApiError ? JSON.stringify(err.body) : String(err));
            }
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" />
          <input value={startUrl} onChange={(e) => setStartUrl(e.target.value)} placeholder="start URL" style={{ width: 340 }} />
          <select value={template} onChange={(e) => {
            const next = e.target.value as "blank" | "eligibility-overview" | "hn-front-page";
            setTemplate(next);
            if (next === "hn-front-page") {
              setName("Hacker News front page");
              setStartUrl("https://news.ycombinator.com/news");
            }
          }}>
            <option value="blank">blank (record first)</option>
            <option value="eligibility-overview">template: eligibility overview</option>
            <option value="hn-front-page">template: Hacker News front page (read-only)</option>
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
      <div className="panel">
        <h2>Persistent connections</h2>
        <p className="muted">A Browserbase context is isolated per account and environment. Login is driven only through this Pixie handoff.</p>
        <table>
          <thead><tr><th>Account</th><th>Environment</th><th>State</th><th>Verified</th><th>Actions</th></tr></thead>
          <tbody>
            {connections.map((connection) => (
              <tr key={connection.id}>
                <td>{connection.accountName}</td><td>{connection.environment}</td><td><span className="badge">{connection.state}</span>{connection.contextStatus === "orphaned" && <span className="error"> context orphaned</span>}</td>
                <td className="muted">{connection.lastVerifiedAt ? new Date(connection.lastVerifiedAt).toLocaleString() : "—"}</td>
                <td className="row">
                  <button className="secondary" onClick={() => void navigate(`/connections/${connection.id}`)}>Open</button>
                  <button onClick={() => {
                    const account = accounts.find((item) => item.id === connection.accountId);
                    if (account) void startConnection(account);
                  }}>Connect</button>
                  <button className="secondary" onClick={async () => {
                    await api("POST", `/studio/connections/${connection.id}/disconnect`);
                    setConnections(await api<Connection[]>("GET", "/studio/connections"));
                  }}>Disconnect</button>
                </td>
              </tr>
            ))}
            {!connections.length && <tr><td colSpan={5} className="muted">No Browserbase connections configured.</td></tr>}
          </tbody>
        </table>
        {error && <p className="error">{error}</p>}
      </div>
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
        <p className="muted">
          Total provider spend: {spend ? `$${spend.total.estimatedCostUsd.toFixed(6)} · ${spend.total.providerCalls} provider calls · ${spend.total.inputTokens} input tokens` : "unavailable"}
          {spend ? ` · Browserbase ${((spend.browserSessionSeconds ?? 0) / 60).toFixed(2)} session-minutes` : ""}
        </p>
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
          <th>Decisions / provider calls / cost / browser minutes / actions / ms</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => {
          const metrics = r.metrics;
          const decisionLabel = metrics?.engine.toLowerCase().includes("scripted") ? "scripted decisions" : "Jev decisions";
          const estimatedCost = typeof metrics?.estimatedCostUsd === "number" ? `$${metrics.estimatedCostUsd.toFixed(6)}` : "unknown";
          return (
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
              <td className="muted">{metrics?.engine ?? "—"}</td>
              <td className="muted">
                {metrics
                  ? `${decisionLabel} ${metrics.modelCalls} · ${metrics.providerCalls ?? "unknown"} provider calls · estimated cost ${estimatedCost} · Browserbase ${((metrics.browserSessionSeconds ?? 0) / 60).toFixed(2)} min · ${metrics.actions} actions · ${metrics.elapsedMs} ms`
                  : "—"}
              </td>
              <td className="muted">{new Date(r.createdAt).toLocaleTimeString()}</td>
            </tr>
          );
        })}
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

function ConnectionHandoff({ id }: { id: string }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [frame, setFrame] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const current = await api<Connection>("GET", `/studio/connections/${encodeURIComponent(id)}`);
        if (active) setConnection(current);
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [id]);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    const refreshFrame = async () => {
      try {
        const response = await fetch(`/studio/connections/${encodeURIComponent(id)}/frame`, { headers: { authorization: `Bearer ${getToken()}` } });
        if (!response.ok) return;
        const blob = await response.blob();
        if (!blob.size || !active) return;
        const next = URL.createObjectURL(blob);
        setFrame(next);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = next;
      } catch {
        if (active) setError("The handoff frame is unavailable.");
      }
    };
    void refreshFrame();
    const timer = window.setInterval(() => void refreshFrame(), 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  const send = async (body: Record<string, unknown>) => {
    try {
      await api("POST", `/studio/connections/${encodeURIComponent(id)}/input`, body);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? "Only the developer who started this handoff may send input." : String(e));
    }
  };
  const pointer = (event: ReactMouseEvent<HTMLImageElement>, type: "mousePressed" | "mouseReleased") => {
    const rect = event.currentTarget.getBoundingClientRect();
    void send({ type: "mouse", event: type, x: Math.round(((event.clientX - rect.left) / rect.width) * 1120), y: Math.round(((event.clientY - rect.top) / rect.height) * 780) });
  };

  if (!connection) return <div className="panel">{error ?? "Loading connection…"}</div>;
  return (
    <div className="panel">
      <p className="eyebrow">PERSISTENT BROWSERBASE CONTEXT</p>
      <h1>Login handoff</h1>
      <p className="muted">{connection.accountName} · {connection.environment} · <StateBadge state={connection.state} /></p>
      <p>Complete login in this Pixie-controlled browser, then select Resume to verify the persisted session.</p>
      {frame && (
        <img
          src={frame}
          alt="Browser handoff"
          tabIndex={0}
          style={{ width: "min(100%, 1120px)", border: "1px solid #39445b", borderRadius: 8, cursor: "crosshair" }}
          onMouseDown={(event) => pointer(event, "mousePressed")}
          onMouseUp={(event) => pointer(event, "mouseReleased")}
          onWheel={(event) => { event.preventDefault(); void send({ type: "wheel", x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY, deltaY: event.deltaY }); }}
          onKeyDown={(event) => { event.preventDefault(); void send({ type: "key", event: "keyDown", key: event.key, code: event.code, ...(event.key.length === 1 ? { text: event.key } : {}) }); }}
          onKeyUp={(event) => { event.preventDefault(); void send({ type: "key", event: "keyUp", key: event.key, code: event.code }); }}
        />
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button disabled={!connection.controller} onClick={async () => {
          try {
            const result = await api<{ state: string }>("POST", `/studio/connections/${encodeURIComponent(id)}/resume`);
            setConnection({ ...connection, state: result.state as Connection["state"], controller: false });
          } catch (e) { setError(String(e)); }
        }}>Resume (“I'm logged in”)</button>
        <button className="secondary" onClick={async () => {
          await api("POST", `/studio/connections/${encodeURIComponent(id)}/disconnect`);
          navigate("/");
        }}>Disconnect</button>
      </div>
      {!connection.controller && <p className="muted">You can view this handoff, but only its controller can send input.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
