import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HarnessEvent } from "@harness/harness";
import { artifactUrl } from "../../api/client.ts";
import { buildChat, type ChatItem, type ToolCallView } from "../../views/chat.ts";
import { decisionPhrase, duration, gateName } from "../../views/describe.ts";
import { withKeys } from "../keys.ts";
import { Markdown } from "./Markdown.tsx";
import { clock, Icon } from "./ui.tsx";

/** The run as a conversation, read from the log. Tool calls fold into the step that asked for them. */

const FAMILY_ICON: Record<string, string> = { file: "file", command: "terminal", web: "web", stage: "stage", review: "review", render: "film", voice: "mic", finish: "flag", other: "spark" };

const STATUS_TEXT: Record<ToolCallView["status"], string> = { queued: "Not started", running: "Running", ok: "Done", failed: "Did not run", waiting: "Waiting for you" };

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolInput({ call }: { call: ToolCallView }) {
  const input = (call.input ?? {}) as Record<string, unknown>;
  if (call.tool === "write_file" && typeof input.content === "string") {
    return (
      <div className="tool-section">
        <div className="tool-section-label">Wrote {String(input.path ?? "")}</div>
        <pre className="code code-tool">
          <code>{input.content}</code>
        </pre>
      </div>
    );
  }
  if (call.tool === "run_command" && Array.isArray(input.command)) {
    return (
      <div className="tool-section">
        <div className="tool-section-label">Command{typeof input.cwd === "string" && input.cwd !== "." ? ` in ${input.cwd}` : ""}</div>
        <pre className="code code-tool">
          <code>$ {(input.command as unknown[]).map(String).join(" ")}</code>
        </pre>
      </div>
    );
  }
  if (!Object.keys(input).length) return null;
  return (
    <div className="tool-section">
      <div className="tool-section-label">Input</div>
      <pre className="code code-tool">
        <code>{pretty(call.input)}</code>
      </pre>
    </div>
  );
}

