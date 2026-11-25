import { foldRun, LeaseHeldError, reduce, type HarnessEvent, type RunHead, type RunState } from "@harness/harness";
import type { Driver, Frame, RunCard } from "../api/contract.ts";
import type { RunHost } from "./host.ts";

/**
 * Keeps each run's log folded in memory and tells browsers what changed. The log stays the only record, and
 * the hub sees it only through the store: once a second it lists every run's head and reads the events past
 * what it holds, so a run driven from the terminal shows up live the same way as one driven here. A store that
 * can push changes (Postgres `LISTEN`) is followed at once as well. Runs driven here push each event the moment
 * it is written, and model text as it is typed; a worker elsewhere sends its typed text through the store.
 */

type Cached = { events: HarnessEvent[]; state: RunState; card: RunCard };

export type Subscriber = { runId?: string; send: (frame: Frame) => void };

type Payload = Record<string, unknown>;

/** The project a run is filed under: set when it was created, changed later by `x.web.filed`. */
export function projectOf(events: readonly HarnessEvent[]): string | undefined {
  let project = (events[0]?.payload as { brief?: { project?: unknown } } | undefined)?.brief?.project;
  for (const e of events) if (e.type === "x.web.filed") project = (e.payload as Payload).project;
  return typeof project === "string" && project ? project : undefined;
}

function cutsOf(events: readonly HarnessEvent[]): number {
  const renders = new Set<string>();
  for (const e of events) if (e.type === "tool.call.started" && (e.payload as Payload).tool === "render_film") renders.add(e.spanId);
  return events.filter((e) => e.type === "tool.call.completed" && renders.has(e.spanId)).length;
}

export class Hub {
  private readonly cache = new Map<string, Cached>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly drivers = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly driveErrors = new Map<string, string>();
  /** Who holds a live lease on each run, as of the last listing. */
  private readonly leases = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private broadcastSoon: NodeJS.Timeout | undefined;
  private unwatch: Promise<(() => Promise<void>) | undefined> | undefined;
  private unwatchText: Promise<(() => Promise<void>) | undefined> | undefined;

  constructor(private readonly host: RunHost, private readonly pollMs = 1000) {}

