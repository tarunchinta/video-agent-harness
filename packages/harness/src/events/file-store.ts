import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessEvent, NewEvent } from "./envelope.ts";
import { HeadMovedError, LEASE_MS, LeaseHeldError, LogIndex, RunNotFoundError, StaleEpochError, stamp, type EventStore } from "./store.ts";

type LeaseFile = { owner: string; epoch: number; expiresAt: number };

/**
 * One JSON-lines file per run on local disk: `<root>/<run-id>/events.jsonl`. Same envelope and rules as the
 * database store, for local runs without a server and for recorded runs that are shared as a folder.
 * One process writes a run at a time; the lease file is what says who.
 */
export class JsonlEventStore implements EventStore {
  constructor(private readonly root: string, private readonly now: () => number = () => Date.now()) {}

  runDir(runId: string): string {
    return join(this.root, runId);
  }
  private logPath(runId: string): string {
    return join(this.runDir(runId), "events.jsonl");
  }
  private leasePath(runId: string): string {
    return join(this.runDir(runId), "lease.json");
  }

  async createRun(runId: string, events: NewEvent[]): Promise<HarnessEvent[]> {
    if (existsSync(this.logPath(runId))) throw new Error(`Run ${runId} already exists.`);
    new LogIndex().check(events);
    await mkdir(this.runDir(runId), { recursive: true });
    const stored = stamp(runId, 1, events);
    await this.write(runId, stored);
    return stored;
  }

  async append(runId: string, expectedLastSeq: number, events: NewEvent[], epoch?: number): Promise<HarnessEvent[]> {
    const { events: existing, validBytes, torn } = await this.load(runId);
    // Clear a half-written line before writing after it, or the next event would be glued onto the fragment.
    if (torn) await truncate(this.logPath(runId), validBytes);
    if (epoch !== undefined) {
      const lease = await this.readLease(runId);
      if (!lease || lease.epoch !== epoch) throw new StaleEpochError(runId);
    }
    if (existing.length !== expectedLastSeq) throw new HeadMovedError(runId, expectedLastSeq, existing.length);
    const index = new LogIndex();
    index.add(existing);
    index.check(events);
    const stored = stamp(runId, expectedLastSeq + 1, events);
    await this.write(runId, stored);
    if (epoch !== undefined) await this.extendLease(runId, epoch);
    return stored;
  }

  async read(runId: string, afterSeq = 0): Promise<HarnessEvent[]> {
    return (await this.load(runId)).events.slice(afterSeq);
  }

  private async load(runId: string): Promise<{ events: HarnessEvent[]; validBytes: number; torn: boolean }> {
    let data: Buffer;
    try {
      data = await readFile(this.logPath(runId));
    } catch {
      throw new RunNotFoundError(runId);
    }
    // Every complete line ends in a newline, so anything after the last newline is the half-written line a
    // crash left behind. Drop it, and nothing else.
    const validBytes = data.lastIndexOf(0x0a) + 1;
    const events: HarnessEvent[] = [];
    for (const line of data.subarray(0, validBytes).toString("utf8").split("\n")) {
      if (line) events.push(JSON.parse(line) as HarnessEvent);
    }
    events.forEach((e, i) => {
      if (e.seq !== i + 1) throw new Error(`Run ${runId} has a gap in its log at seq ${i + 1}.`);
    });
    return { events, validBytes, torn: validBytes < data.length };
  }

  async acquireLease(runId: string, worker: string): Promise<{ epoch: number; lastSeq: number }> {
    const events = await this.read(runId);
    const current = await this.readLease(runId);
    if (current && current.expiresAt > this.now() && current.owner !== "") throw new LeaseHeldError(runId, current.owner);
    const epoch = (current?.epoch ?? 0) + 1;
    await writeFile(this.leasePath(runId), JSON.stringify({ owner: worker, epoch, expiresAt: this.now() + LEASE_MS } satisfies LeaseFile));
    return { epoch, lastSeq: events.length };
  }

  async releaseLease(runId: string, worker: string, epoch: number): Promise<void> {
    const current = await this.readLease(runId);
    if (current?.owner !== worker || current.epoch !== epoch) return;
    // Keep the epoch so the next worker's is higher; clear the owner.
    await writeFile(this.leasePath(runId), JSON.stringify({ owner: "", epoch, expiresAt: 0 } satisfies LeaseFile));
  }

  /** Removes a run and everything in its folder. */
  async deleteRun(runId: string): Promise<void> {
    await rm(this.runDir(runId), { recursive: true, force: true });
  }

  private async readLease(runId: string): Promise<LeaseFile | null> {
    try {
      return JSON.parse(await readFile(this.leasePath(runId), "utf8")) as LeaseFile;
    } catch {
      return null;
    }
  }

  async renewLease(runId: string, worker: string, epoch: number): Promise<void> {
    const current = await this.readLease(runId);
    if (current?.owner === worker) await this.extendLease(runId, epoch);
  }

  private async extendLease(runId: string, epoch: number): Promise<void> {
    const current = await this.readLease(runId);
    if (current && current.epoch === epoch && current.owner !== "") {
      await writeFile(this.leasePath(runId), JSON.stringify({ ...current, expiresAt: this.now() + LEASE_MS }));
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
