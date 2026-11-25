import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HarnessEvent } from "@harness/harness";
import { artifactUrl, runFileUrl } from "../../api/client.ts";
import type { FileEntry } from "../../api/contract.ts";
import { buildDeliverables, narrationLines, parseWords, wordAt, type Critique, type Cut, type Review, type ScriptRevision, type TimedWord } from "../../views/deliverables.ts";
import { duration } from "../../views/describe.ts";
import { diffLines } from "../../views/diff.ts";
import { withKeys } from "../keys.ts";
import { act, api } from "../store.ts";
import { FileList, FileViewer, useText } from "./FileViewer.tsx";
import { Markdown } from "./Markdown.tsx";
import { clock, Empty, Icon, Tabs } from "./ui.tsx";

/**
 * What the run made, next to the conversation: every script handed in, every cut rendered, the two side by
 * side with the narration following the video word by word, and the working folder.
 */

export type StudioTab = "script" | "cuts" | "compare" | "files";
export type StudioTarget = { tab: StudioTab; path?: string; nonce: number };

function ReviewBadge({ review, pending }: { review?: Review; pending?: boolean }) {
  if (!review) return pending ? <span className="badge badge-wait">Waiting for you</span> : <span className="badge">Not reviewed</span>;
  const label = review.decision === "approved" ? "Approved" : review.decision === "rejected" ? "Rejected" : "Changes asked";
  return <span className={`badge badge-${review.decision}`}>{label}</span>;
}

function ReviewNotes({ review }: { review?: Review }) {
  if (!review?.notes.length) return null;
  return (
    <div className="your-notes">
      <div className="tool-section-label">Notes with your review</div>
      {withKeys(review.notes, (n) => n).map(({ key, item: n }) => (
        <Markdown key={key} text={n} />
      ))}
    </div>
  );
}

/** A script revision's text: from the log when the agent wrote it with write_file, otherwise from the file. */
function useRevisionText(runId: string, rev: ScriptRevision | undefined, latest: boolean, version: number) {
  const script = useText(rev && rev.script === undefined && latest ? runFileUrl(runId, rev.scriptPath) : undefined, version);
  const narration = useText(rev && rev.narration === undefined && latest ? runFileUrl(runId, rev.narrationPath) : undefined, version);
  return { script: rev?.script ?? script.text, narration: rev?.narration ?? narration.text };
}

