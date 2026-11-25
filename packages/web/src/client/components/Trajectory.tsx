import { useMemo, useState } from "react";
import type { HarnessEvent } from "@harness/harness";
import { compact, duration, usd } from "../../views/describe.ts";
import { withKeys } from "../keys.ts";
import { buildTrajectory, timeScale, type TraceSpan, type TraceStep } from "../../views/trajectory.ts";
import { Empty, Icon } from "./ui.tsx";

/**
 * The loop laid bare: a timeline of every span (stages, reviews, model calls, tools), then a ledger of steps.
 * A step is one model response and the tools it asked for; retries are attempts inside it; a turn ends when the
 * model stops without asking for tools. Long waits are squeezed so the work stays readable.
 */

const spanMs = (s: { start: number; end?: number }, now: number) => (s.end ?? now) - s.start;

function Timeline({ spans, start, end, selected, onSelect }: { spans: TraceSpan[]; start: number; end: number; selected?: string; onSelect: (s: TraceSpan) => void }) {
  const lanes: { id: string; label: string; spans: TraceSpan[] }[] = [
    { id: "stage", label: "Stages", spans: spans.filter((s) => s.kind === "stage") },
    { id: "review", label: "Reviews", spans: spans.filter((s) => s.kind === "review") },
    { id: "model", label: "Model", spans: spans.filter((s) => s.kind === "model" || s.kind === "extract") },
    { id: "tool", label: "Tools", spans: spans.filter((s) => s.kind === "tool") },
  ];
  const work = spans.filter((s) => s.kind === "model" || s.kind === "tool" || s.kind === "extract");
  const scale = useMemo(() => timeScale(work, start, end), [work, start, end]);
  return (
    <div className="timeline">
      {lanes.map((lane) => (
        <div key={lane.id} className="lane">
          <div className="lane-label">{lane.label}</div>
          <div className="lane-track">
            {scale.breaks.map((b) => (
              <div key={b.x} className="lane-break" style={{ left: `${b.x * 100}%`, width: `${b.width * 100}%` }} title={`${duration(b.ms)} with nothing running (waiting for you, or paused)`} />
            ))}
            {lane.spans.map((s) => {
              const x = scale.at(s.start);
              const w = Math.max(0.0025, scale.at(s.end ?? end) - x);
              return (
                <button type="button"
                  key={s.id}
                  className={`span span-${s.kind} out-${s.outcome} ${s.family ? `fam-${s.family}` : ""} ${selected === s.id ? "on" : ""}`}
                  style={{ left: `${x * 100}%`, width: `${w * 100}%` }}
                  title={`${s.label} · ${duration(spanMs(s, end))}${s.outcome === "failed" ? ` · ${s.error ?? "failed"}` : ""}`}
                  onClick={() => onSelect(s)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function StepRow({ step, selected, onSelect, open, toggle }: { step: TraceStep; selected?: string; onSelect: (s: TraceSpan) => void; open: boolean; toggle: () => void }) {
  const answer = step.attempts[step.attempts.length - 1];
  const failed = step.tools.filter((t) => t.outcome === "failed").length;
  return (
    <div className="ledger-step">
      {withKeys(step.notes, (n) => n.text).map(({ key, item: n }) => (
        <div key={key} className={`ledger-note ${n.kind?.startsWith("round") ? "is-round" : ""}`}>
          <Icon name={n.kind?.startsWith("round") ? "loop" : "info"} size={13} />
          <span>{n.kind?.startsWith("round") ? "New round: " : "Note to the agent: "}</span>
          <span className="muted">{n.text.length > 220 ? `${n.text.slice(0, 219)}…` : n.text}</span>
        </div>
      ))}
      <button type="button" className="ledger-row ledger-row-step" onClick={toggle} aria-expanded={open}>
        <Icon name="chevron" size={12} className={open ? "rot" : ""} />
        <span className="mono">Step {step.step}</span>
        {step.stage ? <span className="tag">{step.stage}</span> : null}
        <span className="muted small">turn {step.turn}</span>
        {step.attempts.length > 1 ? <span className="tag tag-warn">{step.attempts.length - 1} {step.attempts.length === 2 ? "retry" : "retries"}</span> : null}
        <span className="grow">
          {step.tools.length ? `${step.tools.length} tool ${step.tools.length === 1 ? "call" : "calls"}` : step.stopReason === "end_turn" ? "Stopped without a tool call" : ""}
          {failed ? <span className="error-text"> · {failed} did not run</span> : null}
        </span>
        {answer?.stopReason ? <span className="muted small mono">{answer.stopReason}</span> : null}
        <span className="muted small mono">{compact(step.tokens)} tok</span>
        <span className="muted small mono">{usd(step.costMicroUsd)}</span>
        <span className="muted small mono">{step.end ? duration(step.end - step.start) : "…"}</span>
      </button>
      {open ? (
        <div className="ledger-children">
          {step.attempts.map((a) => (
            <button type="button" key={a.id} className={`ledger-row ${selected === a.id ? "on" : ""}`} onClick={() => onSelect(a)}>
              <span className={`kind-dot kd-model out-${a.outcome}`} />
              <span>
                {a.attempt && a.attempt > 1 ? `Attempt ${a.attempt}` : "Model call"} <span className="muted">{a.name}</span>
              </span>
              <span className="grow" />
              {a.outcome === "failed" ? <span className="error-text small">{a.error}</span> : null}
              {a.firstTokenMs !== undefined ? <span className="muted small mono" title="Time to first token">ttft {duration(a.firstTokenMs)}</span> : null}
              {a.tokensIn !== undefined ? <span className="muted small mono">{compact(a.tokensIn)} in · {compact(a.tokensOut ?? 0)} out{a.cacheRead ? ` · ${compact(a.cacheRead)} cached` : ""}</span> : null}
              <span className="muted small mono">{a.end ? duration(a.end - a.start) : "…"}</span>
            </button>
          ))}
          {step.tools.map((t) => (
            <button type="button" key={t.id} className={`ledger-row ${selected === t.id ? "on" : ""}`} onClick={() => onSelect(t)}>
              <span className={`kind-dot kd-tool fam-${t.family} out-${t.outcome}`} />
              <span className="ledger-label">{t.label}</span>
              <span className="grow" />
              {t.outcome === "failed" ? <span className="error-text small">{t.error?.replaceAll("_", " ")}</span> : t.outcome === "open" ? <span className="muted small">running</span> : null}
              <span className="muted small mono">{t.end ? duration(t.end - t.start) : "…"}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Inspector({ span, onClose }: { span: TraceSpan; onClose: () => void }) {
  return (
    <aside className="inspector card">
      <div className="viewer-head">
        <strong className="grow">{span.label}</strong>
        <button type="button" className="icon-btn" onClick={onClose} title="Close">
          <Icon name="x" size={14} />
        </button>
      </div>
      <dl className="facts">
        <dt>Kind</dt>
        <dd>{span.kind === "extract" ? "Tool-less model call over untrusted text" : span.kind}</dd>
        <dt>Outcome</dt>
        <dd>{span.outcome === "open" ? "Still open" : span.outcome === "ok" ? "Finished" : `Failed (${span.error ?? "error"})`}</dd>
        <dt>Took</dt>
        <dd>{span.end ? duration(span.end - span.start) : "Still going"}</dd>
        {span.step !== undefined ? (
          <>
            <dt>Step</dt>
            <dd>{span.step}</dd>
          </>
        ) : null}
        {span.costMicroUsd !== undefined ? (
          <>
            <dt>Cost</dt>
            <dd>
              {usd(span.costMicroUsd)} · {compact(span.tokensIn ?? 0)} in, {compact(span.tokensOut ?? 0)} out
            </dd>
          </>
        ) : null}
        <dt>Events</dt>
        <dd className="mono">
          {span.startSeq}
          {span.endSeq ? ` to ${span.endSeq}` : ""}
        </dd>
      </dl>
      {span.events.map((e) => (
        <details key={e.seq} className="raw" open={span.events.length === 1}>
          <summary className="mono">
            #{e.seq} {e.type}
          </summary>
          <pre className="code code-tool">
            <code>{JSON.stringify(e.payload, null, 2)}</code>
          </pre>
        </details>
      ))}
    </aside>
  );
}

export function Trajectory({ events }: { events: HarnessEvent[] }) {
  const trace = useMemo(() => buildTrajectory(events), [events]);
  const [selected, setSelected] = useState<TraceSpan | undefined>();
  const [folded, setFolded] = useState<Record<number, boolean>>({});
  const [allOpen, setAllOpen] = useState(false);
  if (!trace.steps.length) return <Empty icon="loop" title="No steps yet">The loop shows up here once the agent makes its first model call.</Empty>;
  const t = trace.totals;
  const isOpen = (n: number) => (folded[n] === undefined ? allOpen || n === trace.steps[trace.steps.length - 1]!.step : !folded[n]);
  const pick = (s: TraceSpan) => setSelected((cur) => (cur?.id === s.id ? undefined : s));

  return (
    <div className="trajectory">
      <div className="traj-main">
        <div className="stats">
          <div className="stat"><b>{t.steps}</b><span>steps</span></div>
          <div className="stat"><b>{t.turns}</b><span>turns</span></div>
          <div className="stat"><b>{t.rounds}</b><span>rounds</span></div>
          <div className="stat"><b>{t.toolCalls}</b><span>tool calls</span></div>
          <div className={`stat ${t.failedTools ? "stat-warn" : ""}`}><b>{t.failedTools}</b><span>refused or failed</span></div>
          <div className={`stat ${t.retries ? "stat-warn" : ""}`}><b>{t.retries}</b><span>retries</span></div>
          <div className="stat"><b>{t.extractCalls}</b><span>safe reads</span></div>
          <div className="stat"><b>{compact(t.tokensIn + t.tokensOut)}</b><span>tokens</span></div>
          <div className="stat"><b>{usd(t.costMicroUsd)}</b><span>cost</span></div>
        </div>
        <Timeline spans={trace.spans} start={trace.start} end={trace.end} selected={selected?.id} onSelect={pick} />
        <div className="legend muted small">
          <span><i className="sw sw-model" /> model</span>
          <span><i className="sw sw-file" /> files</span>
          <span><i className="sw sw-command" /> commands</span>
          <span><i className="sw sw-web" /> web</span>
          <span><i className="sw sw-render" /> render</span>
          <span><i className="sw sw-review" /> review</span>
          <span><i className="sw sw-failed" /> failed</span>
          <span><i className="sw sw-break" /> long wait, squeezed</span>
        </div>
        <div className="ledger-head">
          <h3>Steps</h3>
          <button type="button"
            className="btn btn-small"
            onClick={() => {
              setAllOpen(!allOpen);
              setFolded({});
            }}
          >
            {allOpen ? "Fold all" : "Unfold all"}
          </button>
        </div>
        <div className="ledger">
          {trace.steps.map((step) => (
            <StepRow key={step.step} step={step} selected={selected?.id} onSelect={pick} open={isOpen(step.step)} toggle={() => setFolded((f) => ({ ...f, [step.step]: isOpen(step.step) }))} />
          ))}
        </div>
      </div>
      {selected ? <Inspector span={selected} onClose={() => setSelected(undefined)} /> : null}
    </div>
  );
}
