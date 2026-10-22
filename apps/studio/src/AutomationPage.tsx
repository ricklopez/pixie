import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, getClientToken, getToken, TERMINAL, type Account, type Automation, type Definition, type RecordedEvent, type RecordingStatus, type RecordingView, type ReviewExport, type Run } from "./api";
import { navigate, RunTable, StateBadge } from "./App";

const TABS = ["record", "review", "test", "publish", "api"] as const;
type Tab = (typeof TABS)[number];

export function AutomationPage({ id, tab, accounts, onChanged }: { id: string; tab?: string; accounts: Account[]; onChanged: () => Promise<void> }) {
  const [automation, setAutomation] = useState<Automation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current: Tab = (TABS as readonly string[]).includes(tab ?? "") ? (tab as Tab) : defaultTab(automation);

  const load = useCallback(async () => {
    try {
      setAutomation(await api<Automation>("GET", `/studio/automations/${id}`));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!automation) return <p className="muted">Loading…</p>;
  const stateIndex = automation.states.indexOf(automation.state);
  const changed = async () => {
    await load();
    await onChanged();
  };

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          {automation.name} <span className="muted" style={{ fontSize: 13 }}>{automation.id}</span>
        </h2>
        <StateBadge state={automation.state} />
      </div>
      <div className="stepper">
        {automation.states.map((s, i) => (
          <span key={s} className={`step ${i < stateIndex ? "done" : i === stateIndex ? "current" : ""}`}>
            {i + 1}. {s}
          </span>
        ))}
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === current ? "active" : ""} onClick={() => navigate(`/automations/${id}/${t}`)}>
            {t}
          </button>
        ))}
      </div>
      {current === "record" && <RecordTab automation={automation} changed={changed} />}
      {current === "review" && <ReviewTab automation={automation} changed={changed} />}
      {current === "test" && <TestTab automation={automation} accounts={accounts} changed={changed} />}
      {current === "publish" && <PublishTab automation={automation} changed={changed} />}
      {current === "api" && <ApiTab automation={automation} accounts={accounts} />}
    </>
  );
}

function defaultTab(a: Automation | null): Tab {
  switch (a?.state) {
    case "draft":
    case "recording":
      return "record";
    case "configuring":
      return "review";
    case "testing":
      return "test";
    case "ready":
      return "publish";
    case "published":
      return "api";
    default:
      return "record";
  }
}

// -- Record ---------------------------------------------------------------------------------------------

