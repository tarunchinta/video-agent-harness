-- Event log and run state, v1. Design: docs/event-log-and-run-state.md
--
-- Run after db/bootstrap.sql, as a member of harness_owner.
-- Requires PostgreSQL 18. Uses no extensions.

BEGIN;

SET LOCAL ROLE harness_owner;

CREATE SCHEMA harness;

CREATE TABLE harness.schema_migrations (
  version     text        PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- runs: one row per run. Identity, a projection of the log, and the worker lease.
-- ---------------------------------------------------------------------------
CREATE TABLE harness.runs (
  -- identity
  run_id              uuid        PRIMARY KEY,
  created_at          timestamptz NOT NULL DEFAULT now(),
  title               text        NOT NULL,
  config              jsonb       NOT NULL,
  labels              jsonb       NOT NULL DEFAULT '{}',
  forked_from_run_id  uuid        REFERENCES harness.runs (run_id) ON DELETE RESTRICT,
  forked_at_seq       bigint,

  -- log head
  last_seq            bigint      NOT NULL DEFAULT 0,

  -- projection: where the run is
  status              text        NOT NULL DEFAULT 'created'
                      CHECK (status IN ('created','running','waiting_gate','paused',
                                        'succeeded','failed','cancelled')),
  status_reason       text,
  stage               text        CHECK (stage IN ('brief','research','script','assets',
                                                   'edit','critique','learn')),
  pending_gate        text        CHECK (pending_gate IN ('script','final_cut')),
  script_revision     integer     NOT NULL DEFAULT 0,
  cut_revision        integer     NOT NULL DEFAULT 0,
  script_artifact_id  uuid,
  render_artifact_id  uuid,
  final_artifact_id   uuid,
  critique_passed     boolean,
  failure             jsonb,

  -- projection: budgets
  tokens_in           bigint      NOT NULL DEFAULT 0,
  tokens_out          bigint      NOT NULL DEFAULT 0,
  cost_micro_usd      bigint      NOT NULL DEFAULT 0,
  active_ms           bigint      NOT NULL DEFAULT 0,
  running_since       timestamptz,
  re_edits            integer     NOT NULL DEFAULT 0,
  max_tokens          bigint,
  max_cost_micro_usd  bigint,
  max_active_ms       bigint,
  max_re_edits        integer,

  started_at          timestamptz,
  ended_at            timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  projection_version  integer     NOT NULL DEFAULT 1,

  -- coordination
  lease_owner         text,
  lease_expires_at    timestamptz,
  epoch               integer     NOT NULL DEFAULT 0,

  CHECK ((forked_from_run_id IS NULL) = (forked_at_seq IS NULL)),
  CHECK ((status = 'waiting_gate') = (pending_gate IS NOT NULL))
);

CREATE INDEX runs_status_idx ON harness.runs (status, updated_at DESC);
CREATE INDEX runs_labels_idx ON harness.runs USING gin (labels);

-- ---------------------------------------------------------------------------
-- events: the append-only log. The only source of truth.
-- ---------------------------------------------------------------------------
CREATE TABLE harness.events (
  run_id          uuid        NOT NULL REFERENCES harness.runs (run_id) ON DELETE CASCADE,
  seq             bigint      NOT NULL,
  event_id        uuid        NOT NULL,
  type            text        NOT NULL,
  schema_version  smallint    NOT NULL DEFAULT 1,
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor           text        NOT NULL
                  CHECK (actor IN ('creator','agent','engine','plugin')),
  agent_id        text,
  span_id         uuid        NOT NULL,
  parent_span_id  uuid,
  untrusted       boolean     NOT NULL DEFAULT false,
  tokens_in       integer,
  tokens_out      integer,
  cost_micro_usd  bigint,
  payload         jsonb       NOT NULL DEFAULT '{}',

  PRIMARY KEY (run_id, seq),
  UNIQUE (event_id),
  CHECK (seq > 0),
  CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (octet_length(payload::text) <= 262144)
);

CREATE INDEX events_run_type_idx ON harness.events (run_id, type, seq);
CREATE INDEX events_run_span_idx ON harness.events (run_id, span_id, seq);

-- A span opens once and closes once.
CREATE UNIQUE INDEX events_span_open_uq  ON harness.events (run_id, span_id)
  WHERE type LIKE '%.started';
CREATE UNIQUE INDEX events_span_close_uq ON harness.events (run_id, span_id)
  WHERE type LIKE '%.completed' OR type LIKE '%.failed';

CREATE FUNCTION harness.events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'harness.events is append-only';
END $$;

CREATE TRIGGER events_no_update
  BEFORE UPDATE ON harness.events
  FOR EACH ROW EXECUTE FUNCTION harness.events_immutable();

-- Wake listeners. The payload is "<run_id>:<seq>"; readers fetch rows by cursor.
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

-- ---------------------------------------------------------------------------
-- artifacts: files the log refers to. Each row mirrors an artifact.created event.
-- ---------------------------------------------------------------------------
CREATE TABLE harness.artifacts (
  artifact_id  uuid        PRIMARY KEY,
  run_id       uuid        NOT NULL,
  created_seq  bigint      NOT NULL,
  kind         text        NOT NULL,
  revision     integer     NOT NULL DEFAULT 1,
  uri          text        NOT NULL,
  sha256       text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes        bigint      NOT NULL CHECK (bytes >= 0),
  media_type   text        NOT NULL,
  rights       text        NOT NULL
               CHECK (rights IN ('own','generated','public','third_party')),
  meta         jsonb       NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (run_id, created_seq)
    REFERENCES harness.events (run_id, seq) ON DELETE CASCADE
);

CREATE INDEX artifacts_run_kind_idx ON harness.artifacts (run_id, kind, revision DESC);
CREATE INDEX artifacts_sha256_idx   ON harness.artifacts (sha256);

-- ---------------------------------------------------------------------------
-- spans: a .started event paired with its closing event.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Access for the application role: read and append. No deletes anywhere,
-- no updates to events or artifacts.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA harness TO harness_app;
GRANT SELECT, INSERT         ON harness.events    TO harness_app;
GRANT SELECT, INSERT         ON harness.artifacts TO harness_app;
GRANT SELECT, INSERT, UPDATE ON harness.runs      TO harness_app;
GRANT SELECT                 ON harness.spans, harness.schema_migrations TO harness_app;

INSERT INTO harness.schema_migrations (version) VALUES ('0001_event_log_and_run_state');

COMMIT;
