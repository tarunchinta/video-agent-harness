import { useEffect, useRef, useState } from "react";
import type { RunState } from "@harness/harness";
import type { LimitsInput, RunCard, VoiceoverChoice } from "../../api/contract.ts";
import { gateName } from "../../views/describe.ts";
import { act, api, store } from "../store.ts";
import { Icon } from "./ui.tsx";

/**
 * What you can say to a run depends on where it is: at a review you answer it, while it works you can pause or
 * cancel it, and when it is paused you can raise a limit and resume it. The harness has no steering yet, so
 * there is no free-text message to a working agent; that is said plainly instead of faked.
 */

const AUDIO = ".m4a,.mp3,.wav,.aac,.ogg,.flac,.opus,.webm,.mp4,.mov";

function ReviewComposer({ card, state }: { card: RunCard; state: RunState }) {
  const gate = state.pendingGate!;
  const reelScript = gate === "script" && state.config.pipeline === "reel";
  const [notes, setNotes] = useState("");
  const [voice, setVoice] = useState<"file" | "none" | "keep">("file");
  const [file, setFile] = useState<File | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [progress, setProgress] = useState<string | undefined>();
  const area = useRef<HTMLTextAreaElement>(null);

  const send = async (decision: "approved" | "changes_requested" | "rejected") => {
    if (decision === "changes_requested" && !notes.trim()) {
      store.notify("Say what to change, so the agent knows what to fix.", "error");
      area.current?.focus();
      return;
    }
    if (decision === "rejected" && !window.confirm("Rejecting ends the run for good. Reject it?")) return;
    setBusy(decision);
    let voiceover: VoiceoverChoice | undefined;
    if (decision === "approved" && reelScript) {
      if (voice === "file") {
        if (!file) {
          store.notify("Choose your recording of the narration, or pick “No voiceover”.", "error");
          setBusy(undefined);
          return;
        }
        setProgress(`Sending ${file.name}…`);
        const name = await act(() => api.upload(card.runId, file, file.name));
        setProgress(undefined);
        if (!name) return setBusy(undefined);
        voiceover = { kind: "upload", name };
      } else voiceover = { kind: voice };
    }
    const result = await act(() => api.call("runs.decide", { runId: card.runId, gate, decision, notes, ...(voiceover ? { voiceover } : {}) }));
    setBusy(undefined);
    if (result) {
      store.takeCard(result.card);
      setNotes("");
      setFile(undefined);
    }
  };

  return (
    <div className="composer composer-review">
      <div className="composer-title">
        <Icon name={gate === "final_cut" ? "film" : "script"} size={16} />
        Your review of the {gateName(gate)}
      </div>
      <textarea
        ref={area}
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={gate === "final_cut" ? "What to change in the cut, with timestamps if you can. Leave empty to approve as it is." : "What to change in the script. Leave empty to approve as it is."}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(notes.trim() ? "changes_requested" : "approved");
        }}
      />
      {reelScript ? (
        <div className="voice">
          <div className="voice-label">
            <Icon name="mic" size={14} /> Voiceover, needed to approve
          </div>
          <div className="voice-options">
            <label className={`voice-opt ${voice === "file" ? "on" : ""}`}>
              <input type="radio" name="voice" checked={voice === "file"} onChange={() => setVoice("file")} />
              <span>My recording</span>
              <input type="file" accept={AUDIO} onChange={(e) => { setFile(e.target.files?.[0]); setVoice("file"); }} />
              {file ? <span className="muted small">{file.name}</span> : null}
            </label>
            <label className={`voice-opt ${voice === "none" ? "on" : ""}`}>
              <input type="radio" name="voice" checked={voice === "none"} onChange={() => setVoice("none")} />
              <span>No voiceover: captions with stand-in timing</span>
            </label>
            <label className={`voice-opt ${voice === "keep" ? "on" : ""}`}>
              <input type="radio" name="voice" checked={voice === "keep"} onChange={() => setVoice("keep")} />
              <span>Keep the recording the run already has</span>
            </label>
          </div>
        </div>
      ) : null}
      <div className="composer-actions">
        <span className="muted small">{progress ?? "Ctrl+Enter sends. Your answer becomes the result of the agent's hand-in, word for word."}</span>
        <button type="button" className="btn btn-danger-quiet" disabled={Boolean(busy)} onClick={() => void send("rejected")}>
          Reject
        </button>
        <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void send("changes_requested")}>
          {busy === "changes_requested" ? "Sending…" : "Ask for changes"}
        </button>
        <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void send("approved")}>
          <Icon name="check" size={14} /> {busy === "approved" ? "Approving…" : "Approve"}
        </button>
      </div>
    </div>
  );
}

