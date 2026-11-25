import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessEvent, NewEvent } from "./envelope.ts";
import { reduce, type RunState } from "./reducer.ts";
import {
  HeadMovedError, LEASE_MS, LeaseHeldError, LogIndex, RunNotFoundError, StaleEpochError, stamp, type RunHead, type RunStore,
} from "./store.ts";

type LeaseFile = { owner: string; epoch: number; expiresAt: number };

/** How long a writer waits for another one to finish before giving up. */
const LOCK_WAIT_MS = 15_000;
/**
 * A lock older than this was left by a process that died while holding it. Every locked section is a few file
 * reads and one append, so a live holder never keeps it this long.
 */
const LOCK_STALE_MS = 30_000;

export class StoreLockedError extends Error {
  constructor(public readonly runId: string) {
    super(`Run ${runId} is locked by another writer that has not let go.`);
    this.name = "StoreLockedError";
  }
}

/** What has been read of one run's log, so the next read only parses what was added since. */
type Cached = { events: HarnessEvent[]; validBytes: number; index: LogIndex; state?: RunState };

/**
 * One JSON-lines file per run on local disk: `<root>/<run-id>/events.jsonl`. Same envelope and rules as the
 * database store, for local runs without a server and for recorded runs that are shared as a folder.
 *
 * Several processes may write the same run: the worker driving it, and the creator's commands (a cancel, a gate
 * decision) from another terminal. Every check-then-write runs under a lock file, `lock`, created exclusively, so
 * two writers can never both pass the head check and write the same `seq`. The lease file says which worker
 * drives the run; the lock only makes each write atomic.
 */
export class JsonlEventStore implements RunStore {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly root: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  runDir(runId: string): string {
    return join(this.root, runId);
  }
  private logPath(runId: string): string {
    return join(this.runDir(runId), "events.jsonl");
  }
  private leasePath(runId: string): string {
    return join(this.runDir(runId), "lease.json");
  }
  private lockPath(runId: string): string {
    return join(this.runDir(runId), "lock");
  }

  async createRun(runId: string, events: NewEvent[]): Promise<HarnessEvent[]> {
    new LogIndex().check(events);
    await mkdir(this.runDir(runId), { recursive: true });
    return this.locked(runId, async () => {
      if (existsSync(this.logPath(runId))) throw new Error(`Run ${runId} already exists.`);
      const stored = stamp(runId, 1, events);
      await this.write(runId, stored);
      return stored;
    });
  }

  async append(runId: string, expectedLastSeq: number, events: NewEvent[], epoch?: number): Promise<HarnessEvent[]> {
    if (!existsSync(this.logPath(runId))) throw new RunNotFoundError(runId);
    return this.locked(runId, async () => {
      // A worker that lost the run must not touch the file at all, not even to tidy it.
      if (epoch !== undefined) {
        const lease = await this.readLease(runId);
        if (!lease || lease.epoch !== epoch) throw new StaleEpochError(runId);
      }
      const { events: existing, index, torn, validBytes } = await this.load(runId);
      if (existing.length !== expectedLastSeq) throw new HeadMovedError(runId, expectedLastSeq, existing.length);
      index.check(events);
      // Clear a half-written line before writing after it, or the next event would be glued onto the fragment.
      if (torn) await truncate(this.logPath(runId), validBytes);
      const stored = stamp(runId, expectedLastSeq + 1, events);
      await this.write(runId, stored);
      if (epoch !== undefined) await this.extendLease(runId, epoch);
      return stored;
    });
  }

  async read(runId: string, afterSeq = 0): Promise<HarnessEvent[]> {
    return (await this.load(runId)).events.slice(afterSeq);
  }

