import { resolve } from "node:path";
import { LeaseHeldError, type RunHead, type RunOutcome, type RunStore } from "@harness/harness";
import { RunMirror, type BlobStore } from "@harness/web";
import { blobsFor, TextRelay } from "./blobs.ts";
import { handOver, uploadsFor } from "./handover.ts";
import { driveRun, type DriveHooks, type HostIo } from "./host.ts";

/**
 * `harness worker`: drives whatever the store says is waiting. A run is waiting when its status is `created`
 * or `running` and no worker holds a live lease on it, which covers a run just created, one whose review was
 * answered or that was asked to resume, and one whose last worker died. The creator's side (`harness web
 * --remote`, or the terminal commands) only writes to the store; this loop is what moves runs.
 *
 * It lists runs on a timer and also when the store pushes a change (Postgres `LISTEN`). The lease decides who
 * drives a run, so several workers, or a worker and a terminal, never drive the same one.
 */

export type WorkerOptions = {
  store: RunStore;
  /** Drives one run until it finishes, pauses or waits for a review. */
  drive: (runId: string, signal: AbortSignal) => Promise<RunOutcome>;
  /** Puts on disk what the creator handed the run, before it is driven. Returns sentences for the output. */
  prepare?: (runId: string) => Promise<string[]>;
  /** Runs driven at once. Each reel holds a sandbox of four CPUs while it is driven. */
  concurrency?: number;
  pollMs?: number;
  line: (text: string) => void;
  now?: () => number;
};

const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;

export class Worker {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  /** Runs that failed to start, and when to try each again. */
  private readonly retry = new Map<string, { at: number; failures: number }>();
  private timer: NodeJS.Timeout | undefined;
  private unwatch: Promise<(() => Promise<void>) | undefined> | undefined;
  private scanning: Promise<void> | undefined;
  private stopped = false;
  private readonly concurrency: number;
  private readonly now: () => number;

  constructor(private readonly options: WorkerOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    this.timer = setInterval(() => void this.scan(), this.options.pollMs ?? 5_000);
    const { store } = this.options;
    // Pushed changes are a shortcut; the timer finds the same runs a few seconds later.
    this.unwatch = store.watch ? store.watch(() => void this.scan()).catch(() => undefined) : undefined;
    void this.scan();
  }

  /** Looks for waiting runs and starts as many as there is room for. */
  scan(): Promise<void> {
    this.scanning ??= this.pick().finally(() => (this.scanning = undefined));
    return this.scanning;
  }

  private async pick(): Promise<void> {
    if (this.stopped || this.active.size >= this.concurrency) return;
    let heads: RunHead[];
    try {
      heads = await this.options.store.listRuns();
    } catch {
      // The store is out of reach (the desktop is offline, a database restart). Look again next time.
      return;
    }
    const now = this.now();
    for (const head of heads) {
      if (this.stopped || this.active.size >= this.concurrency) break;
      if (head.status !== "created" && head.status !== "running") continue;
      if (head.leaseOwner || this.active.has(head.runId)) continue;
      if ((this.retry.get(head.runId)?.at ?? 0) > now) continue;
      this.launch(head.runId);
    }
  }

  private launch(runId: string): void {
    const { line } = this.options;
    const controller = new AbortController();
    const done = (async () => {
      try {
        for (const text of (await this.options.prepare?.(runId)) ?? []) line(`${runId}: ${text}`);
        line(`${runId}: working on it.`);
        const outcome = await this.options.drive(runId, controller.signal);
        this.retry.delete(runId);
        line(`${runId}: ${outcome.status.replace("_", " ")}${outcome.reason ? ` (${outcome.reason})` : ""}.`);
      } catch (err) {
        // Another worker, or a terminal, took the run between the listing and the lease. It is in hand.
        if (err instanceof LeaseHeldError) return;
        const failures = (this.retry.get(runId)?.failures ?? 0) + 1;
        const wait = Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS);
        this.retry.set(runId, { at: this.now() + wait, failures });
        line(`${runId}: could not run it: ${(err as Error).message} Trying again in ${Math.round(wait / 1000)} seconds.`);
      } finally {
        this.active.delete(runId);
        if (!this.stopped) void this.scan();
      }
    })();
    this.active.set(runId, { controller, done });
  }

  /** Runs being driven now. */
  driving(): string[] {
    return [...this.active.keys()];
  }

  /** Waits until nothing is being driven. For tests. */
  async idle(): Promise<void> {
    while (this.scanning || this.active.size) {
      await this.scanning;
      await Promise.allSettled([...this.active.values()].map((a) => a.done));
    }
  }

  /** Stops picking runs up, and stops each run being driven after its current step. They resume on the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await (await this.unwatch)?.().catch(() => undefined);
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }
}

/**
 * Drives a run so a web server on another machine can follow it: model text goes out through the store as it
 * is typed, and the run's files go to blob storage as it makes them, with everything up before the drive
 * returns, so a review shows the draft it is about. Neither can fail a run; a failure is said once and tried
 * again with the next change.
 */