  get runsDir(): string {
    return this.host.runsDir;
  }

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
    const { store } = this.host;
    // Pushed changes are a shortcut; if the store cannot push, the listing finds the same changes a moment later.
    this.unwatch = store.watch
      ? store.watch((runId) => void this.refresh(runId).then((changed) => changed && this.scheduleRuns())).catch(() => undefined)
      : undefined;
    // Text typed by a worker elsewhere. A run driven here already sends its own, so it is not sent twice.
    this.unwatchText = store.watchText
      ? store.watchText((runId, delta) => !this.drivers.has(runId) && this.text(runId, delta)).catch(() => undefined)
      : undefined;
  }

  /** Stops watching, and stops every run driven here after its current step. They can be resumed later. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.broadcastSoon) clearTimeout(this.broadcastSoon);
    await (await this.unwatch)?.().catch(() => undefined);
    await (await this.unwatchText)?.().catch(() => undefined);
    for (const { controller } of this.drivers.values()) controller.abort();
    await Promise.race([Promise.allSettled([...this.drivers.values()].map((d) => d.done)), new Promise((r) => setTimeout(r, 15_000).unref?.())]);
  }

  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** Lists every run's head and reads the runs that moved since the last look. */
  poll(): Promise<void> {
    this.polling ??= this.refreshAll().finally(() => (this.polling = undefined));
    return this.polling;
  }

  private async refreshAll(): Promise<void> {
    let heads: RunHead[];
    try {
      heads = await this.host.store.listRuns();
    } catch {
      // The store is out of reach (a database restart, say). Keep what is held and look again next time.
      return;
    }
    this.leases.clear();
    for (const head of heads) if (head.leaseOwner) this.leases.set(head.runId, head.leaseOwner);
    let changed = false;
    for (const head of heads) {
      if (await this.refresh(head.runId, head.lastSeq)) changed = true;
    }
    // A driver held elsewhere can start or stop without the log changing; recheck leases for the list.
    for (const [runId, cached] of this.cache) {
      const driver = this.driverOf(runId);
      if (driver !== cached.card.driver) {
        cached.card = { ...cached.card, driver };
        changed = true;
      }
    }
    if (changed) this.broadcastRuns();
  }

  /**
   * Brings one run up to date through the store, reading only the events past those held. `lastSeq` is the
   * head a listing just reported: when it matches what is held, nothing is read. Returns true if anything
   * changed.
   */
  async refresh(runId: string, lastSeq?: number): Promise<boolean> {
    const held = this.cache.get(runId);
    if (held && lastSeq === held.state.lastSeq) return false;
    // A shorter log means the run was replaced; start over.
    const restart = !held || (lastSeq !== undefined && lastSeq < held.state.lastSeq);
    let read: HarnessEvent[];
    try {
      read = await this.host.store.read(runId, restart ? 0 : held.state.lastSeq);
    } catch {
      return false;
    }
    if (restart) {
      if (!read.length) return false;
      const state = foldRun(read);
      this.cache.set(runId, { events: read, state, card: this.cardFor(runId, read, state) });
      this.sendEvents(runId, read, state);
      return true;
    }
    // Events driven here can arrive through `ingest` while the store is read; take only what is still new.
    const cached = this.cache.get(runId)!;
    const fresh = read.filter((e) => e.seq > cached.state.lastSeq);
    if (!fresh.length) return false;
    cached.events.push(...fresh);
    cached.state = fresh.reduce<RunState>((s, e) => reduce(s, e), cached.state);
    cached.card = this.cardFor(runId, cached.events, cached.state);
    this.sendEvents(runId, fresh, cached.state);
    return true;
  }

  /** Takes events the engine just wrote here, without waiting for the next look at the file. */
  ingest(runId: string, event: HarnessEvent): void {
    const cached = this.cache.get(runId);
    if (!cached || event.seq !== cached.state.lastSeq + 1) {
      void this.refresh(runId).then((changed) => changed && this.scheduleRuns());
      return;
    }
    cached.events.push(event);
    cached.state = reduce(cached.state, event);
    this.sendEvents(runId, [event], cached.state);
    this.scheduleRuns();
  }

  text(runId: string, delta: string): void {
    for (const sub of this.subscribers) if (sub.runId === runId) sub.send({ type: "text", runId, delta });
  }

  private sendEvents(runId: string, events: HarnessEvent[], state: RunState): void {
    for (const sub of this.subscribers) if (sub.runId === runId) sub.send({ type: "events", runId, events, state });
  }

  private scheduleRuns(): void {
    if (this.broadcastSoon) return;
    this.broadcastSoon = setTimeout(() => {
      this.broadcastSoon = undefined;
      this.updateCards();
      this.broadcastRuns();
    }, 200);
  }

  private updateCards(): void {
    for (const [runId, cached] of this.cache) cached.card = this.cardFor(runId, cached.events, cached.state);
  }

  broadcastRuns(): void {
    const runs = this.cards();
    for (const sub of this.subscribers) sub.send({ type: "runs", runs });
  }

  broadcast(frame: Frame): void {
    for (const sub of this.subscribers) sub.send(frame);
  }

  cards(): RunCard[] {
    return [...this.cache.values()].map((c) => c.card).sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt));
  }

  async get(runId: string): Promise<Cached | undefined> {
    await this.refresh(runId);
    const cached = this.cache.get(runId);
    if (cached) cached.card = this.cardFor(runId, cached.events, cached.state);
    return cached;
  }

  private cardFor(runId: string, events: HarnessEvent[], state: RunState): RunCard {
    const project = projectOf(events);
    const error = this.driveErrors.get(runId);
    return {
      runId,
      title: state.title,
      status: state.status,
      ...(state.statusReason ? { statusReason: state.statusReason } : {}),
      ...(state.pendingGate ? { pendingGate: state.pendingGate } : {}),
      ...(state.stage ? { stage: { name: state.stage.name, revision: state.stage.revision } } : {}),
      ...(project ? { project } : {}),
      ...(state.config.pipeline ? { pipeline: state.config.pipeline } : {}),
      model: state.config.model,
      costMicroUsd: state.costMicroUsd,
      tokens: state.tokensIn + state.tokensOut,
      activeMs: state.activeMs,
      createdAt: events[0]!.occurredAt,
      lastEventAt: state.lastEventAt,
      events: events.length,
      cuts: cutsOf(events),
      driver: this.driverOf(runId),
      ...(error ? { driveError: error } : {}),
    };
  }

  private driverOf(runId: string): Driver {
    if (this.drivers.has(runId)) return "here";
    return this.leases.has(runId) ? "elsewhere" : "none";
  }

  isDriving(runId: string): boolean {
    return this.drivers.has(runId);
  }

  /**
   * Drives a run in the background, here. Returns at once. Does nothing if this server already drives it, or
   * if it drives nothing (a worker elsewhere picks the run up from the store).
   * Why a drive could not start (no key, held elsewhere) is kept for the run's card until the next attempt.
   */
  drive(runId: string): void {
    const drive = this.host.drive?.bind(this.host);
    if (!drive || this.drivers.has(runId)) return;
    this.driveErrors.delete(runId);
    const controller = new AbortController();
    const done = (async () => {
      try {
        await drive(runId, {
          signal: controller.signal,
          onEvent: (event) => this.ingest(runId, event),
          onText: (delta) => this.text(runId, delta),
        });
      } catch (err) {
        this.driveErrors.set(
          runId,
          err instanceof LeaseHeldError
            ? "This run is being worked on somewhere else, probably in a terminal. It shows here live; answer it there or wait for it to stop."
            : this.host.isUserError?.(err)
              ? (err as Error).message
              : `The run stopped with an error: ${(err as Error).message}`,
        );
      } finally {
        this.drivers.delete(runId);
        // This server's own lease is gone now; a listing already under way may have seen it, so list again.
        await this.polling?.catch(() => undefined);
        await this.poll();
        await this.refresh(runId);
        this.updateCards();
        this.broadcastRuns();
      }
    })();
    this.drivers.set(runId, { controller, done });
    this.scheduleRuns();
  }

  /** Stops driving a run here at once. The engine records it as paused, so it can be resumed. */
  stopDriving(runId: string): boolean {
    const driver = this.drivers.get(runId);
    if (!driver) return false;
    driver.controller.abort();
    return true;
  }

  /** Waits until this server is no longer driving the run. For tests. */
  async settled(runId: string): Promise<void> {
    await this.drivers.get(runId)?.done;
  }
}
