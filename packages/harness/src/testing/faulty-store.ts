import type { HarnessEvent, NewEvent } from "../events/envelope.ts";
import type { EventStore } from "../events/store.ts";

/**
 * A store that dies after a set number of appends, the way a process does when it is killed: the append that
 * hits the limit never lands, and every call after it fails too. Used to prove a run survives a crash at any
 * point.
 */
export class FaultyStore implements EventStore {
  private appends = 0;
  dead = false;

  constructor(private readonly inner: EventStore, private readonly dieAfterAppends: number) {}

  private check(): void {
    if (this.dead) throw new Error("The process is gone.");
  }

  createRun(runId: string, events: NewEvent[]): Promise<HarnessEvent[]> {
    this.check();
    return this.inner.createRun(runId, events);
  }

  async append(runId: string, expectedLastSeq: number, events: NewEvent[], epoch?: number): Promise<HarnessEvent[]> {
    this.check();
    if (this.appends >= this.dieAfterAppends) {
      this.dead = true;
      throw new Error("The process is gone.");
    }
    this.appends += 1;
    return this.inner.append(runId, expectedLastSeq, events, epoch);
  }

  read(runId: string, afterSeq?: number): Promise<HarnessEvent[]> {
    this.check();
    return this.inner.read(runId, afterSeq);
  }

  acquireLease(runId: string, worker: string) {
    this.check();
    return this.inner.acquireLease(runId, worker);
  }

  async renewLease(runId: string, worker: string, epoch: number): Promise<void> {
    this.check();
    return this.inner.renewLease(runId, worker, epoch);
  }

  async releaseLease(runId: string, worker: string, epoch: number): Promise<void> {
    this.check();
    return this.inner.releaseLease(runId, worker, epoch);
  }
}
