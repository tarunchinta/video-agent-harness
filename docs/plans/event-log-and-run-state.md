# Event log and run state: schema

Status: schema applied; the writer and reducer code are not built yet. Source of
requirements: `VISION.md` only.
Database: Azure Database for PostgreSQL flexible server, PostgreSQL 18.

The tables, triggers, view and grants here are implemented in
`db/bootstrap.sql` and `db/migrations/0001_event_log_and_run_state.sql`, and
were checked against a live PostgreSQL 18 server. If this document and the
migration disagree, the migration is what is deployed.

## Decisions in brief

| Question | Decision |
|---|---|
| Source of truth | One append-only `events` table. Everything else is derived from it. |
| Ordering | A gapless per-run `seq`, assigned under the run's row lock. No global sequence. |
| Concurrency | Optimistic: an append names the head it expects (`last_seq`) and fails if the head moved. |
| Run state | A `runs` row updated in the same transaction as each append. It can be rebuilt by replaying the log. |
| Resume | Fold the log, close anything left in flight, restore the working directory from the last checkpoint. No state snapshots. |
| Large data | Never in the log. Files go to disk or blob storage and are referenced through `artifacts`. |
| Live updates | `NOTIFY` as a wake-up signal only; readers always read from the table by cursor. |
| Tracing | Every event carries a span id and parent span id. Export to OpenTelemetry is a mapping, not the storage format. |
| Extensions | None. The schema uses core PostgreSQL 18 only, so it also runs on a plain local Postgres. |
| Partitioning | None in v1. Volume does not justify it (see [Sizing](#sizing-and-retention)). |

## What the vision requires

Each requirement below is taken from `VISION.md` and drives a specific part of
the schema.

| Requirement | Consequence |
|---|---|
| "A run is an append-only event log. Anything the UI shows, an eval scores or a resume needs comes from that log." | The log is the only source of truth. `runs` and `artifacts` hold nothing that cannot be rebuilt from it, apart from the worker lease. |
| A run can stop at a gate, crash or be paused, and pick up from the log | Side effects are recorded as started and finished events, so a resume can tell what was in flight. |
| Budgets for tokens, money, wall-clock time and re-edit count, enforced in code | Usage is stored in typed columns, not buried in JSON, and totals are kept on the run row in the same transaction. |
| Traces: every model call, tool call, cost and artifact | One span per model call and tool call, with cost on the closing event. |
| Sub-agents with their own context | Every event names the agent it belongs to, and an agent's context is rebuilt from its own events. |
| Compaction and tool-result offloading | Compaction is an event. Offloaded results are artifacts referenced from the tool event. |
| Two review gates | Gates are events written by the creator, and the run row shows which gate is open. |
| Untrusted content stays contained | Each event is flagged if its payload carries untrusted text, so code can refuse to put it in front of a model that has tools. |
| Everything is a plugin | Event types are open: plugins add their own under a reserved prefix, and those can never change run state. |
| Evals: cost and time per reel, re-edits, critic validity, ablations | Critiques, human ratings and post-publish metrics are first-class events. Runs carry labels and can be forked. |
| Recorded runs anyone can replay; third-party reels cannot be redistributed | Artifacts record their rights status so an export can leave out what cannot be shared. |

## Model

```
runs 1 ──< events          one ordered log per run
runs 1 ──< artifacts       files the log refers to (rows mirror artifact.created events)
```

A **run** is one attempt to turn a brief into a reel. An **event** is one
immutable fact about that run. A **span** is a unit of work with a start and an
end (the run, a stage, an agent, a model call, a tool call); events belong to
spans, and spans nest. An **artifact** is a file the run produced or consumed.

## Tables

All objects live in the `harness` schema.

### `runs`

Three groups of columns, with different rules:

- **Identity** never changes after insert.
- **Projection** is derived from the log by the reducer (see
  [Reducer](#reducer-how-events-change-run-state)). It is updated only as part
  of an append and can be rebuilt at any time.
- **Coordination** is the worker lease. It is the one thing in this schema that
  is not in the log, because it describes who is working right now, not what
  happened.

```sql
CREATE SCHEMA IF NOT EXISTS harness;

CREATE TABLE harness.runs (
  -- identity
  run_id              uuid        PRIMARY KEY,           -- UUIDv7 from the app; doubles as the trace id
  created_at          timestamptz NOT NULL DEFAULT now(),
  title               text        NOT NULL,
  config              jsonb       NOT NULL,              -- frozen copy of run.created payload.config
  labels              jsonb       NOT NULL DEFAULT '{}', -- e.g. {"eval": "critic-ablation", "arm": "no_critic"}
  forked_from_run_id  uuid        REFERENCES harness.runs (run_id) ON DELETE RESTRICT,
  forked_at_seq       bigint,

  -- log head
  last_seq            bigint      NOT NULL DEFAULT 0,

  -- projection: where the run is
  status              text        NOT NULL DEFAULT 'created'
                      CHECK (status IN ('created','running','waiting_gate','paused',
                                        'succeeded','failed','cancelled')),
  status_reason       text,                              -- e.g. 'budget:cost', 'creator', 'gate_rejected'
  stage               text        CHECK (stage IN ('brief','research','script','assets',
                                                   'edit','critique','learn')),
  pending_gate        text        CHECK (pending_gate IN ('script','final_cut')),
  script_revision     integer     NOT NULL DEFAULT 0,
  cut_revision        integer     NOT NULL DEFAULT 0,
  script_artifact_id  uuid,                              -- latest script
  render_artifact_id  uuid,                              -- latest render
  final_artifact_id   uuid,                              -- the approved cut
  critique_passed     boolean,                           -- verdict on render_artifact_id
  failure             jsonb,                             -- {kind, message, seq} when status = 'failed'

  -- projection: budgets
  tokens_in           bigint      NOT NULL DEFAULT 0,
  tokens_out          bigint      NOT NULL DEFAULT 0,
  cost_micro_usd      bigint      NOT NULL DEFAULT 0,
  active_ms           bigint      NOT NULL DEFAULT 0,    -- time spent in 'running', closed intervals only
  running_since       timestamptz,                       -- open interval, if running
  re_edits            integer     NOT NULL DEFAULT 0,    -- critic-driven re-edits
  max_tokens          bigint,                            -- NULL means no limit
  max_cost_micro_usd  bigint,
  max_active_ms       bigint,
  max_re_edits        integer,

  started_at          timestamptz,
  ended_at            timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  projection_version  integer     NOT NULL DEFAULT 1,    -- reducer version that wrote this row

  -- coordination
  lease_owner         text,
  lease_expires_at    timestamptz,
  epoch               integer     NOT NULL DEFAULT 0,    -- fencing token, bumped on every lease grant

  CHECK ((forked_from_run_id IS NULL) = (forked_at_seq IS NULL)),
  CHECK ((status = 'waiting_gate') = (pending_gate IS NOT NULL))
);

CREATE INDEX runs_status_idx ON harness.runs (status, updated_at DESC);
CREATE INDEX runs_labels_idx ON harness.runs USING gin (labels);
```

Notes:

- Money is stored as whole micro-dollars (`1 USD = 1 000 000`). No floats.
- The artifact pointer columns have no foreign keys. They are projection, and a
  forked run may point at an artifact owned by its parent.
- There is no "crashed" status. A crashed worker cannot write one. A run that
  is `running` with an expired lease is stalled and can be resumed; that is
  computed at read time from `lease_expires_at`.
- The wall-clock budget counts time in `running` only. Time spent waiting for
  the creator at a gate does not count.

### `events`

```sql
CREATE TABLE harness.events (
  run_id          uuid        NOT NULL REFERENCES harness.runs (run_id) ON DELETE CASCADE,
  seq             bigint      NOT NULL,                  -- 1, 2, 3 ... per run, no gaps
  event_id        uuid        NOT NULL,                  -- UUIDv7 from the writer; idempotency key
  type            text        NOT NULL,                  -- e.g. 'tool.call.completed'
  schema_version  smallint    NOT NULL DEFAULT 1,        -- version of this type's payload
  occurred_at     timestamptz NOT NULL,                  -- writer's clock
  recorded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),  -- database clock
  actor           text        NOT NULL
                  CHECK (actor IN ('creator','agent','engine','plugin')),
  agent_id        text,                                  -- agent instance, e.g. 'researcher-1'
  span_id         uuid        NOT NULL,
  parent_span_id  uuid,
  untrusted       boolean     NOT NULL DEFAULT false,    -- payload carries scraped or retrieved text
  tokens_in       integer,                               -- set on events that close a metered span
  tokens_out      integer,
  cost_micro_usd  bigint,
  payload         jsonb       NOT NULL DEFAULT '{}',

  PRIMARY KEY (run_id, seq),
  UNIQUE (event_id),
  CHECK (seq > 0),
  CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (octet_length(payload::text) <= 262144)          -- 256 KB; bigger content is an artifact
);

-- Find events of one type in a run (gates, critiques, checkpoints).
CREATE INDEX events_run_type_idx ON harness.events (run_id, type, seq);

-- Assemble spans.
CREATE INDEX events_run_span_idx ON harness.events (run_id, span_id, seq);

-- A span opens once and closes once.
CREATE UNIQUE INDEX events_span_open_uq  ON harness.events (run_id, span_id)
  WHERE type LIKE '%.started';
CREATE UNIQUE INDEX events_span_close_uq ON harness.events (run_id, span_id)
  WHERE type LIKE '%.completed' OR type LIKE '%.failed';
```

Column rules:

- **`seq`** is the only ordering that matters. Timestamps are for display and
  durations.
- **`actor`** says who decided the event, which is separate from any model
  role. `creator` is human input. `agent` is something a model chose (its
  output, a tool request). `engine` is deterministic harness code (lifecycle,
  gates, budgets). `plugin` is the result of running a tool or backend.
- **`untrusted`** is set by the plugin that produced the content and is never
  cleared. Context-building code refuses to place an untrusted event in the
  context of a model call that has tools. Validated output of a tool-less call
  is a new, trusted event.
- **`tokens_in`, `tokens_out`, `cost_micro_usd`** are the totals the budget
  gate uses. Finer detail (cache reads, video minutes indexed) goes in
  `payload.usage`.
- **`type`** is not constrained to a list in the database. The type registry in
  code validates the payload against a schema for `(type, schema_version)`
  before every append.

Append-only is enforced twice: by a trigger, and by privileges.

```sql
CREATE FUNCTION harness.events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'harness.events is append-only';
END $$;

CREATE TRIGGER events_no_update
  BEFORE UPDATE ON harness.events
  FOR EACH ROW EXECUTE FUNCTION harness.events_immutable();

-- The application role can read and append, nothing else.
-- Removing a whole run is done by a separate admin role deleting the runs row.
GRANT USAGE ON SCHEMA harness TO harness_app;
GRANT SELECT, INSERT ON harness.events TO harness_app;
GRANT SELECT, INSERT ON harness.artifacts TO harness_app;
GRANT SELECT, INSERT, UPDATE ON harness.runs TO harness_app;
```

### `artifacts`

A lookup table for files. Each row mirrors one `artifact.created` event and is
inserted in the same transaction.

```sql
CREATE TABLE harness.artifacts (
  artifact_id  uuid        PRIMARY KEY,                  -- UUIDv7 from the writer
  run_id       uuid        NOT NULL,
  created_seq  bigint      NOT NULL,                     -- the artifact.created event
  kind         text        NOT NULL,                     -- see list below
  revision     integer     NOT NULL DEFAULT 1,
  uri          text        NOT NULL,                     -- storage-plugin URI, never a signed URL
  sha256       text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes        bigint      NOT NULL CHECK (bytes >= 0),
  media_type   text        NOT NULL,
  rights       text        NOT NULL
               CHECK (rights IN ('own','generated','public','third_party')),
  meta         jsonb       NOT NULL DEFAULT '{}',        -- duration_ms, width, height, fps ...
  created_at   timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (run_id, created_seq)
    REFERENCES harness.events (run_id, seq) ON DELETE CASCADE
);

CREATE INDEX artifacts_run_kind_idx ON harness.artifacts (run_id, kind, revision DESC);
CREATE INDEX artifacts_sha256_idx   ON harness.artifacts (sha256);
```

Kinds: `reference_video`, `video_analysis`, `source`, `dataset`, `chart`,
`findings`, `script`, `voiceover`, `word_timestamps`, `footage`,
`demo_recording`, `composition`, `render`, `tool_output`, `model_request`,
`workspace_manifest`.

`rights` exists because reference reels are third-party media. A public trace
export includes only artifacts whose rights allow it, and keeps the metadata
row for the rest.

### `spans` view

Spans are not stored. They are the pairing of a `.started` event with its
closing event.

```sql
CREATE VIEW harness.spans AS
SELECT s.run_id,
       s.span_id,
       s.parent_span_id,
       s.agent_id,
       left(s.type, length(s.type) - length('.started')) AS kind,
       s.seq          AS start_seq,
       e.seq          AS end_seq,
       s.occurred_at  AS started_at,
       e.occurred_at  AS ended_at,
       CASE WHEN e.seq IS NULL          THEN 'open'
            WHEN e.type LIKE '%.failed' THEN 'failed'
            ELSE 'ok' END AS outcome,
       e.tokens_in,
       e.tokens_out,
       e.cost_micro_usd
FROM harness.events s
LEFT JOIN harness.events e
       ON e.run_id = s.run_id
      AND e.span_id = s.span_id
      AND (e.type LIKE '%.completed' OR e.type LIKE '%.failed')
WHERE s.type LIKE '%.started';
```

## Event envelope and naming

Type names are lowercase, dot-separated, past tense: `<subject>.<what happened>`.

- A type ending in `.started` opens a span.
- A type ending in `.completed` or `.failed` closes it. Both reuse the
  `span_id` of the `.started` event.
- Anything else is a point event inside a span.
- Plugin-defined types start with `x.<plugin_id>.`. The reducer ignores them,
  so a plugin can record what it likes but cannot move a run between states.

Span nesting follows the work:

```
run
└─ stage (research)
   └─ agent (researcher-1)
      ├─ model.call
      ├─ tool.call (web fetch)
      └─ agent (a sub-agent it spawned)
         └─ model.call
```

## Event catalogue (v1)

Payload fields listed are the ones that matter for state, replay or evals. Every
payload is validated by the type registry.

### Run lifecycle

| Type | Actor | Payload |
|---|---|---|
| `run.created` | creator | `brief` (topic, reference ids), `config` (models, plugin ids and versions, rubric version, feature flags), `limits`, `harness_version` |
| `run.forked` | creator | `parent_run_id`, `at_seq`, `config_overrides` |
| `run.started` | engine | `worker`, `epoch`. Opens the run span. |
| `run.resumed` | engine | `worker`, `epoch`, `reason` (`crash`, `gate`, `unpaused`), `interrupted_spans` |
| `run.pause_requested` | creator | `note` |
| `run.paused` | engine | `reason` (`creator`, `budget:<dimension>`) |
| `run.resume_requested` | creator | `note`. Takes a paused run back to `running` so a worker can pick it up. |
| `run.cancel_requested` | creator | `note` |
| `run.completed` | engine | `final_artifact_id` |
| `run.failed` | engine | `error` (`kind`, `message`, `seq`) |
| `budget.updated` | creator | `limits` |
| `budget.exceeded` | engine | `dimension`, `used`, `limit` |
| `checkpoint.created` | engine | `workspace_manifest_artifact_id`, `reason` (`stage_end`, `gate`, `pause`) |

A cancelled run records `run.failed` with `error.kind = "cancelled"`, so the run
span always closes. If a worker holds the lease, it writes that event at its
next step. If no worker is attached (the run is paused or waiting at a gate),
whoever writes the cancel request or the gate rejection adds it to the same
batch.

### Stages and gates

| Type | Actor | Payload |
|---|---|---|
| `stage.started` | engine | `stage`, `revision`, `trigger` (`plan`, `critique`, `creator`) |
| `stage.completed` | engine | `stage`, `output_artifact_ids` |
| `stage.failed` | engine | `stage`, `error` |
| `gate.opened` | engine | `gate` (`script`, `final_cut`), `artifact_id`, `critique_seq` |
| `gate.decided` | creator | `gate`, `decision` (`approved`, `changes_requested`, `rejected`), `notes[]` (`t_start_ms`, `t_end_ms`, `text`) |

### Agents and context

| Type | Actor | Payload |
|---|---|---|
| `agent.started` | engine | `role` (`orchestrator`, `researcher`, `scriptwriter`, `demo_operator`, `editor`, `critic`), `model`, `tools[]`, `system_prompt_sha256`, `task` |
| `agent.completed` | agent | `result`, `output_artifact_ids` |
| `agent.failed` | engine | `error` |
| `context.message` | engine or creator | `origin`, `content`. A message injected into an agent's context. |
| `context.compacted` | engine | `from_seq`, `to_seq`, `summary`, `tokens_before`, `tokens_after` |

### Model calls

| Type | Actor | Payload |
|---|---|---|
| `model.call.started` | engine | `provider`, `model`, `params`, `purpose`, `tools_enabled`, `context_through_seq`, `request_sha256`, `request_artifact_id` (optional), `attempt` |
| `model.call.completed` | agent | `response_id`, `stop_reason`, `content[]` (text, thinking and tool-request blocks, as returned), `usage`, `latency_ms`, `first_token_ms` |
| `model.call.failed` | engine | `error` (`kind`, `message`, `retryable`), `attempt` |

The request body is not stored on every call, because it repeats the whole
context and would make the log grow with the square of the conversation length.
The log stores what is needed to rebuild it (`context_through_seq`) and a hash
to prove the rebuild is exact (`request_sha256`). With `config.trace = "full"`
the full request is also saved as a `model_request` artifact.

Each retry is its own span, with `attempt` incremented.

### Tool calls

All plugin work goes through these three types: web fetch, sandbox execution,
browser demo capture, video understanding, render, voice.

| Type | Actor | Payload |
|---|---|---|
| `tool.call.started` | agent | `tool`, `plugin`, `plugin_version`, `tool_call_id`, `input`, `idempotent`, `sandboxed` |
| `tool.call.progress` | plugin | `fraction`, `note`. At most one every two seconds. |
| `tool.call.completed` | plugin | `output` (if small) or `output_artifact_id`, `truncated`, `summary`, `usage`, `duration_ms`, `backend` |
| `tool.call.failed` | plugin or engine | `error` (`kind`, `message`, `retryable`) |
| `sandbox.started` | engine | `image`, `container_id` |
| `sandbox.completed` | engine | `exit_reason` |

`backend` on video-understanding calls is what makes the head-to-head eval a
query: the same question, two backends, cost and latency on each closing event.

### Artifacts and critique

| Type | Actor | Payload |
|---|---|---|
| `artifact.created` | plugin or creator | Every column of the `artifacts` row, plus `derived_from[]` (artifact ids) |
| `critique.completed` | agent | `render_artifact_id`, `rubric_id`, `rubric_version`, `backend`, `scores` (`hook`, `pacing`, `av_sync`, `legibility`, `grounding`), `overall`, `passed`, `notes[]` (`t_start_ms`, `t_end_ms`, `dimension`, `severity`, `text`) |

`critique.completed` is a point event inside the critic's agent span, not a
span of its own. Its work is the model and tool calls around it.

### Learn

These three types are the only ones accepted after a run has ended.

| Type | Actor | Payload |
|---|---|---|
| `publish.recorded` | creator | `platform`, `url`, `published_at`, `artifact_id` |
| `metrics.recorded` | creator or plugin | `platform`, `captured_at`, `hours_since_publish`, `views`, `likes`, `comments`, `shares`, `saves`, `avg_watch_ms`, `retention[]`, `source` |
| `rating.recorded` | creator | `artifact_id`, `rater`, `scores` (same keys as the rubric), `overall`, `notes` |

## Writing events

One writer path, used by the engine, the CLI and the web UI alike.

```sql
-- $1 run_id   $2 expected last_seq   $3 batch size   $4 epoch (NULL for non-engine writers)
-- $5 jsonb array of events, in order
WITH head AS (
  UPDATE harness.runs
     SET last_seq   = last_seq + $3,
         updated_at = now()
         -- plus whichever projection columns the reducer changed
   WHERE run_id   = $1
     AND last_seq = $2
     AND ($4::integer IS NULL OR epoch = $4)
  RETURNING run_id
)
INSERT INTO harness.events
  (run_id, seq, event_id, type, schema_version, occurred_at, actor, agent_id,
   span_id, parent_span_id, untrusted, tokens_in, tokens_out, cost_micro_usd, payload)
SELECT head.run_id,
       $2 + e.ord,
       (e.ev->>'event_id')::uuid,
       e.ev->>'type',
       COALESCE((e.ev->>'schema_version')::smallint, 1),
       (e.ev->>'occurred_at')::timestamptz,
       e.ev->>'actor',
       e.ev->>'agent_id',
       (e.ev->>'span_id')::uuid,
       (e.ev->>'parent_span_id')::uuid,
       COALESCE((e.ev->>'untrusted')::boolean, false),
       (e.ev->>'tokens_in')::integer,
       (e.ev->>'tokens_out')::integer,
       (e.ev->>'cost_micro_usd')::bigint,
       COALESCE(e.ev->'payload', '{}'::jsonb)
FROM head,
     jsonb_array_elements($5::jsonb) WITH ORDINALITY AS e(ev, ord)
RETURNING seq;
```

How it behaves:

- **Rows returned:** the batch is committed, with consecutive `seq` values.
- **No rows returned:** the head moved or the epoch is stale. The writer reads
  the events after `$2`, folds them into its state, and tries again. A writer
  with a stale epoch has lost the lease and must stop.
- **Ordering:** the `UPDATE` holds the run's row lock until commit, so a second
  writer waits, then fails the `last_seq` check. Sequence numbers are therefore
  gapless and in commit order. A reader that has seen `seq = n` will never
  later find a new event at or below `n`.
- **Retries:** if the connection drops before the result arrives, the writer
  looks up its first `event_id`. If it is there, the batch landed. The unique
  constraint on `event_id` stops a blind retry from writing twice.
- **Driver note:** some drivers JSON-encode `jsonb` parameters themselves, so a
  pre-encoded string arrives double-encoded and the statement fails with
  "cannot extract elements from a scalar". With postgres.js, either pass the
  array itself or cast as `$5::text::jsonb` and pass a JSON string.
- **Artifacts:** when the batch contains `artifact.created`, the writer inserts
  the `artifacts` rows in the same transaction.
- **New runs:** `run.created` and `run.forked` have no row to update yet. The
  writer inserts the `runs` row and that first event in one transaction, with
  `last_seq` already pointing at it.

Why not a database sequence: sequence values are handed out before commit, so a
higher number can become visible before a lower one, and a reader paging
forward by position silently skips the late one. Scoping `seq` to the run and
assigning it under the row lock removes the problem instead of working around
it.

### Worker lease

Only one worker may drive a run. The lease stops a resumed run and a
not-quite-dead old worker from both acting.

```sql
-- Acquire. Returns no rows if another worker holds a live lease.
UPDATE harness.runs
   SET lease_owner = $2,
       lease_expires_at = now() + interval '60 seconds',
       epoch = epoch + 1
 WHERE run_id = $1
   AND status IN ('created', 'running')
   AND (lease_expires_at IS NULL OR lease_expires_at < now())
RETURNING epoch, last_seq;

-- Renew every 20 seconds.
UPDATE harness.runs
   SET lease_expires_at = now() + interval '60 seconds'
 WHERE run_id = $1 AND lease_owner = $2 AND epoch = $3;
```

The engine passes its `epoch` on every append. The creator's writes (gate
decisions, pause and cancel requests, ratings) pass `NULL` and rely on the
`last_seq` check alone.

## Reading events

| Need | Query |
|---|---|
| Replay or resume a run | `WHERE run_id = $1 ORDER BY seq` |
| Follow a run live | `WHERE run_id = $1 AND seq > $cursor ORDER BY seq` |
| One agent's context | `WHERE run_id = $1 AND agent_id = $2 ORDER BY seq`, then apply `context.compacted` |
| Cost per stage | `harness.spans` where `kind = 'stage'`, joined to child spans |
| All critiques for evals | `WHERE type = 'critique.completed'`, joined to `runs.labels` |

### Live updates

```sql
CREATE FUNCTION harness.events_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('harness_events', n.run_id::text || ':' || n.max_seq::text)
     FROM (SELECT run_id, max(seq) AS max_seq FROM new_events GROUP BY run_id) n;
  RETURN NULL;
END $$;

CREATE TRIGGER events_notify
  AFTER INSERT ON harness.events
  REFERENCING NEW TABLE AS new_events
  FOR EACH STATEMENT EXECUTE FUNCTION harness.events_notify();
```

The web server holds one `LISTEN harness_events` connection and fans out to
browsers. A notification only says "run X has reached seq N"; the server then
reads from the table by cursor. If a notification is lost (a restart, a dropped
connection), nothing is lost: the reader also polls every two seconds and
always resumes from its cursor.

The log does not hold token-by-token streaming. The finest live detail is one
event per model call and tool call, plus throttled progress events for long
renders. That keeps the rule that the UI shows only what is in the log.

## Reducer: how events change run state

The reducer is a pure function in code: `(run row, event) -> run row`. It runs
inside the append, and its output is the `SET` list of the `UPDATE`. Events not
listed here leave the run row alone, apart from `last_seq`.

| Event | Change to `runs` |
|---|---|
| `run.created` | Insert the row: `status = created`, `config`, limits |
| `run.forked` | Insert the row from the parent's state at `at_seq`, with overrides applied |
| `run.started`, `run.resumed` | `status = running`, `running_since = occurred_at`, `started_at` if unset |
| `stage.started` | `stage`; bump `script_revision` or `cut_revision`; bump `re_edits` when `stage = edit` and `trigger = critique` |
| `artifact.created` | `script_artifact_id` or `render_artifact_id` when the kind is `script` or `render`; a new render resets `critique_passed` to `NULL` |
| `critique.completed` | `critique_passed` |
| `gate.opened` | `status = waiting_gate`, `pending_gate`; close the running interval into `active_ms` |
| `gate.decided: approved` or `changes_requested` | `status = running`, `pending_gate = NULL`; on `final_cut` approval set `final_artifact_id` |
| `gate.decided: rejected` | `pending_gate = NULL`, `status_reason = gate_rejected`; the same batch carries `run.failed` with `error.kind = cancelled` |
| `run.paused` | `status = paused`, `status_reason`; close the running interval |
| `run.resume_requested` | `status = running`, `status_reason = NULL` |
| `budget.updated` | The four `max_*` columns |
| `run.completed` | `status = succeeded`, `ended_at`; close the running interval |
| `run.failed` | `status = failed` (or `cancelled` when `error.kind = cancelled`), `failure`, `ended_at` |
| Any event with usage columns | Add to `tokens_in`, `tokens_out`, `cost_micro_usd` |

`running_since` is set only by `run.started` and `run.resumed`, which a worker
writes when it actually begins work. Approving a gate or requesting a resume
makes the run `running` again but does not start the clock. After a crash the
open interval has no end, so `run.resumed` closes it at the `occurred_at` of
the last event before the resume.

Budget enforcement is the same code path. After folding a batch, the engine
compares usage with limits before starting the next model or tool call. Over a
token, cost or time limit, it appends `budget.exceeded` and `run.paused`, and
the creator can raise the limit and resume. Over the re-edit limit, it stops
revising and opens the final gate with the last critique attached.

`projection_version` records which reducer wrote the row. When the reducer
changes, a rebuild replays each log from `seq = 1` and overwrites the
projection columns.

## Resume

1. Acquire the lease. This bumps `epoch`.
2. Read the run's events in order and fold them into run state and per-agent
   context.
3. Find spans with a `.started` and no closing event. Close each with a
   `.failed` event whose `error.kind` is `interrupted`.
   - Model calls are simply issued again as a new span.
   - Tool calls marked `idempotent` are run again as a new span.
   - Other tool calls are not repeated. The agent sees the failure and decides
     what to do, because the side effect may or may not have happened.
4. Rebuild the working directory from the manifest named by the latest
   `checkpoint.created`. The manifest maps paths to content hashes; the files
   themselves are artifacts.
5. Append `run.resumed` and carry on.

Recorded results are never re-executed. A replay in the UI, or the fold in step
2, reads what the model and tools returned the first time.

Snapshots of folded state are left out on purpose. A run is a few thousand
events and folds in well under a second. If that stops being true,
`checkpoint.created` can carry a state snapshot and the fold can start from
there, with no change to the tables.

## Forks

A fork is a new run that shares its parent's history up to a checkpoint. It
exists for ablations: approve one script, then run the rest with and without
the critic loop.

- The child row has `forked_from_run_id` and `forked_at_seq`, and its
  `last_seq` starts at `forked_at_seq`.
- The child's first event is `run.forked` at `seq = forked_at_seq + 1`.
- The child's full history is the parent's events up to `forked_at_seq`,
  followed by its own. Sequence numbers line up, so every reference by `seq`
  stays valid, and nothing is copied.
- Forks are only allowed at a `checkpoint.created` event, so no span is open
  and the working directory is known.
- A parent cannot be deleted while a fork points at it.

## Azure Database for PostgreSQL notes

- **Version.** Use PostgreSQL 18, which is generally available on flexible
  server. `uuidv7()` is built in, though ids are generated by the writer so
  they exist before the insert.
- **Extensions.** None are needed, so there is nothing to add to
  `azure.extensions` or `shared_preload_libraries`. `pg_partman` and `pg_cron`
  are available on 18 if partitioning or scheduled cleanup is ever wanted.
- **Connection pooling.** The built-in PgBouncer runs on port 6432 in
  transaction mode by default and is not available on the Burstable tier.
  Appends, lease updates and reads are single statements or short
  transactions, so they work through it. `LISTEN` does not work in transaction
  pooling, so the one listener connection must go direct to port 5432. Nothing
  in this design uses session-level locks or session settings.
- **Restarts.** Scaling, failover and maintenance drop every connection. The
  idempotent append and the cursor-based reader are what make that safe.
- **TLS.** `require_secure_transport` is on by default; connect with
  `sslmode=require` or stricter.
- **Roles.** The server admin is not a superuser. Create `harness_app` for the
  application and keep schema changes and run deletion on a separate role.

## Sizing and retention

A run is expected to produce 2,000 to 20,000 events at a few kilobytes each, so
roughly 5 to 50 MB of log. A thousand runs fit in tens of gigabytes at the high
end. One unpartitioned table with the indexes above is enough, and every hot
query is keyed by `run_id`. These figures are estimates, to be replaced with
measurements from the first real runs.

Deleting a run means deleting its `runs` row; events and artifact rows follow
by cascade. Blob cleanup is a separate step driven by `sha256`, because files
are shared across runs and forks.

## What is not in the log

- File contents. Video, audio, charts, page snapshots and long tool output are
  artifacts.
- Token-by-token model output.
- Secrets. The writer scrubs known key patterns from payloads before append,
  and artifact URIs are never signed URLs.
- Who holds the lease right now.

## Schema evolution

- Event types are never renamed or removed, and a published payload version is
  never changed in place.
- A new field that old readers can ignore is added without a version bump.
  Anything else gets a new `schema_version`, with an upcaster in code that
  converts old payloads on read.
- New columns on `events` must be nullable or have a default.
- A reducer change bumps `projection_version` and triggers a rebuild.

## Prior art and what was taken from it

- **Workflow engines with an event history** (Temporal): results of side
  effects are recorded and reused on replay, never recomputed. Activities are
  logged as scheduled, started and completed. That is the started/finished
  pairing and the resume rule here.
  <https://docs.temporal.io/workflows>
- **OpenHands agent SDK**: an immutable event log where the model's view is
  derived by filtering and converting events, compaction is itself an event,
  and the origin of an event is kept separate from the model role.
  <https://docs.openhands.dev/sdk/arch/events>
- **Event stores on Postgres**: a unique `(stream, version)` key is what
  enforces optimistic concurrency, and a `bigserial` position is not safe to
  page by because numbers become visible out of commit order.
  <https://dev.to/kspeakman/event-storage-in-postgres-4dk2>
- **OpenTelemetry GenAI conventions**: the span model (`invoke_agent`, `chat`,
  `execute_tool`) matches this log's agent, model-call and tool-call spans. The
  attribute names are still marked Development and recently moved to their own
  repository, so they are applied when exporting, not used as column or payload
  names. <https://github.com/open-telemetry/semantic-conventions-genai>
- **`LISTEN`/`NOTIFY`**: payloads are capped near 8 KB, nothing is kept for a
  listener that is offline, and a notifying commit takes a global lock. All
  three are fine for a wake-up signal at this write rate and wrong for carrying
  the events themselves.
  <https://www.postgresql.org/docs/18/sql-notify.html>,
  <https://recall.ai/blog/postgres-listen-notify-does-not-scale>
- **PgBouncer feature map**: `LISTEN` is listed as never supported in
  transaction pooling. <https://www.pgbouncer.org/features.html>
- **Azure flexible server**:
  <https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-supported-versions>,
  <https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-pgbouncer>,
  <https://learn.microsoft.com/azure/postgresql/extensions/concepts-extensions-versions>

## Left open

- **Compute tier.** Burstable is the cheap choice for one creator and has no
  built-in PgBouncer. The design works either way; the choice only changes
  which port most connections use.
- **Full request capture.** Whether `config.trace = "full"` is the default.
  It makes every model call independently inspectable and costs blob storage.
- **Metrics source.** `metrics.recorded` accepts manual entry or a plugin. The
  vision leaves the source undecided, and the event shape does not depend on it.
