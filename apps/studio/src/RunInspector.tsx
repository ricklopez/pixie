import { useEffect, useRef, useState } from "react";
import { api, getToken, TERMINAL, type RunEvidence } from "./api";
import { navigate, StateBadge } from "./App";
import { FlowView } from "./FlowView";

export function RunInspector({ runId }: { runId: string }) {
  const [evidence, setEvidence] = useState<RunEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const loaded = useRef(false);
  const [view, setView] = useState("Flow");

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const e = await api<RunEvidence>("GET", `/studio/runs/${runId}`);
        if (stop) return;
        setEvidence(e);
        loaded.current = true;
        setPollError(null);
        if (!TERMINAL.includes(e.run.state)) setTimeout(tick, 800);
      } catch (err) {
        if (stop) return;
        if (!loaded.current) setError(String(err));
        else {
          setPollError(`lost connection to the gateway (${String(err)}); retrying`);
          setTimeout(tick, 2000);
        }
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [runId]);

  useEffect(() => {
    if (!evidence) return;
    for (const shot of evidence.screenshots) {
      if (images[shot.name]) continue;
      fetch(shot.url, { headers: { authorization: `Bearer ${getToken()}` } })
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => b && setImages((prev) => ({ ...prev, [shot.name]: URL.createObjectURL(b) })))
        .catch(() => undefined);
    }
  }, [evidence?.screenshots.length]);

  if (error) return <p className="error">{error}</p>;
  if (!evidence) return <p className="muted">Loading…</p>;
  const { run } = evidence;
  const m = run.metrics;

  return (
    <>
      <a className="back-link" href="#/">← Workspace</a>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          Run <code>{run.id}</code>
        </h2>
        <div className="row">
          <StateBadge state={run.state} />
          {!TERMINAL.includes(run.state) && (
            <button
              className="danger"
              onClick={async () => {
                await api("POST", `/studio/runs/${run.id}/cancel`);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      {pollError && <div className="notice">{pollError}</div>}
      <p className="muted">
        <a onClick={() => navigate(`/automations/${run.automationId}`)}>{run.automationId}</a> · revision {run.revision || "draft"} · {run.kind} · account <code>{run.accountId}</code> · input <code>{JSON.stringify(run.input)}</code>
      </p>

      <div className="stat-grid">
        <div><span>Jev decisions</span><strong>{evidence.modelDecisions.length}</strong></div>
        <div><span>Browser actions</span><strong>{evidence.actions.length}</strong></div>
        <div><span>Worker time</span><strong>{m ? `${(m.elapsedMs / 1000).toFixed(1)}s` : "Running"}</strong></div>
      </div>
      {run.failure && <div className="notice">{run.failure.reason}</div>}
      <nav className="tabs view-tabs" aria-label="Run views">{["Flow", "Data & verification", "Decisions & actions", "Screenshots", "Events"].map(v => <button key={v} className={view === v ? "active" : ""} aria-pressed={view === v} onClick={() => setView(v)}>{v}</button>)}</nav>
      {view === "Flow" && <FlowView evidence={evidence} selected={selected} onSelect={setSelected} />}
      <section hidden={view !== "Data & verification"}>

      <div className="grid2">
        <div className="panel">
          <h2>Independent verification</h2>
          {run.failure && (
            <div className="notice">
              <b>{run.failure.reason}</b>
              {run.failure.reasons?.map((r, i) => <div key={i}>• {r}</div>)}
            </div>
          )}
          {evidence.verification ? (
            <table>
              <tbody>
                {evidence.verification.checks.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className={`badge ${c.passed ? "ok" : "bad"}`}>{c.passed ? "pass" : "fail"}</span>
                    </td>
                    <td>
                      <code>{c.id}</code>
                    </td>
                    <td className="muted">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No extraction reached verification.</p>
          )}
        </div>
        <div className="panel">
          <h2>{run.state === "completed" ? "Accepted typed result" : "Raw extraction (not accepted)"}</h2>
          <pre>{JSON.stringify(run.state === "completed" ? evidence.data : evidence.rawExtraction, null, 2)}</pre>
          {evidence.finalUrl && <p className="muted">final URL: {evidence.finalUrl}</p>}
        </div>
      </div>

      </section>
      <section hidden={view !== "Decisions & actions"}>
      <div className="panel">
        <h2>Engine metrics</h2>
        {m ? (
          <p>
            engine <code>{m.engine}</code> · revision <code>{m.engineRevision.slice(0, 12)}</code> · {m.modelCalls} model calls · {m.actions} actions · {m.policyRejections} policy rejections · {m.elapsedMs} ms worker time · model latency{" "}
            {m.modelLatencyMs.length ? `${Math.min(...m.modelLatencyMs)}–${Math.max(...m.modelLatencyMs)} ms (${m.modelLatencyMs.join(", ")})` : "n/a"} · tokens {m.inputTokens}/{m.outputTokens}
          </p>
        ) : (
          <p className="muted">not finished</p>
        )}
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Model decisions</h2>
          <table>
            <thead>
              <tr>
                <th>checkpoint</th>
                <th>model</th>
                <th>operation</th>
                <th>target</th>
                <th>confidence</th>
                <th>latency</th>
              </tr>
            </thead>
            <tbody>
              {evidence.modelDecisions.map((d, i) => (
                <tr key={i}>
                  <td>
                    <code>{d.checkpointId}</code>
                  </td>
                  <td>{d.model}</td>
                  <td>{d.operation}</td>
                  <td className="muted">{String(d.target ?? d.choice ?? "")}</td>
                  <td>{d.confidence !== undefined ? d.confidence.toFixed(2) : "—"}</td>
                  <td>{d.latencyMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2>Actions (typed values never recorded)</h2>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>checkpoint</th>
                <th>kind</th>
                <th>element</th>
                <th>bound input</th>
                <th>URL after</th>
              </tr>
            </thead>
            <tbody>
              {evidence.actions.map((a) => (
                <tr key={a.step}>
                  <td>{a.step}</td>
                  <td>
                    <code>{String(a.checkpointId)}</code>
                  </td>
                  <td>{a.kind}</td>
                  <td>{a.action}</td>
                  <td className="muted">{a.boundInput ? `${a.boundInput} (${a.typedLength} chars)` : "—"}</td>
                  <td className="muted">{a.url}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {evidence.policyRejections.length > 0 && (
            <>
              <h2 style={{ marginTop: 12 }}>Policy rejections</h2>
              <pre>{JSON.stringify(evidence.policyRejections, null, 2)}</pre>
            </>
          )}
        </div>
      </div>

      </section>
      <section hidden={view !== "Screenshots"}>
      <div className="panel">
        <h2>Screenshots</h2>
        <div className="shots">
          {evidence.screenshots.map((s) => (
            <figure key={s.name} style={{ margin: 0 }}>
              {images[s.name] ? <img src={images[s.name]} alt={s.name} /> : <div className="muted">loading…</div>}
              <figcaption>
                {s.checkpointId} · {s.label}
              </figcaption>
            </figure>
          ))}
          {!evidence.screenshots.length && <span className="muted">none</span>}
        </div>
      </div>

      </section>
      <section hidden={view !== "Events"}>
      <div className="panel">
        <h2>
          Chronological events <span className="muted">({evidence.timeline.length})</span>
        </h2>
        <table aria-label="chronological run events">
          <tbody>
            {evidence.timeline.map((t) => (
              <tr
                key={t.seq}
                className={t.seq === selected ? "selected" : ""}
                style={{ cursor: t.event.type === "model_call" ? "pointer" : undefined }}
                onClick={() => { if (t.event.type === "model_call") { setSelected(t.seq); setView("Flow"); } }}
              >
                <td className="muted">{t.seq}</td>
                <td className="muted">{t.at.slice(11, 23)}</td>
                <td>
                  <code>{t.event.type}</code>
                </td>
                <td className="muted">
                  <code>{summarize(t.event)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </section>
    </>
  );
}

function summarize(event: Record<string, unknown>) {
  const rest = Object.fromEntries(Object.entries(event).filter(([k]) => k !== "type"));
  const text = JSON.stringify(rest);
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}
