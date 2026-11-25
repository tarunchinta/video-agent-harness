import { useEffect, useMemo, useRef, useState } from "react";
import { finishResult } from "../../views/chat.ts";
import { meters, reelProgress } from "../../views/progress.ts";
import { act, api, store, useApp } from "../store.ts";
import { Chat } from "./Chat.tsx";
import { Composer } from "./Composer.tsx";
import { EventLog } from "./EventLog.tsx";
import { Studio, type StudioTab, type StudioTarget } from "./Studio.tsx";
import { Trajectory } from "./Trajectory.tsx";
import { Empty, Icon, StatusPill, Tabs, useNow } from "./ui.tsx";

type MainTab = "chat" | "loop" | "log" | "made";

const readWidth = () => {
  try {
    return Number(localStorage.getItem("studio-width")) || 460;
  } catch {
    return 460;
  }
};

function useNarrow(): boolean {
  const query = "(max-width: 1100px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

export function RunView({ runId }: { runId: string }) {
  const open = useApp((s) => s.open);
  const projects = useApp((s) => s.projects);
  const [tab, setTab] = useState<MainTab>("chat");
  const [target, setTarget] = useState<StudioTarget | undefined>();
  const [width, setWidth] = useState(readWidth);
  const narrow = useNarrow();
  const dragging = useRef(false);

  useEffect(() => {
    void store.openRun(runId);
    setTab("chat");
    setTarget(undefined);
  }, [runId]);

  const run = open?.runId === runId ? open : undefined;
  const events = run?.events ?? [];
  const state = run?.state;
  const card = run?.card;
  const working = state?.status === "running" && card?.driver !== "none";
  const now = useNow(working);
  const progress = useMemo(() => (state && state.config.pipeline === "reel" ? reelProgress(events, state) : []), [events, state]);
  const usage = useMemo(() => (state ? meters(state, events, now) : []), [state, events, now]);
  const result = useMemo(() => finishResult(events), [events]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      const next = Math.min(Math.max(window.innerWidth - e.clientX, 340), Math.min(900, window.innerWidth - 560));
      setWidth(next);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove("resizing");
      try {
        localStorage.setItem("studio-width", String(width));
      } catch {
        /* per-viewer convenience only */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [width]);

  if (run?.error) return <div className="page"><Empty icon="warn" title="This run could not be opened">{run.error}</Empty></div>;
  if (!run || run.loading || !state || !card) return <div className="page"><div className="muted pad">Opening the run…</div></div>;

  const openFile = (path: string) => {
    const studioTab: StudioTab = /^cuts\/.*\.mp4$/.test(path) ? "cuts" : /^script\//.test(path) ? "script" : "files";
    setTarget({ tab: studioTab, path, nonce: Date.now() });
    if (narrow) setTab("made");
  };
  const studio = <Studio runId={runId} events={events} {...(state.pendingGate ? { pendingGate: state.pendingGate } : {})} {...(target ? { target } : {})} />;
  const composer = <Composer card={card} state={state} {...(result?.film ? { film: result.film } : {})} onOpenFile={openFile} />;
  const chatTabs: { id: MainTab; label: string; icon: string; count?: number }[] = [
    { id: "chat", label: "Chat", icon: "chat" },
    { id: "loop", label: "Loop", icon: "loop" },
    { id: "log", label: "Log", icon: "list", count: events.length },
  ];
  if (narrow) chatTabs.push({ id: "made", label: "Made", icon: "film" });

  return (
    <div className="run" style={{ ["--studio-w" as string]: `${width}px` }}>
      <header className="run-head">
        <div className="run-title-row">
          <h1 className="run-title" title={state.title}>
            {state.title}
          </h1>
          <StatusPill card={card} />
          <span className="grow" />
          <label className="file-into" title="Which project this run belongs to">
            <Icon name="folder" size={14} />
            <select
              value={card.project ?? ""}
              onChange={(e) => {
                const project = e.target.value || null;
                void act(() => api.call("runs.file", { runId, project }), project ? "Filed under the project." : "Taken out of its project.").then((r) => r && store.takeCard(r.card));
              }}
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="run-sub muted small">
          <span className="mono" title="Run id">{runId.slice(0, 8)}</span>
          <span>{state.config.model}</span>
          {state.config.sandbox_network ? <span>sandbox, network {state.config.sandbox_network}</span> : null}
          {card.driver === "here" ? <span className="live">driven here</span> : card.driver === "elsewhere" ? <span className="live">driven from a terminal</span> : null}
        </div>
        {progress.length ? (
          <ol className="stepper" aria-label="Where the reel is">
            {progress.map((p) => (
              <li key={p.id} className={`step-${p.state} ${p.kind === "review" ? "is-review" : ""}`}>
                <span className="step-dot">{p.state === "done" ? <Icon name="check" size={11} /> : p.state === "failed" ? <Icon name="x" size={11} /> : null}</span>
                <span className="step-name">{p.label}</span>
                {p.revisions > 1 ? <span className="step-rev">×{p.revisions}</span> : null}
              </li>
            ))}
          </ol>
        ) : null}
        <div className="meters">
          {usage.map((m) => (
            <div key={m.id} className={`meter ${m.ratio !== undefined && m.ratio >= 0.8 ? "meter-hot" : ""}`} title={m.limit ? `${Math.round((m.ratio ?? 0) * 100)}% of the limit` : "No limit set"}>
              <div className="meter-label">{m.label}</div>
              <div className="meter-value mono">{m.text}</div>
              {m.ratio !== undefined ? (
                <div className="meter-bar">
                  <i style={{ width: `${m.ratio * 100}%` }} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </header>
      <div className={`run-body ${narrow ? "narrow" : ""}`}>
        <section className="run-main">
          <Tabs value={tab} onChange={setTab} tabs={chatTabs} />
          <div className="run-tab">
            {tab === "chat" ? <Chat events={events} runId={runId} liveText={run.liveText} working={working} footer={composer} onOpenFile={openFile} /> : null}
            {tab === "loop" ? <Trajectory events={events} /> : null}
            {tab === "log" ? <EventLog events={events} /> : null}
            {tab === "made" ? studio : null}
          </div>
        </section>
        {!narrow ? (
          <>
            <button
              type="button"
              className="splitter"
              aria-label="Drag to resize the panel; arrow keys work too"
              onPointerDown={() => {
                dragging.current = true;
                document.body.classList.add("resizing");
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") setWidth((w) => Math.min(900, w + 40));
                if (e.key === "ArrowRight") setWidth((w) => Math.max(340, w - 40));
              }}
            />
            {studio}
          </>
        ) : null}
      </div>
    </div>
  );
}
