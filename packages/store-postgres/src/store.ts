import { join } from "node:path";
import postgres, { type Sql, type TransactionSql } from "postgres";
import {
  foldRun, HeadMovedError, LEASE_MS, LeaseHeldError, LogIndex, reduce, RunNotFoundError, StaleEpochError,
  type HarnessEvent, type NewEvent, type RunHead, type RunState, type RunStatus, type RunStore,
} from "@harness/harness";

/**
 * The event log in Postgres, as docs/plans/event-log-and-run-state.md describes it: `harness.events` is the log
 * and the only source of truth, `harness.runs` holds a projection of it plus the worker lease, and both change
 * in the same transaction. The loop sees only the `EventStore` interface, with the same rules the file store
 * keeps: a gapless per-run `seq`, appends that name the head they expect, and a lease with an epoch.
 *
 * Every append locks the run's row first (`SELECT … FOR UPDATE`), so a second writer waits and then finds the
 * head has moved. Sequence numbers are therefore gapless and in commit order, and a reader paging forward by
 * `seq` never misses a late one.
 *
 * Runs still keep their files (the working directory, pictures, renders) on local disk, under `runsDir`.
 */

/** The channel model text goes out on while it is typed. */
export const TEXT_CHANNEL = "harness_text";
/** Room for the run id and its colon within NOTIFY's 8000 bytes. */
const TEXT_NOTIFY_BYTES = 7_000;

/** Splits text into pieces of at most `limit` UTF-8 bytes, never inside a character. */
export function splitUtf8(text: string, limit: number): string[] {
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit && part) {
      parts.push(part);
      part = "";
      bytes = 0;
    }
    part += char;
    bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}

export type PostgresEventStoreOptions = {
  /** A postgres.js client. The store does not close it unless it made it (see `connect`). */
  sql: Sql;
  /** Where each run's files live on this machine. */
  runsDir: string;
};

type Row = {
  run_id: string;
  seq: number;
  event_id: string;
  type: string;
  schema_version: number;
  occurred_at: Date;
  actor: HarnessEvent["actor"];
  agent_id: string | null;
  span_id: string;
  parent_span_id: string | null;
  untrusted: boolean;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_micro_usd: number | null;
  payload: Record<string, unknown>;
};

const COLUMNS = `run_id::text, seq::integer, event_id::text, type, schema_version::integer, occurred_at, actor, agent_id,
  span_id::text, parent_span_id::text, untrusted, tokens_in, tokens_out, cost_micro_usd::float8 AS cost_micro_usd, payload`;

function toEvent(row: Row): HarnessEvent {
  return {
    runId: row.run_id,
    seq: row.seq,
    eventId: row.event_id,
    type: row.type,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at.toISOString(),
    actor: row.actor,
    ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
    spanId: row.span_id,
    ...(row.parent_span_id !== null ? { parentSpanId: row.parent_span_id } : {}),
    untrusted: row.untrusted,
    ...(row.tokens_in !== null ? { tokensIn: row.tokens_in } : {}),
    ...(row.tokens_out !== null ? { tokensOut: row.tokens_out } : {}),
    ...(row.cost_micro_usd !== null ? { costMicroUsd: row.cost_micro_usd } : {}),
    payload: row.payload,
  };
}

/** The event as the insert reads it: snake_case keys, the way the plan's writer statement names them. */
const toJson = (e: HarnessEvent) => ({
  ord: e.seq,
  event_id: e.eventId,
  type: e.type,
  schema_version: e.schemaVersion,
  occurred_at: e.occurredAt,
  actor: e.actor,
  agent_id: e.agentId ?? null,
  span_id: e.spanId,
  parent_span_id: e.parentSpanId ?? null,
  untrusted: e.untrusted,
  tokens_in: e.tokensIn ?? null,
  tokens_out: e.tokensOut ?? null,
  cost_micro_usd: e.costMicroUsd ?? null,
  payload: e.payload,
});