export function sharedDrive(options: {
  store: RunStore;
  blobs?: BlobStore;
  line: (text: string) => void;
  drive: (runId: string, hooks: DriveHooks & { signal: AbortSignal }) => Promise<RunOutcome>;
  mirrorDelayMs?: number;
}): { drive: (runId: string, signal: AbortSignal) => Promise<RunOutcome>; idle: () => Promise<void> } {
  const { store, blobs, line } = options;
  let failing = false;
  const said = (runId: string, err: unknown) => {
    if (failing) return;
    failing = true;
    line(`${runId}: could not copy its files to blob storage: ${(err as Error).message} Trying again with the next change.`);
  };
  const mirror = blobs ? new RunMirror(blobs, (runId) => store.runDir(runId), { delayMs: options.mirrorDelayMs ?? 1_000, onError: said }) : undefined;
  const relay = new TextRelay(store);
  return {
    async drive(runId, signal) {
      try {
        return await options.drive(runId, {
          signal,
          ...(mirror ? { onEvent: () => mirror.soon(runId) } : {}),
          ...(store.publishText ? { onText: (delta: string) => relay.push(runId, delta) } : {}),
        });
      } finally {
        await relay.flush();
        await mirror?.now(runId).then(
          () => void (failing = false),
          (err) => said(runId, err),
        );
      }
    },
    idle: async () => {
      await relay.flush();
      await mirror?.idle();
    },
  };
}

/** The `harness worker` command: drives waiting runs until Ctrl-C. */
export async function runWorker(options: {
  store: RunStore;
  io: HostIo & { cwd: string; signal?: AbortSignal };
  concurrency: number;
  line: (text: string) => void;
  pollMs?: number;
}): Promise<number> {
  const { store, io, line } = options;
  const blobs = blobsFor(io.env, io.cwd, io.fetch);
  const uploads = uploadsFor(store, blobs);
  const projectsDir = resolve(io.cwd, io.env.HARNESS_PROJECTS_DIR ?? "projects");
  const shared = sharedDrive({ store, ...(blobs ? { blobs } : {}), line, drive: (runId, hooks) => driveRun(store, runId, io, hooks) });
  const worker = new Worker({
    store,
    concurrency: options.concurrency,
    ...(options.pollMs ? { pollMs: options.pollMs } : {}),
    line,
    prepare: (runId) => handOver(store, runId, { uploads, projectsDir }),
    drive: shared.drive,
  });
  worker.start();
  line(`Working on runs from the store, ${options.concurrency} at a time. Ctrl-C stops after each run's current step.`);
  if (blobs) line("Copying run files to blob storage for the web page.");
  else line("Run files stay on this machine: set HARNESS_BLOB_URL to show them on a web page elsewhere.");
  await new Promise<void>((done) => {
    if (!io.signal || io.signal.aborted) return done();
    io.signal.addEventListener("abort", () => done(), { once: true });
  });
  const stopping = worker.driving();
  if (stopping.length) line(`Stopping ${stopping.length} run${stopping.length === 1 ? "" : "s"} after the current step.`);
  await worker.stop();
  await shared.idle();
  line("Stopped the worker.");
  return 0;
}
