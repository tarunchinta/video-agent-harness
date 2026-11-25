import { useState } from "react";
import type { LimitsInput } from "../../api/contract.ts";
import { act, api, href, useApp } from "../store.ts";
import { Icon } from "./ui.tsx";

/** Starts a reel (or a plain task) from a brief. The checks on the brief are the same as `harness reel`. */
export function NewRun({ project: initialProject }: { project?: string }) {
  const host = useApp((s) => s.host);
  const projects = useApp((s) => s.projects);
  const [mode, setMode] = useState<"reel" | "task">("reel");
  const [topic, setTopic] = useState("");
  const [seconds, setSeconds] = useState(60);
  const [sources, setSources] = useState("");
  const [project, setProject] = useState(initialProject ?? "");
  const [network, setNetwork] = useState<"none" | "public">("none");
  const [model, setModel] = useState("");
  const [maxUsd, setMaxUsd] = useState("");
  const [maxMinutes, setMaxMinutes] = useState("");
  const [reEdits, setReEdits] = useState("2");
  const [sandbox, setSandbox] = useState(false);
  const [busy, setBusy] = useState(false);

  const chosen = projects.find((p) => p.slug === project);
  const limits = (): LimitsInput => ({
    ...(maxUsd && Number(maxUsd) > 0 ? { max_cost_micro_usd: Math.round(Number(maxUsd) * 1_000_000) } : {}),
    ...(maxMinutes && Number(maxMinutes) > 0 ? { max_active_ms: Math.round(Number(maxMinutes) * 60_000) } : {}),
    ...(mode === "reel" && reEdits !== "" && Number(reEdits) >= 0 ? { max_re_edits: Math.round(Number(reEdits)) } : {}),
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const urls = sources.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    const result = await act(() =>
      mode === "reel"
        ? api.call("runs.createReel", { topic, seconds, sources: urls, network, limits: limits(), ...(project ? { project } : {}), ...(model ? { model } : {}) })
        : api.call("runs.createTask", { task: topic, sandbox, limits: limits(), ...(project ? { project } : {}), ...(model ? { model } : {}) }),
    );
    setBusy(false);
    if (result) window.location.hash = href.run(result.runId);
  };

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <h1>{mode === "reel" ? "New reel" : "New task"}</h1>
        <p className="muted">
          {mode === "reel"
            ? "The agent researches the topic, writes a script and stops for your review. After you approve it and hand over your reading, it builds and renders the film, then stops again for the final cut."
            : "A plain run: the agent works in its own folder with the file tools and stops when it calls finish."}
        </p>
      </header>
      <form className="card form" onSubmit={submit}>
        <fieldset className="seg" aria-label="What to start">
          <button type="button" aria-pressed={mode === "reel"} className={mode === "reel" ? "on" : ""} onClick={() => setMode("reel")}>
            <Icon name="film" size={15} /> Reel
          </button>
          <button type="button" aria-pressed={mode === "task"} className={mode === "task" ? "on" : ""} onClick={() => setMode("task")}>
            <Icon name="terminal" size={15} /> Task
          </button>
        </fieldset>
        <label className="field">
          <span>{mode === "reel" ? "What is the reel about?" : "What should the agent do?"}</span>
          <textarea
            required
            minLength={3}
            rows={mode === "reel" ? 3 : 5}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={mode === "reel" ? "Why most A/B tests are underpowered" : "Write hello.txt with a greeting, then read it back"}
          />
        </label>
        <div className="row">
          <label className="field">
            <span>Project</span>
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.title}
                </option>
              ))}
            </select>
            {mode === "reel" && chosen ? (
              <small className="muted">{chosen.hasNotes ? `The agent is given the .md and .txt notes in projects/${chosen.slug}.` : "This project has no .md or .txt notes to give the agent."}</small>
            ) : null}
          </label>
          {mode === "reel" ? (
            <label className="field field-small">
              <span>Length</span>
              <div className="with-unit">
                <input type="number" min={10} max={180} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
                <span>seconds</span>
              </div>
            </label>
          ) : null}
        </div>
        {mode === "reel" ? (
          <label className="field">
            <span>Sources to start from</span>
            <textarea rows={2} value={sources} onChange={(e) => setSources(e.target.value)} placeholder="https://stats.example/power-primer, one address per line" />
          </label>
        ) : (
          <label className="check">
            <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} /> Give it a sandbox to run commands in (needs Docker)
          </label>
        )}
        <details className="more">
          <summary>Model and limits</summary>
          <div className="row">
            <label className="field">
              <span>Model</span>
              <input list="models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={host?.defaultModel ?? "default"} />
              <datalist id="models">{host?.models.map((m) => <option key={m} value={m} />)}</datalist>
            </label>
            <label className="field field-small">
              <span>Spend at most</span>
              <div className="with-unit">
                <span>$</span>
                <input type="number" min={0} step="0.5" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} placeholder="no limit" />
              </div>
            </label>
            <label className="field field-small">
              <span>Work at most</span>
              <div className="with-unit">
                <input type="number" min={0} value={maxMinutes} onChange={(e) => setMaxMinutes(e.target.value)} placeholder="no limit" />
                <span>min</span>
              </div>
            </label>
          </div>
          {mode === "reel" ? (
            <div className="row">
              <label className="field field-small">
                <span>Revisions on its own</span>
                <input type="number" min={0} max={10} value={reEdits} onChange={(e) => setReEdits(e.target.value)} />
                <small className="muted">How often the agent may re-cut the film without being asked.</small>
              </label>
              <label className="field">
                <span>Network for its commands</span>
                <select value={network} onChange={(e) => setNetwork(e.target.value as "none" | "public")}>
                  <option value="none">None (research goes through the page reader)</option>
                  <option value="public">The public web (what code downloads reaches the agent unchecked)</option>
                </select>
              </label>
            </div>
          ) : null}
        </details>
        <div className="form-foot">
          <span className="muted small">Runs are kept in {host?.runsDir ?? "runs/"}.</span>
          <button type="submit" className="btn btn-primary" disabled={busy || topic.trim().length < 3}>
            <Icon name="play" size={14} /> {busy ? "Starting…" : mode === "reel" ? "Start the reel" : "Start the task"}
          </button>
        </div>
      </form>
    </div>
  );
}