export function ToolCard({ call, runId, defaultOpen = false }: { call: ToolCallView; runId: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`tool tool-${call.status} fam-${call.family}`}>
      <button type="button" className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-icon">
          <Icon name={FAMILY_ICON[call.family] ?? "spark"} size={14} />
        </span>
        <span className="tool-title">{call.title}</span>
        {call.extractCalls ? <span className="tag" title="The page went to a model call with no tools, and only checked facts came back">read safely</span> : null}
        {call.images.length ? (
          <span className="tag">
            <Icon name="image" size={12} /> {call.images.length}
          </span>
        ) : null}
        <span className={`tool-status st-${call.status}`}>
          {call.status === "running" ? <span className="spinner" /> : null}
          {STATUS_TEXT[call.status]}
        </span>
        {call.durationMs !== undefined ? <span className="muted small mono">{duration(call.durationMs)}</span> : null}
        <Icon name="chevron" size={12} className={open ? "rot" : ""} />
      </button>
      {call.images.length && !open ? (
        <div className="tool-thumbs">
          {call.images.map((img) => (
            <a key={img.sha256} href={artifactUrl(runId, img.sha256, img.mediaType)} target="_blank" rel="noopener noreferrer">
              <img src={artifactUrl(runId, img.sha256, img.mediaType)} alt="What the agent was shown" loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="tool-body">
          <ToolInput call={call} />
          {call.error ? (
            <div className="tool-section">
              <div className="tool-section-label">Why it did not run ({call.error.kind.replaceAll("_", " ")})</div>
              <pre className="code code-tool code-error">
                <code>{call.error.message}</code>
              </pre>
            </div>
          ) : null}
          {call.output !== undefined ? (
            <div className="tool-section">
              <div className="tool-section-label">
                What the agent read back{call.truncated ? ` (cut to a preview; the full text is in ${call.outputPath ?? "a file"})` : ""}
              </div>
              <pre className="code code-tool">
                <code>{call.output}</code>
              </pre>
            </div>
          ) : null}
          {call.images.length ? (
            <div className="tool-section">
              <div className="tool-section-label">Pictures shown with the result</div>
              <div className="tool-images">
                {call.images.map((img) => (
                  <a key={img.sha256} href={artifactUrl(runId, img.sha256, img.mediaType)} target="_blank" rel="noopener noreferrer">
                    <img src={artifactUrl(runId, img.sha256, img.mediaType)} alt="What the agent was shown" loading="lazy" />
                  </a>
                ))}
              </div>
            </div>
          ) : null}
          <div className="tool-foot muted small mono">
            {call.tool} · call {call.callId.slice(0, 18)}
            {call.startedSeq ? ` · events ${call.startedSeq}${call.endSeq ? `–${call.endSeq}` : ""}` : ""}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolGroup({ item, runId }: { item: Extract<ChatItem, { kind: "tools" }>; runId: string }) {
  const busy = item.calls.some((c) => c.status === "running" || c.status === "waiting");
  const failed = item.calls.filter((c) => c.status === "failed").length;
  const [open, setOpen] = useState(item.calls.length <= 3);
  useEffect(() => {
    if (busy) setOpen(true);
  }, [busy]);
  return (
    <div className="step">
      <div className="step-rail" aria-hidden="true" />
      {item.calls.length > 3 ? (
        <button type="button" className="step-summary" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name="chevron" size={12} className={open ? "rot" : ""} />
          {item.step !== undefined ? <span className="mono muted">Step {item.step}</span> : null}
          <span>
            {item.calls.length} tool calls{failed ? `, ${failed} did not run` : ""}
          </span>
          {!open ? <span className="muted small">{[...new Set(item.calls.map((c) => c.tool))].join(", ")}</span> : null}
        </button>
      ) : item.step !== undefined ? (
        <div className="step-label mono muted">Step {item.step}</div>
      ) : null}
      {open ? item.calls.map((call) => <ToolCard key={call.callId} call={call} runId={runId} />) : null}
    </div>
  );
}

function ReviewCard({ item, onOpenFile }: { item: Extract<ChatItem, { kind: "review" }>; onOpenFile: (path: string) => void }) {
  const isCut = item.gate === "final_cut";
  return (
    <div className={`review ${item.decision ? `review-${item.decision.decision}` : "review-open"}`}>
      <div className="review-head">
        <Icon name={isCut ? "film" : "script"} size={16} />
        <strong>{isCut ? `Cut ${item.revision ?? ""} handed in for your review` : "Script handed in for your review"}</strong>
        <span className="muted small">{clock(item.at)}</span>
      </div>
      <div className="review-files">
        {item.files.map((f) => (
          <button type="button" key={f} className="chip" onClick={() => onOpenFile(f)}>
            <Icon name={/\.mp4$/.test(f) ? "film" : "file"} size={13} /> {f}
          </button>
        ))}
      </div>
      {item.words !== undefined || item.estimatedSeconds !== undefined ? (
        <div className="muted small">
          {item.words !== undefined ? `${item.words} words of narration` : ""}
          {item.estimatedSeconds !== undefined ? `, about ${item.estimatedSeconds} seconds read aloud` : ""}
        </div>
      ) : null}
      {item.note ? (
        <div className="review-note">
          <div className="tool-section-label">The agent's note</div>
          <Markdown text={item.note} />
        </div>
      ) : null}
      {item.sha256 ? <div className="muted small mono" title="The exact bytes you reviewed">sha256 {item.sha256.slice(0, 16)}…</div> : null}
      {!item.decision ? <div className="review-cta">Answer below: approve it, ask for changes, or reject it.</div> : null}
    </div>
  );
}

function Item({ item, runId, onOpenFile }: { item: ChatItem; runId: string; onOpenFile: (path: string) => void }) {
  switch (item.kind) {
    case "brief":
      return (
        <div className="msg msg-you">
          <div className="msg-who">You asked for</div>
          <div className="bubble bubble-you">
            <div className="brief-title">{item.title}</div>
            <details className="brief-task">
              <summary>The full brief the agent was given</summary>
              <Markdown text={item.task} />
            </details>
            <div className="muted small">
              {item.model}
              {item.project ? ` · projects/${item.project}` : ""}
            </div>
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="msg msg-agent">
          <div className="msg-who">
            Agent <span className="muted small">{clock(item.at)}</span>
          </div>
          <div className="bubble bubble-agent">
            <Markdown text={item.text} />
          </div>
        </div>
      );
    case "thinking":
      return (
        <details className="thinking">
          <summary>Thought</summary>
          <Markdown text={item.text} />
        </details>
      );
    case "tools":
      return <ToolGroup item={item} runId={runId} />;
    case "stage":
      return (
        <div className="divider">
          <span>
            <Icon name="stage" size={13} /> {item.label}
          </span>
        </div>
      );
    case "review":
      return <ReviewCard item={item} onOpenFile={onOpenFile} />;
    case "decision":
      return (
        <div className="msg msg-you">
          <div className="msg-who">You</div>
          <div className={`bubble bubble-you decision-${item.decision}`}>
            <div>
              <strong>{item.decision === "approved" ? "Approved" : item.decision === "rejected" ? "Rejected" : "Asked for changes"}</strong> the {gateName(item.gate)}.
            </div>
            {withKeys(item.notes, (n) => n).map(({ key, item: n }) => (
              <Markdown key={key} text={n} />
            ))}
          </div>
        </div>
      );
    case "note":
      return (
        <div className={`note note-${item.tone}`}>
          <Icon name={item.tone === "info" ? "info" : "warn"} size={14} />
          <div>
            <div>{item.text}</div>
            {item.detail ? <div className="muted small">{item.detail}</div> : null}
          </div>
        </div>
      );
  }
}

export function Chat({ events, runId, liveText, working, footer, onOpenFile }: { events: HarnessEvent[]; runId: string; liveText: string; working: boolean; footer?: React.ReactNode; onOpenFile: (path: string) => void }) {
  const items = useMemo(() => buildChat(events), [events]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [jump, setJump] = useState(false);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setJump(!pinned.current);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the bottom whenever new content arrives; the content itself is not read here.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items, liveText]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: opening another run starts at its latest message.
  useEffect(() => {
    pinned.current = true;
  }, [runId]);

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        <div className="chat-inner">
          {items.map((item) => (
            <Item key={item.key} item={item} runId={runId} onOpenFile={onOpenFile} />
          ))}
          {liveText ? (
            <div className="msg msg-agent">
              <div className="msg-who">
                Agent <span className="live">typing</span>
              </div>
              <div className="bubble bubble-agent">
                <Markdown text={liveText} />
              </div>
            </div>
          ) : working ? (
            <div className="working">
              <span className="spinner" /> Working…
            </div>
          ) : null}
        </div>
      </div>
      {jump ? (
        <button type="button"
          className="jump"
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          Latest ↓
        </button>
      ) : null}
      {footer}
    </div>
  );
}

export { decisionPhrase };
