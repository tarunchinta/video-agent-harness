import { useEffect, useState, type ReactNode } from "react";
import type { RunCard } from "../../api/contract.ts";
import { statusLabel } from "../../views/describe.ts";

/** Small shared pieces: icons, status, tabs, times. */

const PATHS: Record<string, string> = {
  play: "M7 5l12 7-12 7z",
  plus: "M12 5v14M5 12h14",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  script: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4",
  audio: "M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  image: "M4 5h16v14H4zM4 15l4-4 5 5 3-3 4 4M15 9h.01",
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14",
  web: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  terminal: "M4 5h16v14H4zM8 10l3 2-3 2M13 15h3",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  review: "M12 5c-5 0-9 7-9 7s4 7 9 7 9-7 9-7-4-7-9-7zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  check: "M5 12l5 5 9-11",
  x: "M6 6l12 12M18 6L6 18",
  pause: "M8 5v14M16 5v14",
  stop: "M6 6h12v12H6z",
  chat: "M4 5h16v11H8l-4 4z",
  loop: "M4 12a8 8 0 0 1 14-5l2-2v6h-6l2-2a5 5 0 0 0-9 3M20 12a8 8 0 0 1-14 5l-2 2v-6h6l-2 2a5 5 0 0 0 9-3",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  chevron: "M9 6l6 6-6 6",
  spark: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  split: "M12 3v18M4 5h16v14H4z",
  menu: "M4 7h16M4 12h16M4 17h16",
  stage: "M4 19h16M6 15l4-4 3 3 5-6",
  warn: "M12 4l9 16H3zM12 10v4M12 17h.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
};

export function Icon({ name, size = 16, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className ?? ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.file} />
    </svg>
  );
}

export type Tone = "busy" | "wait" | "ok" | "bad" | "idle" | "warn";

export function toneOf(card: Pick<RunCard, "status" | "driver">): Tone {
  switch (card.status) {
    case "running":
      return card.driver === "none" ? "warn" : "busy";
    case "waiting_gate":
      return "wait";
    case "paused":
      return "warn";
    case "succeeded":
      return "ok";
    case "failed":
      return "bad";
    default:
      return "idle";
  }
}

export function StatusDot({ card }: { card: Pick<RunCard, "status" | "driver"> }) {
  return <span className={`dot dot-${toneOf(card)}`} aria-hidden="true" />;
}

export function StatusPill({ card }: { card: Pick<RunCard, "status" | "driver" | "statusReason" | "pendingGate"> }) {
  const label = card.status === "running" && card.driver === "none" ? "Interrupted" : statusLabel(card.status, card.statusReason, card.pendingGate);
  return (
    <span className={`pill pill-${toneOf(card)}`}>
      <StatusDot card={card} />
      {label}
    </span>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: string; icon?: string; count?: number }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button type="button" key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? "on" : ""}`} onClick={() => onChange(t.id)}>
          {t.icon ? <Icon name={t.icon} size={15} /> : null}
          {t.label}
          {t.count !== undefined ? <span className="count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon ? <Icon name={icon} size={28} /> : null}
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-body">{children}</div> : null}
    </div>
  );
}

/** Ticks once a second while mounted, for clocks and running timers. */
export function useNow(active = true, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86_400);
  if (days < 14) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function Ago({ iso }: { iso: string }) {
  const now = useNow(true, 30_000);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso, now)}
    </time>
  );
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

export const KIND_ICON: Record<string, string> = {
  script: "script",
  narration: "mic",
  notes: "file",
  research: "web",
  video: "film",
  audio: "audio",
  image: "image",
  code: "code",
  data: "list",
  page: "code",
  other: "file",
};
