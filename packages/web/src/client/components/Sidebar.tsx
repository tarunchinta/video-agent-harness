import { useMemo, useState } from "react";
import type { RunCard } from "../../api/contract.ts";
import { href, useApp, type Route } from "../store.ts";
import { Icon, StatusDot } from "./ui.tsx";

/** Navigation: projects with their runs, runs that belong to no project, and a way to start a reel. */

function RunRow({ run, active }: { run: RunCard; active: boolean }) {
  return (
    <a className={`nav-run ${active ? "on" : ""}`} href={href.run(run.runId)} title={run.title}>
      <StatusDot card={run} />
      <span className="nav-run-title">{run.title}</span>
      {run.pendingGate ? <span className="nav-flag" title="Waiting for your review">Review</span> : null}
    </a>
  );
}

export function Sidebar({ route }: { route: Route }) {
  const runs = useApp((s) => s.runs);
  const projects = useApp((s) => s.projects);
  const connected = useApp((s) => s.connected);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const q = query.trim().toLowerCase();
  const match = (r: RunCard) => !q || r.title.toLowerCase().includes(q) || r.runId.startsWith(q);
  const byProject = useMemo(() => {
    const map = new Map<string, RunCard[]>();
    for (const r of runs) {
      const key = r.project ?? "";
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return map;
  }, [runs]);
  const waiting = runs.filter((r) => r.status === "waiting_gate");
  const activeRun = route.page === "run" ? route.runId : undefined;
  const activeProject = route.page === "project" ? route.slug : undefined;
  const unfiled = (byProject.get("") ?? []).filter(match);
  const known = new Set(projects.map((p) => p.slug));
  const orphanProjects = [...byProject.keys()].filter((k) => k && !known.has(k));

  return (
    <nav className="sidebar" aria-label="Projects and runs">
      <a className="brand" href={href.home}>
        <span className="brand-mark">
          <Icon name="play" size={14} />
        </span>
        <span className="brand-name">Reel harness</span>
      </a>
      <a className="btn btn-primary btn-block" href={href.newRun(activeProject)}>
        <Icon name="plus" size={16} /> New reel
      </a>
      <input className="search" placeholder="Find a run" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a run" />

      {waiting.length ? (
        <div className="nav-section">
          <div className="nav-label">Waiting for you</div>
          {waiting.filter(match).map((r) => (
            <RunRow key={r.runId} run={r} active={r.runId === activeRun} />
          ))}
        </div>
      ) : null}

      <div className="nav-section">
        <div className="nav-label">
          Projects
          <a className="nav-label-action" href={href.home} title="All projects">
            All
          </a>
        </div>
        {projects.length === 0 ? <div className="nav-empty">No projects yet. A project is a folder under projects/.</div> : null}
        {[...projects.map((p) => ({ slug: p.slug, title: p.title })), ...orphanProjects.map((slug) => ({ slug, title: slug }))].map((p) => {
          const list = (byProject.get(p.slug) ?? []).filter(match);
          if (q && !list.length && !p.title.toLowerCase().includes(q)) return null;
          const open = !collapsed[p.slug];
          return (
            <div key={p.slug} className="nav-project">
              <div className={`nav-project-row ${activeProject === p.slug ? "on" : ""}`}>
                <button type="button" className="nav-toggle" aria-label={open ? "Fold" : "Unfold"} aria-expanded={open} onClick={() => setCollapsed((c) => ({ ...c, [p.slug]: open }))}>
                  <Icon name="chevron" size={12} className={open ? "rot" : ""} />
                </button>
                <a href={href.project(p.slug)} className="nav-project-link" title={p.title}>
                  <Icon name="folder" size={15} />
                  <span>{p.title}</span>
                </a>
                {list.length ? <span className="count">{list.length}</span> : null}
              </div>
              {open ? list.map((r) => <RunRow key={r.runId} run={r} active={r.runId === activeRun} />) : null}
            </div>
          );
        })}
      </div>

      {unfiled.length ? (
        <div className="nav-section">
          <div className="nav-label">Not in a project</div>
          {unfiled.map((r) => (
            <RunRow key={r.runId} run={r} active={r.runId === activeRun} />
          ))}
        </div>
      ) : null}

      <div className="nav-foot">
        <span className={`dot ${connected ? "dot-ok" : "dot-bad"}`} />
        {connected ? "Live" : "Reconnecting…"}
      </div>
    </nav>
  );
}
