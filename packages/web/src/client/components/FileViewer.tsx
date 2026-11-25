import { useEffect, useState } from "react";
import type { FileEntry } from "../../api/contract.ts";
import { Markdown } from "./Markdown.tsx";
import { bytes, Icon, KIND_ICON } from "./ui.tsx";

/** Shows one file: text as Markdown or as source, media in a player. Agent-written pages show as source. */

const MAX_TEXT = 400_000;

export function useText(url: string | undefined, version?: string | number): { text?: string; error?: string; loading: boolean } {
  const [state, setState] = useState<{ text?: string; error?: string; loading: boolean }>({ loading: Boolean(url) });
  useEffect(() => {
    if (!url) return setState({ loading: false });
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    // The version is part of the address, so a file that changed on disk is read again.
    fetch(version === undefined ? url : `${url}?v=${encodeURIComponent(String(version))}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "This file is not there (yet)." : `Could not read the file (${r.status}).`);
        const text = await r.text();
        return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n… (cut off: the file is ${bytes(text.length)})` : text;
      })
      .then((text) => live && setState({ text, loading: false }))
      .catch((err: Error) => live && setState({ error: err.message, loading: false }));
    return () => {
      live = false;
    };
  }, [url, version]);
  return state;
}

export function FileViewer({ file, url, onClose }: { file: FileEntry; url: string; onClose?: () => void }) {
  const textual = !["video", "audio", "image", "other"].includes(file.kind) || /\.(txt|md|json|srt|log)$/i.test(file.path);
  const { text, error, loading } = useText(textual ? url : undefined, file.modifiedAt);
  const markdown = /\.md$/i.test(file.path);
  return (
    <div className="viewer">
      <div className="viewer-head">
        <Icon name={KIND_ICON[file.kind] ?? "file"} size={15} />
        <span className="viewer-path" title={file.path}>
          {file.path}
        </span>
        <span className="muted small">{bytes(file.bytes)}</span>
        <a className="icon-btn" href={url} target="_blank" rel="noopener noreferrer" title="Open on its own">
          <Icon name="external" size={14} />
        </a>
        {onClose ? (
          <button type="button" className="icon-btn" onClick={onClose} title="Close">
            <Icon name="x" size={14} />
          </button>
        ) : null}
      </div>
      <div className="viewer-body">
        {file.kind === "video" ? (
          <div className="player-frame">
            {/* biome-ignore lint/a11y/useMediaCaption: these are the creator's own files; no caption file exists for them. */}
            <video src={url} controls preload="metadata" playsInline />
            {/\.mkv$/i.test(file.path) ? <p className="muted small">Some browsers cannot play .mkv files. Open it on its own to download it.</p> : null}
          </div>
        ) : file.kind === "audio" ? (
          // biome-ignore lint/a11y/useMediaCaption: these are the creator's own recordings; no caption file exists for them.
          <audio src={url} controls preload="metadata" className="audio" />
        ) : file.kind === "image" ? (
          <img src={url} alt={file.path} className="viewer-image" />
        ) : loading ? (
          <div className="muted pad">Reading…</div>
        ) : error ? (
          <div className="muted pad">{error}</div>
        ) : markdown ? (
          <Markdown text={text ?? ""} />
        ) : (
          <pre className="code code-file">
            <code>{text}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

/** Files grouped by kind, for a project or a run. */
export function FileList({ files, selected, onSelect, group = true }: { files: FileEntry[]; selected?: string; onSelect: (f: FileEntry) => void; group?: boolean }) {
  const order: [string, string[]][] = [
    ["Scripts and narration", ["script", "narration"]],
    ["Notes and research", ["notes", "research"]],
    ["Video", ["video"]],
    ["Recordings", ["audio"]],
    ["Pictures", ["image"]],
    ["Code and data", ["code", "data", "page"]],
    ["Other", ["other"]],
  ];
  const groups = group ? order.map(([label, kinds]) => ({ label, files: files.filter((f) => kinds.includes(f.kind)) })).filter((g) => g.files.length) : [{ label: "", files }];
  return (
    <div className="file-list">
      {groups.map((g) => (
        <div key={g.label} className="file-group">
          {g.label ? <div className="file-group-label">{g.label}</div> : null}
          {g.files.map((f) => (
            <button type="button" key={f.path} className={`file-row ${selected === f.path ? "on" : ""}`} onClick={() => onSelect(f)} title={f.path}>
              <Icon name={KIND_ICON[f.kind] ?? "file"} size={14} />
              <span className="file-name">{f.path}</span>
              <span className="muted small">{bytes(f.bytes)}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