function RecordTab({ automation, changed }: { automation: Automation; changed: () => Promise<void> }) {
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<RecordingView | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const live = automation.state === "recording";
  const base = `/studio/automations/${automation.id}/recording`;

  useEffect(() => {
    if (!live) return;
    let stop = false;
    let previous: string | null = null;
    const tick = async () => {
      try {
        setStatus(await api<RecordingStatus>("GET", `${base}/status`));
        const res = await fetch(`${base}/frame`, { headers: { authorization: `Bearer ${getToken()}` } });
        if (res.status === 200) {
          const url = URL.createObjectURL(await res.blob());
          if (previous) URL.revokeObjectURL(previous);
          previous = url;
          setFrameUrl(url);
        }
      } catch (e) {
        setError(String(e));
      }
      if (!stop) setTimeout(tick, 350);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [live, base]);

  useEffect(() => {
    if (automation.recordingId) api<RecordingView>("GET", base).then(setRecording).catch(() => setRecording(null));
  }, [automation.recordingId, base]);

  const send = (input: Record<string, unknown>) => api("POST", `${base}/input`, input).catch((e) => setError(String(e)));
  const point = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current!;
    const rect = img.getBoundingClientRect();
    return { x: Math.round(((e.clientX - rect.left) / rect.width) * img.naturalWidth), y: Math.round(((e.clientY - rect.top) / rect.height) * img.naturalHeight) };
  };

  return (
    <>
      <div className="panel">
        <h2>Dedicated recording browser</h2>
        <p className="muted">
          The recording runs in a Gateway-controlled Chrome, not your own browser. Only sanitized events are stored: element semantics, URL paths with redacted query values, and value lengths. Typed values never leave the browser.
        </p>
        <div className="row">
          {!live && automation.state !== "published" && (
            <button
              onClick={async () => {
                setError(null);
                try {
                  await api("POST", `${base}/start`, {});
                  await changed();
                } catch (e) {
                  setError(e instanceof ApiError ? JSON.stringify(e.body) : String(e));
                }
              }}
            >
              {automation.recordingId ? "Re-record" : "Start recording"}
            </button>
          )}
          {live && (
            <button
              className="danger"
              onClick={async () => {
                const result = await api<RecordingView>("POST", `${base}/stop`);
                setRecording(result);
                setFrameUrl(null);
                await changed();
                navigate(`/automations/${automation.id}/review`);
              }}
            >
              Stop recording
            </button>
          )}
          {status && (
            <span className="muted">
              {status.actionCount} events · {Math.round(status.elapsedMs / 1000)} s · {status.currentUrl}
            </span>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        {live && (
          <div
            style={{ marginTop: 12, outline: "none" }}
            tabIndex={0}
            onKeyDown={(e) => {
              e.preventDefault();
              const text = e.key.length === 1 ? e.key : undefined;
              void send({ type: "key", event: "keyDown", key: e.key, code: e.code, ...(text ? { text } : {}) });
            }}
            onKeyUp={(e) => {
              e.preventDefault();
              void send({ type: "key", event: "keyUp", key: e.key, code: e.code });
            }}
          >
            {frameUrl ? (
              <img
                ref={imgRef}
                src={frameUrl}
                className="screen"
                alt="live browser"
                draggable={false}
                onMouseMove={(e) => {
                  if (e.buttons === 0 && Math.random() < 0.85) return;
                  void send({ type: "mouse", event: "mouseMoved", ...point(e) });
                }}
                onMouseDown={(e) => {
                  e.currentTarget.parentElement?.focus();
                  void send({ type: "mouse", event: "mousePressed", ...point(e), button: "left", clickCount: 1 });
                }}
                onMouseUp={(e) => void send({ type: "mouse", event: "mouseReleased", ...point(e), button: "left", clickCount: 1 })}
                onWheel={(e) => void send({ type: "wheel", ...point(e as unknown as React.MouseEvent<HTMLImageElement>), deltaY: e.deltaY })}
              />
            ) : (
              <p className="muted">Waiting for the first frame…</p>
            )}
            <p className="muted" style={{ fontSize: 12 }}>
              Click the frame to focus, then type. Keys are forwarded to the controlled browser; the recorder stores only whether a field received a value and its length.
            </p>
          </div>
        )}
      </div>
      {recording && <RecordingEvents recording={recording} />}
    </>
  );
}

function RecordingEvents({ recording }: { recording: RecordingView }) {
  return (
    <div className="panel">
      <h2>
        Captured events <span className="muted">({recording.actionCount} actions, {recording.warnings.length} warnings)</span>
      </h2>
      {recording.warnings.map((w, i) => (
        <div key={i} className="notice">
          <b>{w.code}</b> {w.message} {w.seq !== undefined && <span className="muted">(event #{w.seq})</span>}
        </div>
      ))}
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>t (ms)</th>
            <th>kind</th>
            <th>target</th>
            <th>value</th>
            <th>URL (sanitized)</th>
          </tr>
        </thead>
        <tbody>
          {recording.events.map((e) => (
            <tr key={e.seq} className={e.kind === "unsupported" ? "error" : ""}>
              <td>{e.seq}</td>
              <td>{e.at}</td>
              <td>
                {e.kind}
                {e.frame === "subframe" && <span className="badge warn">subframe</span>}
              </td>
              <td>{describeTarget(e)}</td>
              <td className="muted">{e.hasValue ? `value entered (${e.valueLength} chars, not stored)` : e.optionLabel ? `option '${e.optionLabel}'` : e.key ?? ""}</td>
              <td className="muted">{e.url}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function describeTarget(e: RecordedEvent) {
  if (!e.target) return e.reason ?? "";
  const t = e.target;
  return [t.tag, t.role && `role=${t.role}`, t.label && `label="${t.label}"`, t.name && `name=${t.name}`, t.text && `"${t.text}"`].filter(Boolean).join(" ");
}

// -- Review -----------------------------------------------------------------------------------------------

function ReviewTab({ automation, changed }: { automation: Automation; changed: () => Promise<void> }) {
  const [text, setText] = useState(JSON.stringify(automation.definition, null, 2));
  const [issues, setIssues] = useState<{ path: string; message: string }[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [recording, setRecording] = useState<RecordingView | null>(null);
  const locked = automation.state === "published";

  useEffect(() => {
    setText(JSON.stringify(automation.definition, null, 2));
  }, [automation.definition]);
  useEffect(() => {
    if (automation.recordingId) api<RecordingView>("GET", `/studio/automations/${automation.id}/recording`).then(setRecording).catch(() => setRecording(null));
  }, [automation.id, automation.recordingId]);

  const def = automation.definition;
  const applySuggestion = () => {
    if (!recording) return;
    const next: Definition = { ...def, checkpoints: recording.suggestion.checkpoints, inputs: recording.suggestion.inputs };
    setText(JSON.stringify(next, null, 2));
  };

  return (
    <>
      <div className="grid2">
        <div className="panel">
          <h2>Inputs (caller-provided, injected by code)</h2>
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>type</th>
                <th>required</th>
                <th>bound to</th>
              </tr>
            </thead>
            <tbody>
              {def.inputs.map((i) => (
                <tr key={i.name}>
                  <td>
                    <code>{i.name}</code>
                  </td>
                  <td>{i.type}</td>
                  <td>{String(i.required)}</td>
                  <td className="muted">
                    field "{i.binding.targetLabel}" in checkpoint {i.binding.checkpointId}
                    {i.binding.eventSeq !== undefined && ` (recorded event #${i.binding.eventSeq})`}
                  </td>
                </tr>
              ))}
              {!def.inputs.length && (
                <tr>
                  <td colSpan={4} className="muted">
                    No inputs yet. Every recorded field that received a value must be bound to a typed input or the definition is rejected.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2>Outputs (typed extraction) and assertions</h2>
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>type</th>
                <th>required</th>
                <th>extractor</th>
              </tr>
            </thead>
            <tbody>
              {def.outputs.map((o) => (
                <tr key={o.name}>
                  <td>
                    <code>{o.name}</code>
                  </td>
                  <td>{o.type}</td>
                  <td>{String(o.required)}</td>
                  <td className="muted">{describeExtractor(o.extractor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ marginTop: 10 }}>
            <b>Independent assertions:</b>{" "}
            {def.assertions.length ? def.assertions.map((a, i) => <code key={i}>{JSON.stringify(a)} </code>) : <span className="muted">none</span>}
          </p>
        </div>
      </div>
      <div className="panel">
        <h2>Checkpoints</h2>
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>objective (inputs as {"{{name}}"})</th>
              <th>precondition</th>
              <th>postcondition</th>
              <th>allowed effects</th>
              <th>max actions</th>
            </tr>
          </thead>
          <tbody>
            {def.checkpoints.map((c) => (
              <tr key={c.id}>
                <td>
                  <code>{c.id}</code>
                </td>
                <td>{c.objective}</td>
                <td className="muted">{c.precondition.map(describeCondition).join("; ") || "—"}</td>
                <td className="muted">{c.postcondition.map(describeCondition).join("; ") || "— (must be added)"}</td>
                <td>{c.allowedEffects.join(", ") || "none"}</td>
                <td>{c.maxActions}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Origins: {def.allowedOrigins.join(", ")} · effect: {def.effect} · engine: {def.engine}@{def.engineRevision.slice(0, 12)} · deadline {def.limits.deadlineMs} ms · max {def.limits.maxActions} actions · auth signals:{" "}
          {def.authRequiredSignals.map(describeCondition).join("; ") || "none"}
        </p>
      </div>
      {recording && (
        <div className="panel">
          <h2>Suggestion from recording {recording.id.slice(0, 8)}</h2>
          <p className="muted">
            Proposed {recording.suggestion.checkpoints.length} checkpoint(s) and {recording.suggestion.inputs.length} input(s) from the captured events. {recording.suggestion.unbound.length} event(s) could not be bound and need review.
            Nothing is saved until you confirm the definition below.
          </p>
          <button className="secondary" onClick={applySuggestion} disabled={locked}>
            Load suggestion into editor
          </button>
        </div>
      )}
      <div className="panel">
        <h2>Definition {locked ? "(published revision — read only)" : "(edit and confirm)"}</h2>
        <textarea className="code" value={text} onChange={(e) => setText(e.target.value)} readOnly={locked} />
        <div className="row" style={{ marginTop: 8 }}>
          <button
            disabled={locked}
            onClick={async () => {
              setIssues(null);
              setSaved(null);
              let parsed: unknown;
              try {
                parsed = JSON.parse(text);
              } catch (e) {
                setIssues([{ path: "$", message: `invalid JSON: ${String(e)}` }]);
                return;
              }
              try {
                const res = await api<Automation & { checksum: string }>("PUT", `/studio/automations/${automation.id}/definition`, parsed);
                setSaved(`saved; checksum ${res.checksum.slice(0, 16)}… — run a test to continue`);
                await changed();
              } catch (e) {
                if (e instanceof ApiError && e.body && typeof e.body === "object" && "issues" in e.body) setIssues((e.body as { issues: { path: string; message: string }[] }).issues);
                else setIssues([{ path: "$", message: String(e) }]);
              }
            }}
          >
            Validate and confirm
          </button>
          {saved && <span className="muted">{saved}</span>}
        </div>
        {issues && (
          <ul className="error">
            {issues.map((i, k) => (
              <li key={k}>
                <code>{i.path}</code> {i.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function describeExtractor(x: Record<string, unknown> & { kind: string }) {
  if (x.kind === "labelValue") return `label "${String(x.label)}" @ ${String(x.checkpointId)}`;
  if (x.kind === "tableCell") {
    const where = x.where as { column: string; equals: string } | undefined;
    return `table "${String(x.table)}" row "${String(x.rowLabel)}" col "${String(x.column)}"${where ? ` where ${where.column}=${where.equals}` : ""}`;
  }
  return x.kind;
}
function describeCondition(c: Record<string, string>) {
  return Object.entries(c)
    .filter(([k]) => k !== "kind")
    .map(([, v]) => `${c.kind}(${v})`)
    .join("");
}

// -- Test -------------------------------------------------------------------------------------------------

export function InputForm({ automation, values, onChange }: { automation: Automation; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  return (
    <>
      {automation.definition.inputs.map((i) => (
        <label key={i.name} className="row">
          <code style={{ width: 120 }}>{i.name}</code>
          <input value={values[i.name] ?? ""} onChange={(e) => onChange({ ...values, [i.name]: e.target.value })} placeholder={`${i.type}${i.required ? " (required)" : ""}`} />
        </label>
      ))}
    </>
  );
}

export function coerceInput(automation: Automation, values: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const i of automation.definition.inputs) {
    const raw = values[i.name];
    if (raw === undefined || raw === "") continue;
    out[i.name] = i.type === "number" ? Number(raw) : i.type === "boolean" ? raw === "true" : raw;
  }
  return out;
}

function TestTab({ automation, accounts, changed }: { automation: Automation; accounts: Account[]; changed: () => Promise<void> }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(automation.lastTestRunId);

  const loadRuns = useCallback(() => api<Run[]>("GET", `/studio/runs?automationId=${automation.id}`).then(setRuns).catch(() => undefined), [automation.id]);
  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);
  useEffect(() => {
    if (!active) return;
    const run = runs.find((r) => r.id === active);
    if (run && TERMINAL.includes(run.state)) return;
    const t = setTimeout(async () => {
      await loadRuns();
    }, 700);
    return () => clearTimeout(t);
  }, [active, runs, loadRuns]);
  useEffect(() => {
    const run = runs.find((r) => r.id === active);
    if (run && TERMINAL.includes(run.state)) void changed();
  }, [runs.find((r) => r.id === active)?.state]);

  const canTest = ["configuring", "testing", "ready"].includes(automation.state);
  return (
    <>
      <div className="panel">
        <h2>Test run through Jev Ultrafast</h2>
        <p className="muted">
          Runs the confirmed definition in the controlled browser. Completion requires the independent verification to accept the extracted result; the engine finishing is not enough. A passing test is required before publishing, and editing the definition invalidates it.
        </p>
        <div className="row">
          <label className="row">
            <span>account</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id} — {a.name}
                </option>
              ))}
            </select>
          </label>
          <InputForm automation={automation} values={values} onChange={setValues} />
          <button
            disabled={!canTest}
            onClick={async () => {
              setError(null);
              try {
                const run = await api<Run>("POST", `/studio/automations/${automation.id}/test`, { accountId, input: coerceInput(automation, values) });
                setActive(run.id);
                await loadRuns();
                await changed();
              } catch (e) {
                setError(e instanceof ApiError ? JSON.stringify(e.body) : String(e));
              }
            }}
          >
            Run test
          </button>
        </div>
        {!canTest && <p className="muted">Confirm a definition first (state must be configuring, testing or ready).</p>}
        {error && <p className="error">{error}</p>}
      </div>
      <div className="panel">
        <h2>Runs for this automation</h2>
        <RunTable runs={runs} />
      </div>
    </>
  );
}

// -- Publish ----------------------------------------------------------------------------------------------

function PublishTab({ automation, changed }: { automation: Automation; changed: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<ReviewExport | null>(null);
  return (
    <>
      <div className="panel">
        <h2>Publish an immutable revision</h2>
        <p className="muted">
          Publishing freezes the definition (checksum over canonical JSON) as the next revision number and exposes it through <code>/v1/automations/{automation.id}</code>. Clients must name the revision explicitly. Changing anything afterwards means a new draft and a new revision.
        </p>
        <div className="row">
          <button
            disabled={automation.state !== "ready"}
            onClick={async () => {
              setError(null);
              try {
                await api("POST", `/studio/automations/${automation.id}/publish`);
                await changed();
                navigate(`/automations/${automation.id}/api`);
              } catch (e) {
                setError(e instanceof ApiError ? JSON.stringify(e.body) : String(e));
              }
            }}
          >
            Publish revision {automation.revisions.length + 1}
          </button>
          {automation.state === "published" && (
            <button
              className="secondary"
              onClick={async () => {
                const draft = await api<Automation>("POST", `/studio/automations/${automation.id}/new-draft`);
                await changed();
                navigate(`/automations/${draft.id}/review`);
              }}
            >
              Start a new draft from this revision
            </button>
          )}
          {automation.state !== "ready" && automation.state !== "published" && <span className="muted">requires state "ready" (a passing test on the current definition)</span>}
        </div>
        {error && <p className="error">{error}</p>}
      </div>
      <div className="panel">
        <h2>Revisions</h2>
        <table>
          <thead>
            <tr>
              <th>revision</th>
              <th>checksum</th>
              <th>published</th>
              <th>by</th>
              <th>passing test run</th>
            </tr>
          </thead>
          <tbody>
            {automation.revisions.map((r) => (
              <tr key={r.revision}>
                <td>v{r.revision}</td>
                <td>
                  <code>{r.checksum}</code>
                </td>
                <td className="muted">{new Date(r.publishedAt).toLocaleString()}</td>
                <td className="muted">{r.publishedBy}</td>
                <td>{r.testRunId ? <a onClick={() => navigate(`/runs/${r.testRunId}`)}>{r.testRunId.slice(0, 8)}</a> : "—"}</td>
              </tr>
            ))}
            {!automation.revisions.length && (
              <tr>
                <td colSpan={5} className="muted">
                  Not published yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h2>Review export</h2>
        <p className="muted">
          Text files for a Git-backed review: reviewed definitions with checksums, input/output schemas, assertions, synthetic test expectations and the generated OpenAPI. Secrets, browser state, screenshots and raw evidence are excluded. The export states factually that no automated review has examined it.
        </p>
        <div className="row">
          <button
            className="secondary"
            disabled={!automation.revisions.length}
            onClick={async () => {
              setError(null);
              try {
                const bundle = await api<ReviewExport>("GET", `/studio/automations/${automation.id}/export`);
                setExported(bundle);
                const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `${automation.id}-review-export.json`;
                a.click();
                URL.revokeObjectURL(a.href);
              } catch (e) {
                setError(e instanceof ApiError ? JSON.stringify(e.body) : String(e));
              }
            }}
          >
            Download review export
          </button>
          {!automation.revisions.length && <span className="muted">available once a revision is published</span>}
          {exported && (
            <span className="muted">
              {Object.keys(exported.files).length} files: {Object.keys(exported.files).join(", ")}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

// -- API explorer ----------------------------------------------------------------------------------------

function ApiTab({ automation, accounts }: { automation: Automation; accounts: Account[] }) {
  const [spec, setSpec] = useState<unknown>(null);
  const [revision, setRevision] = useState(automation.revisions.at(-1)?.revision ?? 1);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const published = automation.revisions.length > 0;

  useEffect(() => {
    api("GET", `/studio/automations/${automation.id}/openapi.json`).then(setSpec).catch(() => setSpec(null));
  }, [automation.id, automation.revisions.length]);

  const body = { revision, accountId, input: coerceInput(automation, values) };
  const curl = `curl -X POST ${location.origin}/v1/automations/${automation.id}/runs \\\n  -H "Authorization: Bearer $GATEWAY_CLIENT_TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \\\n  -d '${JSON.stringify(body)}'`;

  const invoke = async () => {
    const token = getClientToken();
    if (!token) return setLog(["set a client key on the Automations page first"]);
    setBusy(true);
    const lines: string[] = [];
    const t0 = performance.now();
    try {
      const idem = crypto.randomUUID();
      const started = await api<Run>("POST", `/v1/automations/${automation.id}/runs`, body, token, { "idempotency-key": idem });
      lines.push(`POST /runs -> 202 ${started.id} (${started.state})`);
      setLog([...lines]);
      for (;;) {
        const res = await fetch(`/v1/automations/${automation.id}/runs/${started.id}/result`, { headers: { authorization: `Bearer ${token}` } });
        const text = await res.text();
        if (res.status !== 202) {
          lines.push(`GET /result -> ${res.status} after ${Math.round(performance.now() - t0)} ms`);
          lines.push(JSON.stringify(JSON.parse(text), null, 2));
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const replay = await fetch(`/v1/automations/${automation.id}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": idem },
        body: JSON.stringify(body)
      });
      lines.push(`POST /runs (same Idempotency-Key) -> ${replay.status} (replayed, no new run)`);
      lines.push(`evidence: #/runs/${started.id}`);
    } catch (e) {
      lines.push(`error: ${e instanceof ApiError ? `${e.status} ${JSON.stringify(e.body)}` : String(e)}`);
    } finally {
      setBusy(false);
      setLog(lines);
    }
  };

  return (
    <>
      <div className="panel">
        <h2>Endpoint set</h2>
        {!published && <p className="muted">Not published yet; the preview below is generated from the current draft.</p>}
        <table>
          <tbody>
            {[
              ["POST", "/runs", "start a run (explicit revision, accountId, typed input; Idempotency-Key supported)"],
              ["GET", "/runs/{runId}", "status"],
              ["GET", "/runs/{runId}/result", "202 pending · 200 verified data · 409 terminal without accepted data"],
              ["GET", "/runs/{runId}/evidence", "sanitized timeline, model decisions, actions, verification, screenshots"],
              ["POST", "/runs/{runId}/cancel", "cancel queued/running"],
              ["GET", "/openapi.json", "this contract"]
            ].map(([m, p, d]) => (
              <tr key={p}>
                <td>
                  <code>{m}</code>
                </td>
                <td>
                  <code>
                    /v1/automations/{automation.id}
                    {p}
                  </code>
                </td>
                <td className="muted">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid2">
        <div className="panel">
          <h2>Invoke as a client</h2>
          <div className="row">
            <label className="row">
              revision
              <select value={revision} onChange={(e) => setRevision(Number(e.target.value))}>
                {automation.revisions.map((r) => (
                  <option key={r.revision} value={r.revision}>
                    v{r.revision}
                  </option>
                ))}
                {!published && <option value={1}>v1 (not published)</option>}
              </select>
            </label>
            <label className="row">
              account
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ margin: "8px 0" }}>
            <InputForm automation={automation} values={values} onChange={setValues} />
          </div>
          <button onClick={invoke} disabled={!published || busy}>
            {busy ? "Running…" : "POST run and poll result"}
          </button>
          <pre style={{ marginTop: 10 }}>{curl}</pre>
          {log.length > 0 && (
            <pre>
              {log.map((l, i) =>
                l.startsWith("evidence: #") ? (
                  <a key={i} onClick={() => navigate(l.slice("evidence: #".length))}>
                    open run evidence
                  </a>
                ) : (
                  <div key={i}>{l}</div>
                )
              )}
            </pre>
          )}
        </div>
        <div className="panel">
          <h2>OpenAPI 3.1</h2>
          <pre style={{ maxHeight: 640 }}>{spec ? JSON.stringify(spec, null, 2) : "…"}</pre>
        </div>
      </div>
    </>
  );
}
