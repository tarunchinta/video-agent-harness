import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRun, Engine, foldRun, HeadMovedError, LeaseHeldError, recordCreatorEvent, requestCancel, StaleEpochError,
  type HarnessEvent, type NewEvent,
} from "@harness/harness";
import { FaultyStore, respond, ScriptedProvider, toolCall } from "@harness/harness/testing";
import { migrate, PostgresEventStore } from "../src/index.ts";

/**
 * Runs against a real Postgres 18, and only when asked: HARNESS_PG_IT_URL is a server administrator's URL for a
 * throwaway server (CI starts one). Each run of this file makes its own database, migrates it, connects as the
 * application role the migration grants, and drops the database at the end.
 */
const ADMIN_URL = process.env.HARNESS_PG_IT_URL;
const APP_PASSWORD = "integration-test-only";

describe.skipIf(!ADMIN_URL)("the Postgres event store", () => {
  let admin: Sql;
  let dbAdmin: Sql;
  let appUrl: string;
  let webUrl: string;
  let store: PostgresEventStore;
  const database = `harness_it_${Date.now()}`;
  const runsDir = mkdtempSync(join(tmpdir(), "harness-pg-"));

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${database}`;
    dbAdmin = postgres(url.toString(), { max: 1, onnotice: () => {} });
    expect(await migrate(dbAdmin)).toEqual(["0001_event_log_and_run_state", "0002_web_role"]);
    // A second migrate is a no-op: every migration records itself.
    expect(await migrate(dbAdmin)).toEqual([]);
    await dbAdmin.unsafe(`ALTER ROLE harness_app LOGIN PASSWORD '${APP_PASSWORD}'`);
    await dbAdmin.unsafe(`ALTER ROLE harness_web LOGIN PASSWORD '${APP_PASSWORD}'`);
    url.password = APP_PASSWORD;
    url.username = "harness_web";
    webUrl = url.toString();
    url.username = "harness_app";
    appUrl = url.toString();
    store = PostgresEventStore.connect(appUrl, runsDir);
  });

  afterAll(async () => {
    await store?.close();
    await dbAdmin?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  });

  const newRun = () => createRun(store, { task: "Write a note and read it back.", model: "test-model", system: "You are a test agent." });
  const runRow = async (runId: string) =>
    (await dbAdmin`SELECT status, last_seq::integer, tokens_in::integer, cost_micro_usd::integer, epoch, lease_owner, pending_gate FROM harness.runs WHERE run_id = ${runId}::uuid`)[0]!;
  const point = (runSpan: string, i: number): NewEvent => ({
    eventId: crypto.randomUUID(),
    type: "budget.updated",
    actor: "creator",
    spanId: runSpan,
    occurredAt: new Date(Date.UTC(2026, 10, 17, 0, 0, i)).toISOString(),
    payload: { limits: {} },
  });

  it("writes and reads a run, with the row as a projection of the log", async () => {
    const runId = await newRun();
    const events = await store.read(runId);
    expect(events.map((e) => [e.seq, e.type])).toEqual([[1, "run.created"]]);
    expect(foldRun(events).status).toBe("created");
    expect(await runRow(runId)).toMatchObject({ status: "created", last_seq: 1 });
  });

  it("drives a whole run, and the row ends where the log says", async () => {
    const provider = new ScriptedProvider([
      respond([toolCall("write_file", { path: "note.txt", content: "hello" })], { usage: { inputTokens: 1000, outputTokens: 50 } }),
      respond([toolCall("read_file", { path: "note.txt" })]),
      respond([toolCall("finish", { summary: "Wrote and read the note." })]),
    ]);
    const runId = await newRun();
    const engine = new Engine({ store, provider, workDir: (id) => join(store.runDir(id), "work"), sleep: async () => {}, worker: "pg-worker" });
    expect((await engine.run(runId)).status).toBe("succeeded");
    const events = await store.read(runId);
    events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
    });
    const state = foldRun(events);
    expect(state.status).toBe("succeeded");
    expect(await runRow(runId)).toMatchObject({ status: "succeeded", last_seq: events.length, tokens_in: state.tokensIn, cost_micro_usd: state.costMicroUsd, lease_owner: null });
    // A second store, with nothing cached, reads the same log.
    const fresh = PostgresEventStore.connect(appUrl, runsDir, { max: 1 });
    expect(await fresh.read(runId)).toEqual(events);
    await fresh.close();
  });

  it("lists runs with their heads and live leases, and pushes each append to a watcher", async () => {
    const runId = await newRun();
    const runSpan = (await store.read(runId))[0]!.spanId;
    const lease = await store.acquireLease(runId, "lister");
    const head = async () => (await store.listRuns()).find((h) => h.runId === runId);
    expect(await head()).toEqual({ runId, lastSeq: 1, status: "created", leaseOwner: "lister" });

    const seen: string[] = [];
    // A second store, as another process would have: the watcher hears appends made through any connection.
    const watcher = PostgresEventStore.connect(appUrl, runsDir, { max: 1 });
    const stop = await watcher.watch((id) => seen.push(id));
    await store.append(runId, 1, [point(runSpan, 1)], lease.epoch);
    for (let i = 0; i < 100 && !seen.includes(runId); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(seen).toContain(runId);
    await stop();
    await watcher.close();

    await store.releaseLease(runId, "lister", lease.epoch);
    expect(await head()).toEqual({ runId, lastSeq: 2, status: "created" });
    await store.expireLease(runId);
  });

  it("passes typed text to another connection in order, split under the notify limit", async () => {
    const runId = await newRun();
    const heard: string[] = [];
    const listener = PostgresEventStore.connect(appUrl, runsDir, { max: 1 });
    const stop = await listener.watchText((id, delta) => id === runId && heard.push(delta));
    const long = "é".repeat(5_000);
    await store.publishText(runId, "Writing ");
    await store.publishText(runId, "the draft. ");
    await store.publishText(runId, long);
    for (let i = 0; i < 100 && heard.join("").length < 19 + long.length; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(heard.join("")).toBe(`Writing the draft. ${long}`);
    expect(heard.length).toBeGreaterThan(3);
    await stop();
    await listener.close();
  });

  it("never gives two writers the same seq", async () => {
    const runId = await newRun();
    const runSpan = (await store.read(runId))[0]!.spanId;
    const other = PostgresEventStore.connect(appUrl, runsDir, { max: 2 });
    let i = 0;
    const writer = async (s: PostgresEventStore, count: number) => {
      for (let n = 0; n < count; n += 1) {
        for (;;) {
          const head = (await s.read(runId)).length;
          try {
            await s.append(runId, head, [point(runSpan, (i += 1))]);
            break;
          } catch (err) {
            if (!(err instanceof HeadMovedError)) throw err;
          }
        }
      }
    };
    await Promise.all([writer(store, 15), writer(other, 15), writer(store, 15), writer(other, 15)]);
    await other.close();
    const events = await store.read(runId);
    expect(events).toHaveLength(61);
    events.forEach((e, n) => {
      expect(e.seq).toBe(n + 1);
    });
    expect((await runRow(runId)).last_seq).toBe(61);
  });

  it("keeps one worker per run with the lease, and refuses a worker that lost it", async () => {
    const runId = await newRun();
    const runSpan = (await store.read(runId))[0]!.spanId;
    const first = await store.acquireLease(runId, "worker-a");
    await expect(store.acquireLease(runId, "worker-b")).rejects.toBeInstanceOf(LeaseHeldError);
    expect(await store.leaseHeld(runId)).toBe(true);
    await store.expireLease(runId);
    expect(await store.leaseHeld(runId)).toBe(false);
    const second = await store.acquireLease(runId, "worker-b");
    expect(second.epoch).toBe(first.epoch + 1);
    await expect(store.append(runId, 1, [point(runSpan, 1)], first.epoch)).rejects.toBeInstanceOf(StaleEpochError);
    await store.append(runId, 1, [point(runSpan, 1)], second.epoch);
    await store.releaseLease(runId, "worker-b", second.epoch);
    expect(await store.leaseHeld(runId)).toBe(false);
  });

  it("survives a crash at any write and finishes on resume", async () => {
    const script = () => [
      respond([toolCall("write_file", { path: "a.txt", content: "a" })]),
      respond([toolCall("finish", { summary: "Done." })]),
    ];
    for (let dieAfter = 0; dieAfter < 6; dieAfter += 1) {
      const runId = await newRun();
      const workDir = (id: string) => join(store.runDir(id), "work");
      const doomed = new Engine({ store: new FaultyStore(store, dieAfter), provider: new ScriptedProvider(script()), workDir, sleep: async () => {}, worker: "doomed" });
      await expect(doomed.run(runId)).rejects.toThrow("The process is gone.");
      await store.expireLease(runId);
      const next = new Engine({ store, provider: new ScriptedProvider(script().slice(-1)), workDir, sleep: async () => {}, worker: "next" });
      const outcome = await next.run(runId);
      expect(outcome.status, `after ${dieAfter} writes`).toBe("succeeded");
      const events: HarnessEvent[] = await store.read(runId);
      for (const e of events) if (e.type.endsWith(".started")) expect(events.some((c) => c.spanId === e.spanId && /\.(completed|failed)$/.test(c.type))).toBe(true);
    }
  });

  it("closes a run whose worker died when it is cancelled", async () => {
    const runId = await newRun();
    const runSpan = (await store.read(runId))[0]!.spanId;
    const lease = await store.acquireLease(runId, "crashed");
    await store.append(runId, 1, [{ eventId: crypto.randomUUID(), type: "run.started", actor: "engine", spanId: runSpan, occurredAt: new Date().toISOString(), payload: { worker: "crashed", epoch: lease.epoch } }], lease.epoch);
    await store.expireLease(runId);
    expect((await requestCancel(store, runId)).status).toBe("cancelled");
    expect((await runRow(runId)).status).toBe("cancelled");
  });

  it("is append-only for the application role", async () => {
    const runId = await newRun();
    const app = postgres(appUrl, { max: 1, onnotice: () => {} });
    await expect(app`UPDATE harness.events SET type = 'run.failed' WHERE run_id = ${runId}::uuid`).rejects.toThrow(/permission denied/);
    await expect(app`DELETE FROM harness.events WHERE run_id = ${runId}::uuid`).rejects.toThrow(/permission denied/);
    await app.end();
    // Even the owner cannot rewrite history: a trigger refuses every update.
    await expect(dbAdmin`UPDATE harness.events SET type = 'run.failed' WHERE run_id = ${runId}::uuid`).rejects.toThrow(/append-only/);
  });

  it("lets the web role write what the creator may ask for, and nothing a worker writes", async () => {
    const web = PostgresEventStore.connect(webUrl, runsDir, { max: 1 });
    // Everything a remote web server does: create, answer, budget, resume, pause, its own notes, cancel.
    const runId = await createRun(web, { task: "Started from the cloud.", model: "test-model", system: "s" });
    const runSpan = (await web.read(runId))[0]!.spanId;
    await web.append(runId, 1, [point(runSpan, 1)]);
    await recordCreatorEvent(web, runId, "x.web.voiceover", { choice: "none" });
    expect((await web.listRuns()).find((h) => h.runId === runId)).toEqual({ runId, lastSeq: 3, status: "created" });

    // It cannot take a lease, so it cannot drive or pass itself off as the worker.
    await expect(web.acquireLease(runId, "pretend-worker")).rejects.toThrow(/permission denied/);
    // Nor write what an agent or the engine says while driving.
    const forged = (type: string, actor: NewEvent["actor"], payload: Record<string, unknown>): NewEvent =>
      ({ eventId: crypto.randomUUID(), type, actor, spanId: runSpan, occurredAt: new Date().toISOString(), payload });
    await expect(web.append(runId, 3, [forged("run.started", "engine", { worker: "w", epoch: 1 })])).rejects.toThrow(/row-level security/);
    await expect(web.append(runId, 3, [forged("context.message", "engine", { origin: "engine", content: "forged" })])).rejects.toThrow(/row-level security/);

    // A cancel of a run nobody drives closes it, through the closing events it is allowed.
    expect((await requestCancel(web, runId)).status).toBe("cancelled");
    expect((await runRow(runId)).status).toBe("cancelled");
    // The worker's role is unaffected by the policies.
    expect((await store.read(runId)).at(-1)?.type).toBe("run.failed");
    await web.close();
  });
});
