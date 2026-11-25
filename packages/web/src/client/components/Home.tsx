import { useState } from "react";
import type { RunCard } from "../../api/contract.ts";
import { compact, usd } from "../../views/describe.ts";
import { act, api, href, store, useApp } from "../store.ts";
import { Ago, Empty, Icon, StatusPill } from "./ui.tsx";

export function RunTile({ run, showProject = true }: { run: RunCard; showProject?: boolean }) {
  const projects = useApp((s) => s.projects);
  const project = run.project ? projects.find((p) => p.slug === run.project)?.title ?? run.project : undefined;
  return (
    <a className="tile" href={href.run(run.runId)}>
      <div className="tile-top">
        <StatusPill card={run} />
        <span className="muted small">
          <Ago iso={run.lastEventAt} />
        </span>
      </div>
      <div className="tile-title">{run.title}</div>
      <div className="tile-meta">
        {run.pipeline === "reel" ? (
          <span>
            <Icon name="film" size={13} /> {run.cuts} {run.cuts === 1 ? "cut" : "cuts"}
          </span>
        ) : (
          <span>
            <Icon name="terminal" size={13} /> Task
          </span>
        )}
        <span>{usd(run.costMicroUsd)}</span>
        <span>{compact(run.tokens)} tokens</span>
        {showProject && project ? (
          <span>
            <Icon name="folder" size={13} /> {project}
          </span>
        ) : null}
      </div>
      {run.driveError ? <div className="tile-error">{run.driveError}</div> : null}
    </a>
  );
}

export function Home() {
  const runs = useApp((s) => s.runs);
  const projects = useApp((s) => s.projects);
  const [name, setName] = useState("");
  const waiting = runs.filter((r) => r.status === "waiting_gate");
  const active = runs.filter((r) => r.status === "running" || r.status === "paused" || r.status === "created");
  const recent = runs.filter((r) => !waiting.includes(r) && !active.includes(r)).slice(0, 12);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await act(() => api.call("projects.create", { name }));
    if (result) {
      setName("");
      await store.refreshProjects();
      window.location.hash = href.project(result.project.slug);
    }
  };

  return (
    <div className="page">
      <header className="page-head page-head-row">
        <div>
          <h1>Your reels</h1>
          <p className="muted">Every run, live. Open one to follow the agent, read its script and watch its cuts.</p>
        </div>
        <a className="btn btn-primary" href={href.newRun()}>
          <Icon name="plus" size={16} /> New reel
        </a>
      </header>

      {waiting.length ? (
        <section className="section">
          <h2>Waiting for your review</h2>
          <div className="tiles">{waiting.map((r) => <RunTile key={r.runId} run={r} />)}</div>
        </section>
      ) : null}
      {active.length ? (
        <section className="section">
          <h2>In progress</h2>
          <div className="tiles">{active.map((r) => <RunTile key={r.runId} run={r} />)}</div>
        </section>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>Projects</h2>
          <form className="inline-form" onSubmit={create}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" aria-label="New project name" />
            <button type="submit" className="btn" disabled={!name.trim()}>
              <Icon name="plus" size={14} /> Add
            </button>
          </form>
        </div>
        {projects.length ? (
          <div className="tiles">
            {projects.map((p) => {
              const count = runs.filter((r) => r.project === p.slug).length;
              const kinds = (k: string) => p.files.filter((f) => f.kind === k).length;
              return (
                <a key={p.slug} className="tile" href={href.project(p.slug)}>
                  <div className="tile-top">
                    <span className="muted small">
                      <Icon name="folder" size={13} /> projects/{p.slug}
                    </span>
                    <span className="muted small">
                      <Ago iso={p.modifiedAt} />
                    </span>
                  </div>
                  <div className="tile-title">{p.title}</div>
                  <div className="tile-meta">
                    <span>
                      <Icon name="script" size={13} /> {kinds("script") + kinds("notes") + kinds("narration")} written
                    </span>
                    <span>
                      <Icon name="film" size={13} /> {kinds("video")} video
                    </span>
                    <span>
                      <Icon name="audio" size={13} /> {kinds("audio")} audio
                    </span>
                    <span>{count} {count === 1 ? "run" : "runs"}</span>
                  </div>
                </a>
              );
            })}
          </div>
        ) : (
          <Empty icon="folder" title="No projects yet">
            Name one above, or add a folder under projects/.
          </Empty>
        )}
      </section>

      <section className="section">
        <h2>Recent runs</h2>
        {recent.length ? <div className="tiles">{recent.map((r) => <RunTile key={r.runId} run={r} />)}</div> : runs.length ? null : <Empty icon="film" title="No runs yet">Start a reel and it shows up here as it works.</Empty>}
      </section>
    </div>
  );
}
