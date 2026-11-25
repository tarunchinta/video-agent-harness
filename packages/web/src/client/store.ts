import { useSyncExternalStore } from "react";
import type { HarnessEvent, RunState } from "@harness/harness";
import { ApiClient, parseFrame } from "../api/client.ts";
import type { Frame, HostInfo, Project, RunCard } from "../api/contract.ts";

/**
 * Everything the page knows, in one place: the run list, the projects, and the open run's log. The log is
 * only ever appended to, in `seq` order, from the stream; what each panel shows is a pure view of it.
 */

export type OpenRun = {
  runId: string;
  events: HarnessEvent[];
  state?: RunState;
  card?: RunCard;
  /** Model text streaming right now. Replaced by the finished text when the call completes. */
  liveText: string;
  loading: boolean;
  error?: string;
};

export type AppState = {
  host?: HostInfo;
  runs: RunCard[];
  projects: Project[];
  connected: boolean;
  open?: OpenRun;
  toast?: { text: string; tone: "info" | "error"; id: number };
};

export const api = new ApiClient();

class Store {
  private state: AppState = { runs: [], projects: [], connected: false };
  private readonly listeners = new Set<() => void>();
  private source: EventSource | undefined;
  private streamRun: string | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get = () => this.state;

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
  private setOpen(patch: Partial<OpenRun>): void {
    if (!this.state.open) return;
    this.set({ open: { ...this.state.open, ...patch } });
  }

  async boot(): Promise<void> {
    this.connect(undefined);
    try {
      const [host, projects] = await Promise.all([api.call("host.describe", {}), api.call("projects.list", {})]);
      this.set({ host, projects: projects.projects });
    } catch (err) {
      this.notify((err as Error).message, "error");
    }
  }

  async refreshProjects(): Promise<void> {
    try {
      this.set({ projects: (await api.call("projects.list", {})).projects });
    } catch (err) {
      this.notify((err as Error).message, "error");
    }
  }

  /** Opens a run: loads its whole log, then follows it on the stream from where the load ended. */
  async openRun(runId: string | undefined): Promise<void> {
    if (!runId) {
      if (this.state.open) this.set({ open: undefined });
      this.connect(undefined);
      return;
    }
    if (this.state.open?.runId === runId) return;
    this.set({ open: { runId, events: [], liveText: "", loading: true } });
    try {
      const got = await api.call("runs.get", { runId });
      if (this.state.open?.runId !== runId) return;
      this.setOpen({ events: got.events, state: got.state, card: got.card, loading: false });
      this.connect(runId);
    } catch (err) {
      if (this.state.open?.runId === runId) this.setOpen({ loading: false, error: (err as Error).message });
    }
  }

  private connect(runId: string | undefined): void {
    if (this.source && this.streamRun === runId) return;
    this.source?.close();
    if (this.retry) clearTimeout(this.retry);
    this.streamRun = runId;
    const after = runId && this.state.open?.runId === runId ? (this.state.open.events.at(-1)?.seq ?? 0) : 0;
    const source = new EventSource(`/api/stream${runId ? `?run=${encodeURIComponent(runId)}&after=${after}` : ""}`);
    this.source = source;
    source.onopen = () => this.set({ connected: true });
    source.onmessage = (message) => {
      const frame = parseFrame(message.data as string);
      if (frame) this.onFrame(frame);
    };
    source.onerror = () => {
      this.set({ connected: false });
      // Reconnect = rebuild from where we are, as the DeepSeek harness does: no resume cursor on the server.
      source.close();
      if (this.source !== source) return;
      this.source = undefined;
      this.retry = setTimeout(() => this.connect(this.streamRun), 1500);
    };
  }

  private onFrame(frame: Frame): void {
    switch (frame.type) {
      case "runs": {
        const open = this.state.open;
        const card = open ? frame.runs.find((r) => r.runId === open.runId) : undefined;
        this.set({ runs: frame.runs, ...(open && card ? { open: { ...open, card } } : {}) });
        break;
      }
      case "projects":
        this.set({ projects: frame.projects });
        break;
      case "events": {
        const open = this.state.open;
        if (!open || open.runId !== frame.runId) break;
        const last = open.events.at(-1)?.seq ?? 0;
        const fresh = frame.events.filter((e) => e.seq > last).sort((a, b) => a.seq - b.seq);
        // A gap means a frame was missed while reconnecting: load the run again rather than show a hole.
        if (fresh.length && fresh[0]!.seq !== last + 1) {
          const runId = open.runId;
          this.set({ open: undefined });
          void this.openRun(runId);
          break;
        }
        if (!fresh.length) break;
        const endsText = fresh.some((e) => e.agentId === "main" && (e.type === "model.call.completed" || e.type === "model.call.failed" || e.type === "model.call.started"));
        this.setOpen({ events: [...open.events, ...fresh], state: frame.state, ...(endsText ? { liveText: "" } : {}) });
        break;
      }
      case "text": {
        const open = this.state.open;
        if (open?.runId === frame.runId) this.setOpen({ liveText: open.liveText + frame.delta });
        break;
      }
    }
  }

  notify(text: string, tone: "info" | "error" = "info"): void {
    this.set({ toast: { text, tone, id: Date.now() } });
  }
  dismiss(): void {
    this.set({ toast: undefined });
  }

  /** Puts a card the server returned in place, without waiting for the stream. */
  takeCard(card: RunCard): void {
    const runs = this.state.runs.some((r) => r.runId === card.runId) ? this.state.runs.map((r) => (r.runId === card.runId ? card : r)) : [card, ...this.state.runs];
    this.set({ runs, ...(this.state.open?.runId === card.runId ? { open: { ...this.state.open, card } } : {}) });
  }
}

export const store = new Store();

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

/** Runs a call and reports a failure as a toast. Returns undefined when it failed. */
export async function act<T>(work: () => Promise<T>, done?: string): Promise<T | undefined> {
  try {
    const value = await work();
    if (done) store.notify(done);
    return value;
  } catch (err) {
    store.notify((err as Error).message, "error");
    return undefined;
  }
}

/** Hash routes: `#/`, `#/new`, `#/runs/<id>`, `#/projects/<slug>`. */
export type Route = { page: "home" } | { page: "new"; project?: string } | { page: "run"; runId: string } | { page: "project"; slug: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "runs" && parts[1]) return { page: "run", runId: parts[1] };
  if (parts[0] === "projects" && parts[1]) return { page: "project", slug: parts[1] };
  if (parts[0] === "new") return parts[1] ? { page: "new", project: parts[1] } : { page: "new" };
  return { page: "home" };
}

export const href = {
  home: "#/",
  newRun: (project?: string) => (project ? `#/new/${encodeURIComponent(project)}` : "#/new"),
  run: (runId: string) => `#/runs/${encodeURIComponent(runId)}`,
  project: (slug: string) => `#/projects/${encodeURIComponent(slug)}`,
};

const subscribeHash = (fn: () => void) => {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return parseRoute(hash);
}