function ResumeComposer({ card, state }: { card: RunCard; state: RunState }) {
  const [usd, setUsd] = useState("");
  const [minutes, setMinutes] = useState("");
  const [steps, setSteps] = useState("");
  const [busy, setBusy] = useState(false);
  const reason = state.statusReason ?? "";
  const atLimit = reason.startsWith("budget:");
  const interrupted = state.status === "running" && card.driver === "none";

  const resume = async () => {
    const limits: LimitsInput = {
      ...(Number(usd) > 0 ? { max_cost_micro_usd: Math.round(Number(usd) * 1_000_000) } : {}),
      ...(Number(minutes) > 0 ? { max_active_ms: Math.round(Number(minutes) * 60_000) } : {}),
      ...(Number(steps) > 0 ? { max_steps: Math.round(Number(steps)) } : {}),
    };
    setBusy(true);
    const result = await act(() => api.call("runs.resume", { runId: card.runId, limits }));
    setBusy(false);
    if (result) store.takeCard(result.card);
  };

  return (
    <div className="composer">
      <div className="composer-title">
        <Icon name={interrupted ? "warn" : "pause"} size={16} />
        {interrupted
          ? "This run was interrupted: nothing is working on it. Resuming closes what was cut off and tells the agent."
          : atLimit
            ? `Paused at the ${reason.slice(7).replaceAll("_", " ")} limit. Raise it to carry on.`
            : reason === "error:sandbox"
              ? "Paused: the sandbox could not start. Check that Docker is running and the image is built."
              : reason.startsWith("error:")
                ? "Paused: the model could not be reached. Try again when it can."
                : "Paused. Resume it when you are ready."}
      </div>
      {atLimit ? (
        <div className="row">
          <label className="field field-small">
            <span>Spend at most</span>
            <div className="with-unit">
              <span>$</span>
              <input type="number" min={0} step="0.5" value={usd} onChange={(e) => setUsd(e.target.value)} placeholder={state.limits.max_cost_micro_usd ? String(state.limits.max_cost_micro_usd / 1_000_000) : "no limit"} />
            </div>
          </label>
          <label className="field field-small">
            <span>Work at most</span>
            <div className="with-unit">
              <input type="number" min={0} value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder={state.limits.max_active_ms ? String(Math.round(state.limits.max_active_ms / 60_000)) : "no limit"} />
              <span>min</span>
            </div>
          </label>
          <label className="field field-small">
            <span>Steps</span>
            <input type="number" min={0} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={state.limits.max_steps ? String(state.limits.max_steps) : "no limit"} />
          </label>
        </div>
      ) : null}
      <div className="composer-actions">
        {card.driveError ? <span className="error-text">{card.driveError}</span> : <span />}
        <CancelButton runId={card.runId} />
        <button type="button" className="btn btn-primary" disabled={busy || card.driver === "elsewhere"} onClick={() => void resume()}>
          <Icon name="play" size={14} /> {busy ? "Resuming…" : "Resume"}
        </button>
      </div>
    </div>
  );
}

function CancelButton({ runId }: { runId: string }) {
  return (
    <button type="button"
      className="btn btn-danger-quiet"
      onClick={() => {
        if (!window.confirm("Cancelling ends the run for good. Cancel it?")) return;
        void act(() => api.call("runs.cancel", { runId })).then((r) => r && store.takeCard(r.card));
      }}
    >
      Cancel run
    </button>
  );
}

function WorkingComposer({ card, state }: { card: RunCard; state: RunState }) {
  const [asked, setAsked] = useState(false);
  useEffect(() => setAsked(state.pauseRequested), [state.pauseRequested]);
  return (
    <div className="composer composer-quiet">
      <div className="composer-row">
        <span className="spinner" />
        <span>
          {card.driver === "elsewhere"
            ? "Working, driven from another window (a terminal). It shows here live."
            : state.cancelRequested
              ? "Stopping at the next step, as you asked."
              : asked
                ? "Pausing after the current step."
                : "The agent is working. It stops by itself at each review."}
        </span>
        <span className="grow" />
        <button type="button"
          className="btn"
          disabled={asked || state.cancelRequested}
          onClick={() =>
            void act(() => api.call("runs.pause", { runId: card.runId })).then((r) => {
              if (!r) return;
              setAsked(true);
              store.takeCard(r.card);
            })
          }
        >
          <Icon name="pause" size={14} /> Pause
        </button>
        <CancelButton runId={card.runId} />
      </div>
    </div>
  );
}

export function Composer({ card, state, film, onOpenFile }: { card: RunCard; state: RunState; film?: string; onOpenFile: (path: string) => void }) {
  if (state.status === "waiting_gate" && state.pendingGate) {
    if (card.driver === "elsewhere") return <div className="composer composer-quiet">Waiting for your review, in the window that is driving this run.</div>;
    return <ReviewComposer key={`${state.pendingGate}-${state.lastSeq}`} card={card} state={state} />;
  }
  if (state.status === "paused" || (state.status === "running" && card.driver === "none") || state.status === "created") {
    if (state.status === "created") {
      return (
        <div className="composer">
          <div className="composer-row">
            <span>{card.driveError ?? "This run has not started."}</span>
            <span className="grow" />
            <button type="button" className="btn btn-primary" onClick={() => void act(() => api.call("runs.resume", { runId: card.runId })).then((r) => r && store.takeCard(r.card))}>
              <Icon name="play" size={14} /> Start
            </button>
          </div>
        </div>
      );
    }
    return <ResumeComposer card={card} state={state} />;
  }
  if (state.status === "running") return <WorkingComposer card={card} state={state} />;
  if (state.status === "succeeded") {
    return (
      <div className="composer composer-done">
        <Icon name="check" size={16} />
        <span>Done.{film ? " The approved cut is ready." : ""}</span>
        <span className="grow" />
        {film ? (
          <button type="button" className="btn btn-primary" onClick={() => onOpenFile(film)}>
            <Icon name="film" size={14} /> Watch the final cut
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="composer composer-quiet">
      <Icon name="info" size={16} /> {state.status === "cancelled" ? "This run was cancelled." : `This run stopped: ${state.failure?.message ?? "it failed."}`} Start a new one to try again.
    </div>
  );
}
