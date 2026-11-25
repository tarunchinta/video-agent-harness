import { useMemo, useState } from "react";
import type { HarnessEvent } from "@harness/harness";
import { clock } from "./ui.tsx";

/** The log itself, as recorded. Everything else on the page is computed from these lines. */
export function EventLog({ events }: { events: HarnessEvent[] }) {
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(300);
  const [open, setOpen] = useState<number | undefined>();
  const types = useMemo(() => [...new Set(events.map((e) => e.type.split(".")[0]!))], [events]);
  const [family, setFamily] = useState("");
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return events.filter((e) => (!family || e.type.startsWith(`${family}.`)) && (!q || e.type.includes(q) || JSON.stringify(e.payload).toLowerCase().includes(q)));
  }, [events, filter, family]);
  const tail = shown.slice(-limit);

  return (
    <div className="log">
      <div className="log-bar">
        <input className="search" placeholder="Filter by type or content" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select value={family} onChange={(e) => setFamily(e.target.value)} aria-label="Event family">
          <option value="">All events</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className="muted small">
          {shown.length} of {events.length}
        </span>
      </div>
      {shown.length > tail.length ? (
        <button type="button" className="btn btn-small log-more" onClick={() => setLimit(limit + 500)}>
          Show {Math.min(500, shown.length - tail.length)} earlier events
        </button>
      ) : null}
      <div className="log-rows">
        {tail.map((e) => (
          <div key={e.seq} className={`log-row ${open === e.seq ? "on" : ""} ${e.untrusted ? "untrusted" : ""}`}>
            <button type="button" className="log-line" onClick={() => setOpen(open === e.seq ? undefined : e.seq)}>
              <span className="mono muted">{String(e.seq).padStart(4, " ")}</span>
              <span className="mono muted">{clock(e.occurredAt)}</span>
              <span className={`mono ev ev-${e.type.split(".")[0]}`}>{e.type}</span>
              <span className="muted small">{e.actor}{e.agentId && e.agentId !== "main" ? ` · ${e.agentId}` : ""}</span>
              {e.untrusted ? <span className="tag tag-warn" title="Holds text from outside the harness; never sent to a model with tools">untrusted</span> : null}
              {e.costMicroUsd ? <span className="muted small mono">${(e.costMicroUsd / 1e6).toFixed(4)}</span> : null}
            </button>
            {open === e.seq ? (
              <pre className="code code-tool">
                <code>{JSON.stringify(e, null, 2)}</code>
              </pre>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