function ScriptTab({ runId, scripts, pendingScript, version }: { runId: string; scripts: ScriptRevision[]; pendingScript: boolean; version: number }) {
  // A pick holds only while no newer script has arrived; then the newest is shown again.
  const [pick, setPick] = useState<{ n: number; of: number } | undefined>();
  const [showDiff, setShowDiff] = useState(false);
  const n = pick && pick.of === scripts.length ? pick.n : scripts.length;
  const rev = scripts[n - 1];
  const prev = scripts[n - 2];
  const { script, narration } = useRevisionText(runId, rev, n === scripts.length, version);
  const prevText = useRevisionText(runId, prev, false, version);

  if (!rev) return <Empty icon="script" title="No script yet">It appears here as the agent writes it, and stays here once it is handed in.</Empty>;
  const lines = narrationLines(narration ?? "");
  const words = lines.reduce((sum, l) => sum + l.words, 0);
  const canDiff = Boolean(prev && prevText.script !== undefined && script !== undefined);

  return (
    <div className="studio-pane">
      <div className="rev-bar">
        {scripts.map((s) => (
          <button type="button" key={s.n} className={`rev ${s.n === n ? "on" : ""}`} onClick={() => setPick({ n: s.n, of: scripts.length })}>
            {s.draft ? "Draft" : `Script ${s.n}`}
            <ReviewBadge review={s.review} pending={!s.draft && !s.review && pendingScript && s.n === scripts.length} />
          </button>
        ))}
        <span className="grow" />
        {prev ? (
          <label className="check small">
            <input type="checkbox" checked={showDiff} disabled={!canDiff} onChange={(e) => setShowDiff(e.target.checked)} /> Changes from {prev.draft ? "draft" : `script ${prev.n}`}
          </label>
        ) : null}
      </div>
      <div className="script-meta muted small">
        {rev.draft ? "Being written now." : `Handed in at ${clock(rev.at)}.`} {words} words in {lines.length} lines, about {Math.round(words / 2.6)} seconds read aloud.
        {rev.script === undefined && n !== scripts.length ? " The agent did not write this revision with the file tool, so only the latest text can be shown." : ""}
      </div>
      <ReviewNotes review={rev.review} />
      <section className="narration">
        <div className="tool-section-label">
          <Icon name="mic" size={13} /> Narration, as it will be read
        </div>
        {showDiff && prevText.narration !== undefined && narration !== undefined ? (
          <Diff before={prevText.narration} after={narration} />
        ) : (
          <ol className="narration-lines">
            {withKeys(lines, (l) => l.text).map(({ key, item: l }) => (
              <li key={key} className={l.words > 14 ? "too-long" : ""}>
                <span>{l.text}</span>
                <span className="muted small mono">{l.words}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="script-body">
        <div className="tool-section-label">
          <Icon name="script" size={13} /> The script: beats, what is on screen, sources
        </div>
        {showDiff && canDiff ? <Diff before={prevText.script!} after={script!} /> : script !== undefined ? <Markdown text={script} /> : <div className="muted">Reading…</div>}
      </section>
    </div>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  return (
    <pre className="diff">
      {withKeys(lines, (l) => `${l.op}${l.text}`).map(({ key, item: l }) => (
        <div key={key} className={`diff-${l.op}`}>
          <span className="diff-op">{l.op === "add" ? "+" : l.op === "del" ? "−" : " "}</span>
          {l.text || " "}
        </div>
      ))}
    </pre>
  );
}

function CutMeta({ cut }: { cut: Cut }) {
  return (
    <div className="cut-meta muted small">
      {cut.durationSeconds !== undefined ? <span>{cut.durationSeconds.toFixed(1)} s</span> : null}
      {cut.width ? <span>{cut.width}×{cut.height}</span> : null}
      {cut.megabytes !== undefined ? <span>{cut.megabytes.toFixed(1)} MB</span> : null}
      {cut.voice !== undefined ? <span>{cut.voice ? "with your voice" : "captions only, no voice"}</span> : null}
      {cut.renderMs !== undefined ? <span>rendered in {duration(cut.renderMs)}</span> : null}
      {cut.trigger && cut.trigger !== "plan" ? <span>{cut.trigger === "creator" ? "revised at your request" : "revised on the agent's own judgement"}</span> : null}
    </div>
  );
}

function CriticCard({ critique }: { critique: Critique }) {
  const scores = Object.entries(critique.scores);
  return (
    <div className={`critic ${critique.passed ? "critic-pass" : "critic-fail"}`}>
      <div className="tool-section-label">
        The critic {critique.passed ? "passed" : "did not pass"} this cut{critique.mean !== undefined ? `, ${critique.mean.toFixed(1)} of 5 on average` : ""}
      </div>
      {scores.length ? (
        <div className="scores">
          {scores.map(([name, value]) => (
            <div key={name} className="score">
              <span>{name}</span>
              <span className="score-bar">
                <i style={{ width: `${Math.max(0, Math.min(5, value)) * 20}%` }} />
              </span>
              <span className="mono small">{value.toFixed(1)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {critique.summary ? <Markdown text={critique.summary} /> : null}
      {critique.path ? <div className="muted small mono">{critique.path}</div> : null}
    </div>
  );
}

function CutsTab({ runId, cuts, pendingCut, focus, onCompare }: { runId: string; cuts: Cut[]; pendingCut: boolean; focus?: number; onCompare: (revision: number) => void }) {
  const [pick, setPick] = useState<number | undefined>(focus);
  useEffect(() => setPick(focus), [focus]);
  const cut = cuts.find((c) => c.revision === pick) ?? cuts[cuts.length - 1];
  if (!cut) return <Empty icon="film" title="No cut yet">Each full render appears here as its own revision, with the contact sheet the agent checked it against.</Empty>;
  const pending = pendingCut && cut === cuts.findLast((c) => c.submitted);

  return (
    <div className="studio-pane">
      <div className="rev-bar">
        {cuts.map((c) => (
          <button type="button" key={c.revision} className={`rev ${c === cut ? "on" : ""}`} onClick={() => setPick(c.revision)}>
            Cut {c.revision}
            {c.submitted ? <ReviewBadge review={c.review} pending={pendingCut && c === cuts.findLast((x) => x.submitted)} /> : <span className="badge">Not handed in</span>}
          </button>
        ))}
      </div>
      <div className="cut-stage">
        {/* biome-ignore lint/a11y/useMediaCaption: a cut carries its captions burned in; there is no caption file to attach. */}
        <video key={cut.path} src={runFileUrl(runId, cut.path)} controls preload="metadata" playsInline className="reel-video" />
      </div>
      <div className="cut-info">
        <div className="cut-title">
          <strong>Cut {cut.revision}</strong>
          <ReviewBadge review={cut.review} pending={pending} />
          <span className="grow" />
          <button type="button" className="btn btn-small" onClick={() => onCompare(cut.revision)}>
            <Icon name="split" size={13} /> Against the script
          </button>
          <a className="btn btn-small" href={runFileUrl(runId, cut.path)} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={13} /> Open
          </a>
        </div>
        <CutMeta cut={cut} />
        {cut.submitted?.note ? (
          <div className="review-note">
            <div className="tool-section-label">The agent's note with it</div>
            <Markdown text={cut.submitted.note} />
          </div>
        ) : null}
        {cut.critique ? <CriticCard critique={cut.critique} /> : null}
        <ReviewNotes review={cut.review} />
        {cut.sheet ? (
          <div>
            <div className="tool-section-label">Contact sheet the agent checked</div>
            <a href={artifactUrl(runId, cut.sheet.sha256, cut.sheet.mediaType)} target="_blank" rel="noopener noreferrer">
              <img className="sheet" src={artifactUrl(runId, cut.sheet.sha256, cut.sheet.mediaType)} alt={`Twelve frames from cut ${cut.revision}`} loading="lazy" />
            </a>
          </div>
        ) : null}
        {cut.submitted?.sha256 ? <div className="muted small mono">sha256 {cut.submitted.sha256}</div> : null}
      </div>
    </div>
  );
}

/** The cut on one side, the narration on the other, lit up word by word as it plays. Click a word to go there. */
function CompareTab({ runId, cuts, scripts, revision, version }: { runId: string; cuts: Cut[]; scripts: ScriptRevision[]; revision?: number; version: number }) {
  const [pick, setPick] = useState<number | undefined>(revision);
  useEffect(() => setPick(revision), [revision]);
  const cut = cuts.find((c) => c.revision === pick) ?? cuts[cuts.length - 1];
  const approved = scripts.findLast((s) => s.review?.decision === "approved") ?? scripts[scripts.length - 1];
  const { script, narration } = useRevisionText(runId, approved, approved === scripts[scripts.length - 1], version);
  const wordsFile = useText(cut ? runFileUrl(runId, "film/words.json") : undefined, version);
  const words: TimedWord[] = useMemo(() => {
    try {
      return parseWords(JSON.parse(wordsFile.text ?? "[]"));
    } catch {
      return [];
    }
  }, [wordsFile.text]);
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const current = wordAt(words, time);
  // Keeps the word being spoken in view: the ref moves to each new word as it is reached.
  const follow = useCallback((el: HTMLButtonElement | null) => el?.scrollIntoView({ block: "nearest" }), []);

  if (!cut) return <Empty icon="split" title="Nothing to compare yet">Once a cut is rendered, it plays here next to the script it was made from.</Empty>;
  const lines = narrationLines(narration ?? "");

  return (
    <div className="studio-pane compare">
      <div className="rev-bar">
        {cuts.map((c) => (
          <button type="button" key={c.revision} className={`rev ${c === cut ? "on" : ""}`} onClick={() => setPick(c.revision)}>
            Cut {c.revision}
          </button>
        ))}
        <span className="grow" />
        <span className="muted small">{approved ? `${approved.draft ? "Draft" : `Script ${approved.n}`}${approved.review?.decision === "approved" ? ", approved" : ""}` : ""}</span>
      </div>
      <div className="compare-grid">
        <div className="compare-video">
          {/* biome-ignore lint/a11y/useMediaCaption: a cut carries its captions burned in; there is no caption file to attach. */}
          <video
            ref={video}
            key={cut.path}
            src={runFileUrl(runId, cut.path)}
            controls
            preload="metadata"
            playsInline
            className="reel-video"
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setTime(e.currentTarget.currentTime)}
          />
          <div className="muted small mono">{time.toFixed(2)} s</div>
        </div>
        <div className="compare-text">
          {words.length ? (
            <>
              <div className="tool-section-label">
                <Icon name="mic" size={13} /> What is said, timed to the voice
              </div>
              <p className="karaoke">
                {words.map((w, i) => (
                  <button
                    type="button"
                    key={`${w.s}-${w.w}`}
                    ref={i === current ? follow : undefined}
                    className={i === current ? "now" : i < current ? "said" : ""}
                    onClick={() => {
                      if (video.current) {
                        video.current.currentTime = w.s;
                        void video.current.play().catch(() => undefined);
                      }
                    }}
                    title={`${w.s.toFixed(2)} s`}
                  >
                    {w.w}
                  </button>
                ))}
              </p>
              <p className="muted small">Timings are the latest ones in film/words.json. If the voiceover was timed again after this cut, they may be a little off for it.</p>
            </>
          ) : lines.length ? (
            <>
              <div className="tool-section-label">Narration</div>
              <ol className="narration-lines">
                {withKeys(lines, (l) => l.text).map(({ key, item: l }) => (
                  <li key={key}>
                    <span>{l.text}</span>
                  </li>
                ))}
              </ol>
              <p className="muted small">No word timings yet, so the text cannot follow the video.</p>
            </>
          ) : null}
          {script ? (
            <details className="compare-script">
              <summary>The script's beats and what should be on screen</summary>
              <Markdown text={script} />
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FilesTab({ runId, path, version }: { runId: string; path?: string; version: number }) {
  const [files, setFiles] = useState<FileEntry[] | undefined>();
  const [selected, setSelected] = useState<FileEntry | undefined>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` counts finished tool calls; the folder is read again each time one finishes.
  useEffect(() => {
    let live = true;
    void act(() => api.call("runs.files", { runId })).then((r) => live && r && setFiles(r.files));
    return () => {
      live = false;
    };
  }, [runId, version]);
  useEffect(() => {
    if (path && files) setSelected((current) => files.find((f) => f.path === path) ?? current);
  }, [path, files]);
  if (!files) return <div className="muted pad">Reading the working folder…</div>;
  if (!files.length) return <Empty icon="folder" title="The working folder is empty" />;
  return (
    <div className="studio-pane files-pane">
      {selected ? <FileViewer file={selected} url={runFileUrl(runId, selected.path)} onClose={() => setSelected(undefined)} /> : null}
      <FileList files={files} selected={selected?.path} onSelect={setSelected} />
    </div>
  );
}

export function Studio({ runId, events, pendingGate, target }: { runId: string; events: HarnessEvent[]; pendingGate?: string; target?: StudioTarget }) {
  const made = useMemo(() => buildDeliverables(events), [events]);
  const [tab, setTab] = useState<StudioTab>(() => (made.cuts.length ? "cuts" : "script"));
  const [focusCut, setFocusCut] = useState<number | undefined>();
  const [filePath, setFilePath] = useState<string | undefined>();
  // Files change on disk only when a tool finishes; re-read them then, not on every event.
  const version = useMemo(() => events.filter((e) => e.type === "tool.call.completed").length, [events]);

  useEffect(() => {
    if (!target) return;
    setTab(target.tab);
    if (target.tab === "cuts" && target.path) {
      const m = /cut-(\d+)\.mp4$/.exec(target.path);
      if (m) setFocusCut(Number(m[1]));
    }
    if (target.tab === "files") setFilePath(target.path);
  }, [target]);
  useEffect(() => {
    if (pendingGate === "final_cut") setTab("cuts");
    if (pendingGate === "script") setTab("script");
  }, [pendingGate]);

  return (
    <aside className="studio" aria-label="What the run made">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "script", label: "Script", icon: "script", count: made.scripts.length || undefined },
          { id: "cuts", label: "Cuts", icon: "film", count: made.cuts.length || undefined },
          { id: "compare", label: "Script vs cut", icon: "split" },
          { id: "files", label: "Files", icon: "folder" },
        ]}
      />
      <div className="studio-body">
        {tab === "script" ? <ScriptTab runId={runId} scripts={made.scripts} pendingScript={pendingGate === "script"} version={version} /> : null}
        {tab === "cuts" ? (
          <CutsTab
            runId={runId}
            cuts={made.cuts}
            pendingCut={pendingGate === "final_cut"}
            {...(focusCut !== undefined ? { focus: focusCut } : {})}
            onCompare={(revision) => {
              setFocusCut(revision);
              setTab("compare");
            }}
          />
        ) : null}
        {tab === "compare" ? <CompareTab runId={runId} cuts={made.cuts} scripts={made.scripts} {...(focusCut !== undefined ? { revision: focusCut } : {})} version={version} /> : null}
        {tab === "files" ? <FilesTab runId={runId} {...(filePath ? { path: filePath } : {})} version={version} /> : null}
      </div>
    </aside>
  );
}
