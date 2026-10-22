import { useMemo, useState } from "react";
import { BaseEdge, Background, Handle, Position, ReactFlow, getSmoothStepPath, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { TERMINAL, type Run, type RunEvidence } from "./api";
import { buildGraph, correlateDecisions, type Decision, type StageData } from "./flow-model";

function StageNode({ data }: NodeProps<Node<StageData>>) {
  return (
    <div className={`flow-node ${data.status}`}>
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />
      <div className="flow-node-title">
        {data.title}
        {data.count !== undefined && data.count > 0 && <span className="flow-count">{data.count}</span>}
      </div>
      <div className="flow-node-detail">{data.detail}</div>
    </div>
  );
}

function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, label }: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 12 });
  const d = (data ?? {}) as { happened?: boolean; kind?: string; live?: boolean };
  return (
    <>
      <BaseEdge id={id} path={path} className={`flow-edge ${d.happened ? `happened ${d.kind ?? "ok"}` : "idle"}`} />
      {d.happened && (
        <circle r="3" className={`flow-particle ${d.kind ?? "ok"}`}>
          <animateMotion dur={d.live ? "1.2s" : "3s"} repeatCount="indefinite" path={path} />
        </circle>
      )}
      {label && d.happened && (
        <text x={labelX} y={labelY - 6} className="flow-edge-label" textAnchor="middle">
          {String(label)}
        </text>
      )}
    </>
  );
}

const nodeTypes = { stage: StageNode };
const edgeTypes = { flow: FlowEdge };

export function FlowView({ evidence, selected, onSelect }: { evidence: RunEvidence; selected: number | null; onSelect: (seq: number | null) => void }) {
  const decisions = useMemo(() => correlateDecisions(evidence.timeline), [evidence.timeline]);
  const { nodes, edges } = useMemo(() => buildGraph(evidence.run, evidence.timeline, decisions), [evidence.run, evidence.timeline, decisions]);
  const [panel, setPanel] = useState<string | null>(null);
  const live = !TERMINAL.includes(evidence.run.state);
  const decision = decisions.find((d) => d.seq === selected) ?? null;

  return (
    <div className="panel flow-panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Execution flow</h2>
        <span className={`badge ${live ? "active" : ""}`}>{live ? "live — updating from worker events" : "replay — recorded history"}</span>
      </div>
      <div className="flow-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          zoomOnScroll={false}
          panOnScroll
          proOptions={{ hideAttribution: false }}
          onNodeClick={(_e, n) => {
            setPanel(n.id);
            if (n.id === "decide" && decisions.length && !decision) onSelect(decisions[decisions.length - 1]!.seq);
          }}
          onPaneClick={() => setPanel(null)}
          colorMode="dark"
        >
          <Background gap={18} size={1} color="#1f2630" />
        </ReactFlow>
      </div>
      {panel === "decide" || decision ? (
        <DecisionList decisions={decisions} selected={selected} onSelect={onSelect} run={evidence.run} verified={!!evidence.verification} />
      ) : (
        <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
          Nodes and animated edges reflect only recorded events; grey edges did not occur in this run. Click “Jev decision” to inspect each model call.
        </p>
      )}
    </div>
  );
}

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}

function suppliedInput(d: Decision, run: Run) {
  const bound = (d.allowed?.event as { boundInput?: string | null } | undefined)?.boundInput ?? (d.executed?.event as { boundInput?: string | null } | undefined)?.boundInput ?? null;
  if (!bound) return d.operation === "TYPE_TEXT" ? "no reviewed binding for this field (value would be refused)" : "none";
  const typedLength = (d.executed?.event as { typedLength?: number } | undefined)?.typedLength;
  if (bound in run.input) return `${bound} = ${JSON.stringify(run.input[bound])}${typedLength !== undefined ? ` (${typedLength} chars typed)` : ""}`;
  return `${bound} = [account secret, redacted]${typedLength !== undefined ? ` (${typedLength} chars typed)` : ""}`;
}

