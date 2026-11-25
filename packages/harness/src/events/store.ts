import { isSpanClose, isSpanOpen, validateNewEvent, type HarnessEvent, type NewEvent } from "./envelope.ts";
import { foldRun, type RunStatus } from "./reducer.ts";

/**
 * Where events live. The contract is the one in docs/plans/event-log-and-run-state.md: a gapless per-run `seq`,
 * appends that name the head they expect, one worker per run through a lease, and readers that page by cursor.
 * The Postgres store implements this against `harness.events`; the stores in this package are for tests and
 * for local runs without a database.
 */
export interface EventStore {
  /** Creates a run with its first batch (`run.created`). Fails if the run exists. */
  createRun(runId: string, events: NewEvent[]): Promise<HarnessEvent[]>;
  /**
   * Appends a batch after `expectedLastSeq`. Throws `HeadMovedError` when another writer got there first, and
   * `StaleEpochError` when `epoch` is given and is no longer the current one. An awaited append is durable.
   */
  append(runId: string, expectedLastSeq: number, events: NewEvent[], epoch?: number): Promise<HarnessEvent[]>;
  /** Events after `afterSeq`, in order. */
  read(runId: string, afterSeq?: number): Promise<HarnessEvent[]>;
  /** Takes the right to drive a run. Throws `LeaseHeldError` while another worker holds a live lease. */
  acquireLease(runId: string, worker: string): Promise<{ epoch: number; lastSeq: number }>;
  /** Keeps a held lease alive. The worker calls this on a timer, so a long tool call does not lose the run. */
  renewLease(runId: string, worker: string, epoch: number): Promise<void>;
  releaseLease(runId: string, worker: string, epoch: number): Promise<void>;
  /**
   * Whether a worker holds a live lease on the run. A run whose status is `running` with no live lease has lost
   * its worker (a crash), and nothing will move it until someone runs it again.
   */
  leaseHeld(runId: string): Promise<boolean>;
}

/** One run as a list sees it: enough to tell whether it changed, without reading its log. */
export type RunHead = {
  runId: string;
  lastSeq: number;
  /** Where the run is. `created` and `running` with no `leaseOwner` mean it is waiting for a worker. */
  status: RunStatus;
  /** The worker holding a live lease, if any. */
  leaseOwner?: string;
};

/**
 * What a front end that follows many runs needs from a store, so it never looks behind the store at files or
 * tables. Each run also keeps its own files (working directory, renders, uploads) on this machine, under
 * `runDir`, whichever store holds its log.
 */
export interface RunDirectory {
  /** Every run, with its head. One cheap call, made about once a second. */
  listRuns(): Promise<RunHead[]>;
  runDir(runId: string): string;
  /**
   * Calls `onChange` soon after a run gains events, from any process. Optional: without it, or if it fails, a
   * front end finds changes with `listRuns`. Returns a function that stops listening.
   */
  watch?(onChange: (runId: string) => void): Promise<() => Promise<void>>;
  /**
   * Passes model text as it is typed to every process following the store (Postgres `NOTIFY`), for a front
   * end on another machine than the worker. Never part of the log: a delta nobody hears is gone, and the
   * finished text arrives with its event as always. Optional, and best effort.
   */
  publishText?(runId: string, delta: string): Promise<void>;
  /** Hears what `publishText` sends, from any process. Returns a function that stops listening. */
  watchText?(onText: (runId: string, delta: string) => void): Promise<() => Promise<void>>;
}

/** A store a front end can drive and follow runs through: the JSON-lines store or the Postgres one. */
export type RunStore = EventStore & RunDirectory;

export class HeadMovedError extends Error {
  constructor(public readonly runId: string, public readonly expected: number, public readonly actual: number) {
    super(`Run ${runId} is at seq ${actual}, not ${expected}.`);
    this.name = "HeadMovedError";
  }
}
export class StaleEpochError extends Error {
  constructor(public readonly runId: string) {
    super(`Another worker has taken over run ${runId}.`);
    this.name = "StaleEpochError";
  }
}
export class LeaseHeldError extends Error {
  constructor(public readonly runId: string, public readonly owner: string) {
    super(`Run ${runId} is being driven by ${owner}.`);
    this.name = "LeaseHeldError";
  }
}
export class RunNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`Run ${runId} does not exist.`);
    this.name = "RunNotFoundError";
  }
}

export const LEASE_MS = 60_000;

type Lease = { owner: string; epoch: number; expiresAt: number };

/**
 * The checks every store applies before a batch lands, mirroring the database constraints: valid payloads,
 * unique event ids, and spans that open once and close once.
 */
export class LogIndex {
  private readonly eventIds = new Set<string>();
  private readonly opened = new Set<string>();
  private readonly closed = new Set<string>();