const stamp = (runId: string, firstSeq: number, batch: NewEvent[]): HarnessEvent[] =>
  batch.map((e, i) => ({ ...e, runId, seq: firstSeq + i, schemaVersion: e.schemaVersion ?? 1, untrusted: e.untrusted ?? false }));

const STAGES = new Set(["brief", "research", "script", "assets", "edit", "critique", "learn"]);
const GATES = new Set(["script", "final_cut"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** The `runs` columns the reducer owns, from the run's state. */
function projection(state: RunState, lastEventAt: string) {
  return {
    title: state.title,
    status: state.status,
    status_reason: state.statusReason ?? null,
    stage: state.stage && STAGES.has(state.stage.name) ? state.stage.name : null,
    pending_gate: state.pendingGate && GATES.has(state.pendingGate) ? state.pendingGate : null,
    script_revision: state.stageRevisions.script ?? 0,
    cut_revision: state.stageRevisions.edit ?? 0,
    failure: state.failure ? JSON.stringify(state.failure) : null,
    tokens_in: state.tokensIn,
    tokens_out: state.tokensOut,
    cost_micro_usd: state.costMicroUsd,
    active_ms: state.activeMs,
    running_since: state.runningSince ?? null,
    re_edits: state.reEdits,
    max_tokens: state.limits.max_tokens ?? null,
    max_cost_micro_usd: state.limits.max_cost_micro_usd ?? null,
    max_active_ms: state.limits.max_active_ms ?? null,
    max_re_edits: state.limits.max_re_edits ?? null,
    ended_at: TERMINAL.has(state.status) ? lastEventAt : null,
  };
}

export class PostgresEventStore implements RunStore {
  readonly sql: Sql;
  private readonly runsDir: string;
  private readonly owned: boolean;
  /** The run state as of the last append this store made, so the next one folds only its own batch. */
  private readonly states = new Map<string, RunState>();

  constructor(options: PostgresEventStoreOptions, owned = false) {
    this.sql = options.sql;
    this.runsDir = options.runsDir;
    this.owned = owned;
  }

  /** Connects to `url` (for example `DATABASE_URL`). `close` ends the connection. */
  static connect(url: string, runsDir: string, options: { max?: number } = {}): PostgresEventStore {
    // Keep bigint columns as strings unless cast; the queries cast what they read.
    const sql = postgres(url, { max: options.max ?? 5, onnotice: () => {}, idle_timeout: 20 });
    return new PostgresEventStore({ sql, runsDir }, true);
  }

  runDir(runId: string): string {
    return join(this.runsDir, runId);
  }

  async close(): Promise<void> {
    if (this.owned) await this.sql.end({ timeout: 5 });
  }

  async createRun(runId: string, events: NewEvent[]): Promise<HarnessEvent[]> {
    new LogIndex().check(events);
    const stored = stamp(runId, 1, events);
    const state = foldRun(stored);
    const project = projection(state, stored.at(-1)!.occurredAt);
    await this.sql.begin(async (tx) => {
      const exists = await tx`SELECT 1 FROM harness.runs WHERE run_id = ${runId}::uuid`;
      if (exists.length) throw new Error(`Run ${runId} already exists.`);
      const { failure, ...rest } = project;
      const row = {
        run_id: runId,
        last_seq: stored.length,
        started_at: state.runningSince ?? null,
        config: tx.json(state.config as never),
        failure: failure === null ? null : tx.json(JSON.parse(failure) as never),
        ...rest,
      };
      await tx`INSERT INTO harness.runs ${tx(row as Record<string, unknown>)}`;
      await this.insertEvents(tx, runId, stored);
    });
    this.states.set(runId, state);
    return stored;
  }

  async append(runId: string, expectedLastSeq: number, events: NewEvent[], epoch?: number): Promise<HarnessEvent[]> {
    new LogIndex().check(events);
    return this.sql.begin(async (tx) => {
      // The row lock is what orders writers: a second one waits here, then sees the head has moved.
      const [head] = await tx<{ last_seq: number; epoch: number }[]>`
        SELECT last_seq::integer, epoch FROM harness.runs WHERE run_id = ${runId}::uuid FOR UPDATE`;
      if (!head) throw new RunNotFoundError(runId);
      if (epoch !== undefined && head.epoch !== epoch) throw new StaleEpochError(runId);
      if (head.last_seq !== expectedLastSeq) throw new HeadMovedError(runId, expectedLastSeq, head.last_seq);

      let state = this.states.get(runId);
      if (!state || state.lastSeq !== expectedLastSeq) state = foldRun(await this.readIn(tx, runId, 0));
      const stored = stamp(runId, expectedLastSeq + 1, events);
      for (const e of stored) state = reduce(state, e);

      await this.insertEvents(tx, runId, stored);
      const { failure, ...project } = projection(state, stored.at(-1)!.occurredAt);
      await tx`
        UPDATE harness.runs SET ${tx(project as Record<string, unknown>)}, last_seq = ${state.lastSeq},
          failure = ${failure}::text::jsonb,
          started_at = COALESCE(started_at, ${state.runningSince ?? null}::timestamptz), updated_at = now()
        WHERE run_id = ${runId}::uuid`;
      // An append by the worker that holds the lease is a sign of life, like a renewal.
      if (epoch !== undefined) {
        await tx`UPDATE harness.runs SET lease_expires_at = now() + ${`${LEASE_MS / 1000} seconds`}::interval WHERE run_id = ${runId}::uuid AND epoch = ${epoch}`;
      }
      this.states.set(runId, state);
      return stored;
    });
  }

  private async insertEvents(tx: TransactionSql, runId: string, stored: HarnessEvent[]): Promise<void> {
    // The batch goes as one JSON text cast to jsonb, which every driver passes through unchanged (see the
    // plan's driver note on double-encoded jsonb).
    const batch = JSON.stringify(stored.map(toJson));
    await tx`
      INSERT INTO harness.events
        (run_id, seq, event_id, type, schema_version, occurred_at, actor, agent_id,
         span_id, parent_span_id, untrusted, tokens_in, tokens_out, cost_micro_usd, payload)
      SELECT ${runId}::uuid,
             (e->>'ord')::bigint,
             (e->>'event_id')::uuid,
             e->>'type',
             (e->>'schema_version')::smallint,
             (e->>'occurred_at')::timestamptz,
             e->>'actor',
             e->>'agent_id',
             (e->>'span_id')::uuid,
             (e->>'parent_span_id')::uuid,
             (e->>'untrusted')::boolean,
             (e->>'tokens_in')::integer,
             (e->>'tokens_out')::integer,
             (e->>'cost_micro_usd')::bigint,
             e->'payload'
      FROM jsonb_array_elements(${batch}::text::jsonb) AS e`;
  }

  async read(runId: string, afterSeq = 0): Promise<HarnessEvent[]> {
    const events = await this.readIn(this.sql, runId, afterSeq);
    if (!events.length) {
      const [run] = await this.sql`SELECT 1 FROM harness.runs WHERE run_id = ${runId}::uuid`;
      if (!run) throw new RunNotFoundError(runId);
    }
    return events;
  }

  private async readIn(sql: Sql | TransactionSql, runId: string, afterSeq: number): Promise<HarnessEvent[]> {
    const rows = await sql.unsafe<Row[]>(`SELECT ${COLUMNS} FROM harness.events WHERE run_id = $1::uuid AND seq > $2 ORDER BY seq`, [runId, afterSeq]);
    return rows.map(toEvent);
  }

  async acquireLease(runId: string, worker: string): Promise<{ epoch: number; lastSeq: number }> {
    const [granted] = await this.sql<{ epoch: number; last_seq: number }[]>`
      UPDATE harness.runs
         SET lease_owner = ${worker}, lease_expires_at = now() + ${`${LEASE_MS / 1000} seconds`}::interval, epoch = epoch + 1
       WHERE run_id = ${runId}::uuid
         AND status IN ('created', 'running')
         AND (lease_expires_at IS NULL OR lease_expires_at < now())
      RETURNING epoch, last_seq::integer`;
    if (granted) return { epoch: granted.epoch, lastSeq: granted.last_seq };
    const [run] = await this.sql<{ lease_owner: string | null; status: string }[]>`
      SELECT lease_owner, status FROM harness.runs WHERE run_id = ${runId}::uuid`;
    if (!run) throw new RunNotFoundError(runId);
    if (run.status !== "created" && run.status !== "running") throw new Error(`Run ${runId} is ${run.status.replace("_", " ")}, so there is nothing to drive.`);
    throw new LeaseHeldError(runId, run.lease_owner ?? "another worker");
  }

  async renewLease(runId: string, worker: string, epoch: number): Promise<void> {
    await this.sql`
      UPDATE harness.runs SET lease_expires_at = now() + ${`${LEASE_MS / 1000} seconds`}::interval
       WHERE run_id = ${runId}::uuid AND lease_owner = ${worker} AND epoch = ${epoch}`;
  }

  async releaseLease(runId: string, worker: string, epoch: number): Promise<void> {
    // The epoch stays, so the next worker's is higher.
    await this.sql`
      UPDATE harness.runs SET lease_owner = NULL, lease_expires_at = NULL
       WHERE run_id = ${runId}::uuid AND lease_owner = ${worker} AND epoch = ${epoch}`;
  }

  async leaseHeld(runId: string): Promise<boolean> {
    const [run] = await this.sql<{ held: boolean }[]>`
      SELECT (lease_owner IS NOT NULL AND lease_expires_at > now()) AS held FROM harness.runs WHERE run_id = ${runId}::uuid`;
    if (!run) throw new RunNotFoundError(runId);
    return run.held;
  }

  async listRuns(): Promise<RunHead[]> {
    const rows = await this.sql<{ run_id: string; last_seq: number; status: RunStatus; lease_owner: string | null }[]>`
      SELECT run_id::text, last_seq::integer, status,
             CASE WHEN lease_expires_at > now() THEN lease_owner END AS lease_owner
        FROM harness.runs WHERE last_seq > 0`;
    return rows.map((r) => ({ runId: r.run_id, lastSeq: r.last_seq, status: r.status, ...(r.lease_owner ? { leaseOwner: r.lease_owner } : {}) }));
  }

  /**
   * `LISTEN harness_events`, which the insert trigger notifies once per statement with `<run id>:<max seq>`. It
   * needs a direct connection (port 5432): through PgBouncer in transaction mode it fails, and the caller falls
   * back to `listRuns`. Notifications are hints; a missed one is caught by the next `listRuns`.
   */
  async watch(onChange: (runId: string) => void): Promise<() => Promise<void>> {
    const { unlisten } = await this.sql.listen("harness_events", (payload) => {
      const runId = payload.split(":")[0];
      if (runId) onChange(runId);
    });
    return unlisten;
  }

  /**
   * `NOTIFY harness_text` with `<run id>:<text>`, split so each notification stays under Postgres's 8000-byte
   * limit. Notifications from one session arrive in the order they were sent. Needs no grant: any role may
   * notify and listen.
   */
  async publishText(runId: string, delta: string): Promise<void> {
    for (const part of splitUtf8(delta, TEXT_NOTIFY_BYTES)) await this.sql.notify(TEXT_CHANNEL, `${runId}:${part}`);
  }

  /** `LISTEN harness_text`. The same direct connection as `watch`. */
  async watchText(onText: (runId: string, delta: string) => void): Promise<() => Promise<void>> {
    const { unlisten } = await this.sql.listen(TEXT_CHANNEL, (payload) => {
      const at = payload.indexOf(":");
      if (at > 0) onText(payload.slice(0, at), payload.slice(at + 1));
    });
    return unlisten;
  }

  /** Test helper: what a dead worker's lease does on its own after a minute. */
  async expireLease(runId: string): Promise<void> {
    await this.sql`UPDATE harness.runs SET lease_expires_at = now() - interval '1 second' WHERE run_id = ${runId}::uuid`;
  }
}