export function DecisionList({ decisions, selected, onSelect, run, verified }: { decisions: Decision[]; selected: number | null; onSelect: (seq: number | null) => void; run: Run; verified: boolean }) {
  const d = decisions.find((x) => x.seq === selected) ?? null;
  return (
    <div className="grid2" style={{ marginTop: 12 }}>
      <div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>checkpoint</th>
              <th>operation → target</th>
              <th>proposed</th>
              <th>allowed</th>
              <th>executed</th>
              <th>latency</th>
            </tr>
          </thead>
          <tbody>
            {decisions.map((x, i) => (
              <tr key={x.seq} className={x.seq === selected ? "selected" : ""} style={{ cursor: "pointer" }} onClick={() => onSelect(x.seq)}>
                <td>{i + 1}</td>
                <td>
                  <code>{x.checkpointId}</code>
                </td>
                <td>
                  {x.operation ?? x.choice}
                  {x.target !== null && <span className="muted"> → [{x.target}]</span>}
                </td>
                <td>
                  <Stage ok label={x.claim ? `claim ${x.claim}` : "proposed"} />
                </td>
                <td>{x.claim ? <Stage label={x.claimOutcome ? "claim checked" : "—"} ok={!!x.claimOutcome} bad={!!x.claimOutcome} /> : <Stage ok={!!x.allowed} bad={!!x.rejected} label={x.allowed ? "allowed" : x.rejected ? "rejected" : "—"} />}</td>
                <td>
                  <Stage ok={!!x.executed} label={x.executed ? `step ${String(x.executed.event.step)}` : "—"} />
                </td>
                <td className="muted">{x.latencyMs ?? "—"} ms</td>
              </tr>
            ))}
            {!decisions.length && (
              <tr>
                <td colSpan={7} className="muted">
                  No model calls recorded for this run.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div>
        {d ? (
          <div className="decision-detail">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>
                Decision at {d.at.slice(11, 23)} · <code>{d.checkpointId}</code>
              </b>
              <button className="secondary" onClick={() => onSelect(null)}>
                close
              </button>
            </div>
            <dl>
              <dt>operation</dt>
              <dd>
                <code>{d.operation ?? d.choice}</code> {d.confidence !== null && <span className="muted">operation confidence {pct(d.confidence)}</span>}
              </dd>
              <dt>observed target</dt>
              <dd>
                {d.target !== null ? (
                  <>
                    element [{d.target}] → action <code>{d.choice}</code>
                    {(d.allowed ?? d.rejected ?? d.executed) && <span className="muted"> · “{String((d.allowed ?? d.rejected ?? d.executed)!.event.action)}” ({String((d.allowed ?? d.rejected ?? d.executed)!.event.kind)})</span>}
                    {d.targetConfidence !== null && <span className="muted"> · target confidence {pct(d.targetConfidence)}</span>}
                  </>
                ) : (
                  <span className="muted">none (control operation)</span>
                )}
              </dd>
              <dt>supplied input</dt>
              <dd>{suppliedInput(d, run)}</dd>
              <dt>model</dt>
              <dd>
                <code>{d.model ?? "unknown"}</code> · measured latency {d.latencyMs ?? "n/a"} ms
                {d.usage && Object.keys(d.usage).length > 0 && <span className="muted"> · tokens {JSON.stringify(d.usage)}</span>}
              </dd>
              <dt>stages</dt>
              <dd className="row">
                <Stage ok label="proposed by model" />
                {d.claim ? (
                  <Stage ok={!!d.claimOutcome} bad={!!d.claimOutcome} label={d.claimOutcome ? `${d.claim} claim checked against postcondition: ${String((d.claimOutcome.event as { reason?: string; status?: string }).reason ?? (d.claimOutcome.event as { status?: string }).status)}` : `${d.claim} claim (postcondition held)`} />
                ) : (
                  <>
                    <Stage ok={!!d.allowed} bad={!!d.rejected} label={d.allowed ? "allowed by policy" : d.rejected ? `rejected: ${String(d.rejected.event.reason)}` : "policy not evaluated"} />
                    <Stage ok={!!d.executed} label={d.executed ? `executed (page changed: ${String(d.executed.event.page_changed)})` : "not executed"} />
                  </>
                )}
                <Stage
                  ok={run.state === "completed"}
                  bad={run.state === "needs_review"}
                  label={
                    run.state === "completed"
                      ? "result verified"
                      : run.state === "needs_review"
                        ? verified
                          ? "result rejected by verification"
                          : "no result reached verification"
                        : "result not verified"
                  }
                />
              </dd>
              {d.operationProbabilities && Object.keys(d.operationProbabilities).length > 0 && (
                <>
                  <dt>operation probabilities (upstream)</dt>
                  <dd>
                    <Bars probs={d.operationProbabilities} highlight={d.operation ?? undefined} />
                  </dd>
                </>
              )}
              {d.targetProbabilities && Object.keys(d.targetProbabilities).length > 0 && (
                <>
                  <dt>target probabilities (upstream)</dt>
                  <dd>
                    <Bars probs={d.targetProbabilities} highlight={d.target ?? undefined} />
                  </dd>
                </>
              )}
              {!d.operationProbabilities && !d.targetProbabilities && (
                <>
                  <dt>probabilities</dt>
                  <dd className="muted">not reported by upstream for this call</dd>
                </>
              )}
            </dl>
          </div>
        ) : (
          <p className="muted">Select a decision to see the actual operation, target, model, latency and separately reported probabilities.</p>
        )}
      </div>
    </div>
  );
}

function Stage({ ok, bad, label }: { ok?: boolean; bad?: boolean; label: string }) {
  return <span className={`badge ${bad ? "bad" : ok ? "ok" : ""}`}>{label}</span>;
}

function Bars({ probs, highlight }: { probs: Record<string, number>; highlight?: string }) {
  const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return (
    <div className="bars">
      {entries.map(([k, v]) => (
        <div key={k} className={`bar ${k === highlight ? "hl" : ""}`}>
          <span className="bar-label">{k}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${Math.max(1, v * 100)}%` }} />
          </span>
          <span className="bar-value">{pct(v)}</span>
        </div>
      ))}
    </div>
  );
}