  check(batch: NewEvent[]): void {
    const ids = new Set<string>();
    const opening = new Set<string>();
    const closing = new Set<string>();
    for (const e of batch) {
      validateNewEvent(e);
      if (this.eventIds.has(e.eventId) || ids.has(e.eventId)) throw new Error(`Event id ${e.eventId} was already written.`);
      ids.add(e.eventId);
      if (isSpanOpen(e.type)) {
        if (this.opened.has(e.spanId) || opening.has(e.spanId)) throw new Error(`Span ${e.spanId} is already open (${e.type}).`);
        opening.add(e.spanId);
      } else if (isSpanClose(e.type)) {
        if (this.closed.has(e.spanId) || closing.has(e.spanId)) throw new Error(`Span ${e.spanId} is already closed (${e.type}).`);
        closing.add(e.spanId);
      }
    }
  }

  add(events: readonly NewEvent[]): void {
    for (const e of events) {
      this.eventIds.add(e.eventId);
      if (isSpanOpen(e.type)) this.opened.add(e.spanId);
      else if (isSpanClose(e.type)) this.closed.add(e.spanId);
    }
  }
}

export function stamp(runId: string, firstSeq: number, batch: NewEvent[]): HarnessEvent[] {
  return batch.map((e, i) => ({ ...e, runId, seq: firstSeq + i, schemaVersion: e.schemaVersion ?? 1, untrusted: e.untrusted ?? false }));
}

/** Keeps runs in memory. For tests, and for one-off runs that need no history afterwards. */
export class MemoryEventStore implements EventStore {
  private readonly runs = new Map<string, { events: HarnessEvent[]; index: LogIndex; lease?: Lease; epoch: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async createRun(runId: string, events: NewEvent[]): Promise<HarnessEvent[]> {
    if (this.runs.has(runId)) throw new Error(`Run ${runId} already exists.`);
    const index = new LogIndex();
    index.check(events);
    const stored = structuredClone(stamp(runId, 1, events));
    index.add(stored);
    this.runs.set(runId, { events: stored, index, epoch: 0 });
    return structuredClone(stored);
  }

  async append(runId: string, expectedLastSeq: number, events: NewEvent[], epoch?: number): Promise<HarnessEvent[]> {
    const run = this.run(runId);
    if (epoch !== undefined && epoch !== run.epoch) throw new StaleEpochError(runId);
    if (run.events.length !== expectedLastSeq) throw new HeadMovedError(runId, expectedLastSeq, run.events.length);
    run.index.check(events);
    const stored = structuredClone(stamp(runId, expectedLastSeq + 1, events));
    run.index.add(stored);
    run.events.push(...stored);
    if (epoch !== undefined && run.lease) run.lease.expiresAt = this.now() + LEASE_MS;
    return structuredClone(stored);
  }

  async read(runId: string, afterSeq = 0): Promise<HarnessEvent[]> {
    return structuredClone(this.run(runId).events.slice(afterSeq));
  }

  async acquireLease(runId: string, worker: string): Promise<{ epoch: number; lastSeq: number }> {
    const run = this.run(runId);
    if (run.lease && run.lease.expiresAt > this.now()) throw new LeaseHeldError(runId, run.lease.owner);
    run.epoch += 1;
    run.lease = { owner: worker, epoch: run.epoch, expiresAt: this.now() + LEASE_MS };
    return { epoch: run.epoch, lastSeq: run.events.length };
  }

  async renewLease(runId: string, worker: string, epoch: number): Promise<void> {
    const run = this.run(runId);
    if (run.lease?.owner === worker && run.lease.epoch === epoch) run.lease.expiresAt = this.now() + LEASE_MS;
  }

  async releaseLease(runId: string, worker: string, epoch: number): Promise<void> {
    const run = this.run(runId);
    if (run.lease?.owner === worker && run.lease.epoch === epoch) run.lease = undefined;
  }

  async leaseHeld(runId: string): Promise<boolean> {
    const lease = this.run(runId).lease;
    return Boolean(lease && lease.expiresAt > this.now());
  }

  async listRuns(): Promise<RunHead[]> {
    return [...this.runs].map(([runId, run]) => ({
      runId,
      lastSeq: run.events.length,
      status: foldRun(run.events).status,
      ...(run.lease && run.lease.expiresAt > this.now() ? { leaseOwner: run.lease.owner } : {}),
    }));
  }

  /** Test helper: what a dead worker's lease does on its own after a minute. */
  expireLease(runId: string): void {
    this.run(runId).lease = undefined;
  }

  private run(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new RunNotFoundError(runId);
    return run;
  }
}