  /**
   * The run's events, parsing only what was added since the last read. A log only ever grows, apart from a
   * half-written last line that a later writer clears, so what was parsed before stays valid.
   */
  private async load(runId: string): Promise<Cached & { torn: boolean }> {
    const path = this.logPath(runId);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new RunNotFoundError(runId);
    }
    let cached = this.cache.get(runId);
    if (!cached || size < cached.validBytes) cached = { events: [], validBytes: 0, index: new LogIndex() };
    if (size > cached.validBytes) {
      const handle = await open(path, "r");
      let data: Buffer;
      try {
        data = Buffer.alloc(size - cached.validBytes);
        await handle.read(data, 0, data.length, cached.validBytes);
      } finally {
        await handle.close();
      }
      // Every complete line ends in a newline, so anything after the last newline is the half-written line a
      // crash left behind. Leave it, and read it again next time in case it was a write still in progress.
      const complete = data.lastIndexOf(0x0a) + 1;
      const added: HarnessEvent[] = [];
      for (const line of data.subarray(0, complete).toString("utf8").split("\n")) {
        if (line) added.push(JSON.parse(line) as HarnessEvent);
      }
      added.forEach((e, i) => {
        const expected = cached!.events.length + i + 1;
        if (e.seq !== expected) throw new Error(`Run ${runId} has a gap in its log at seq ${expected}.`);
      });
      cached.index.add(added);
      const state = added.reduce<RunState | undefined>((s, e) => reduce(s, e), cached.state);
      cached = { events: [...cached.events, ...added], validBytes: cached.validBytes + complete, index: cached.index, ...(state ? { state } : {}) };
      this.cache.set(runId, cached);
    }
    return { ...cached, torn: size > cached.validBytes };
  }

  async acquireLease(runId: string, worker: string): Promise<{ epoch: number; lastSeq: number }> {
    return this.locked(runId, async () => {
      const events = await this.read(runId);
      const current = await this.readLease(runId);
      if (current && current.expiresAt > this.now() && current.owner !== "") throw new LeaseHeldError(runId, current.owner);
      const epoch = (current?.epoch ?? 0) + 1;
      await this.writeLease(runId, { owner: worker, epoch, expiresAt: this.now() + LEASE_MS });
      return { epoch, lastSeq: events.length };
    });
  }

  async releaseLease(runId: string, worker: string, epoch: number): Promise<void> {
    await this.locked(runId, async () => {
      const current = await this.readLease(runId);
      if (current?.owner !== worker || current.epoch !== epoch) return;
      // Keep the epoch so the next worker's is higher; clear the owner.
      await this.writeLease(runId, { owner: "", epoch, expiresAt: 0 });
    });
  }

  async renewLease(runId: string, worker: string, epoch: number): Promise<void> {
    await this.locked(runId, async () => {
      const current = await this.readLease(runId);
      if (current?.owner === worker) await this.extendLease(runId, epoch);
    });
  }

  async leaseHeld(runId: string): Promise<boolean> {
    if (!existsSync(this.logPath(runId))) throw new RunNotFoundError(runId);
    const current = await this.readLease(runId);
    return Boolean(current && current.owner !== "" && current.expiresAt > this.now());
  }

  /**
   * One folder per run under the root. Each log is parsed only past what was read before, so a run that has not
   * changed costs a `stat` and a read of its lease. A log that cannot be read is left out.
   */
  async listRuns(): Promise<RunHead[]> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const heads: RunHead[] = [];
    for (const runId of names) {
      let loaded: Cached;
      try {
        loaded = await this.load(runId);
      } catch {
        continue;
      }
      const lastSeq = loaded.events.length;
      if (!lastSeq || !loaded.state) continue;
      const lease = await this.readLease(runId);
      heads.push({ runId, lastSeq, status: loaded.state.status, ...(lease && lease.owner !== "" && lease.expiresAt > this.now() ? { leaseOwner: lease.owner } : {}) });
    }
    return heads;
  }

  /** Removes a run and everything in its folder. */
  async deleteRun(runId: string): Promise<void> {
    this.cache.delete(runId);
    await rm(this.runDir(runId), { recursive: true, force: true });
  }

  private async readLease(runId: string): Promise<LeaseFile | null> {
    try {
      return JSON.parse(await readFile(this.leasePath(runId), "utf8")) as LeaseFile;
    } catch {
      return null;
    }
  }

  private async writeLease(runId: string, lease: LeaseFile): Promise<void> {
    await writeFile(this.leasePath(runId), JSON.stringify(lease));
  }

  /** Called with the lock held. */
  private async extendLease(runId: string, epoch: number): Promise<void> {
    const current = await this.readLease(runId);
    if (current && current.epoch === epoch && current.owner !== "") {
      await this.writeLease(runId, { ...current, expiresAt: this.now() + LEASE_MS });
    }
  }

  /**
   * Runs `work` while holding the run's lock file. The file is created with `wx`, which fails if it exists, so
   * only one process at a time gets past this point. A lock older than `LOCK_STALE_MS` belonged to a process
   * that died holding it, and is taken over.
   */
  private async locked<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const path = this.lockPath(runId);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
      try {
        const handle = await open(path, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
        await handle.close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new RunNotFoundError(runId);
        // On Windows a lock file that is being deleted answers EPERM rather than EEXIST: busy either way.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw err;
        const age = await stat(path).then((info) => Date.now() - info.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) {
          await rm(path, { force: true });
          continue;
        }
        if (Date.now() > deadline) throw new StoreLockedError(runId);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    try {
      return await work();
    } finally {
      await rm(path, { force: true });
    }
  }

  private async write(runId: string, events: HarnessEvent[]): Promise<void> {
    const handle = await open(this.logPath(runId), "a");
    try {
      await handle.appendFile(events.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
      // The durability barrier: an awaited append has reached the disk.
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }
}
