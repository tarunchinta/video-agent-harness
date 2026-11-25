-- The web server's role, for a web server that runs apart from the worker
-- (`harness web --remote`). Design: docs/plans/web-ui.md, "Running the UI apart from the worker".
--
-- Run after 0001, as a member of harness_owner.
--
-- harness_web can read everything and write only what the creator may ask
-- for: create a run, answer a review, change a budget, ask for a resume, a
-- pause or a cancel, and its own x.web.* notes. A cancel of a run nobody is
-- driving closes its open spans, so it may also write the closing events
-- (*.failed, sandbox.completed) as the engine. It cannot take or extend a
-- lease, so it can never pass itself off as the worker, and it cannot write
-- model output, tool results or anything an agent says.

BEGIN;

SET LOCAL ROLE harness_owner;

GRANT USAGE ON SCHEMA harness TO harness_web;
GRANT SELECT ON harness.runs, harness.events, harness.artifacts, harness.spans, harness.schema_migrations TO harness_web;

-- Creating a run inserts its row and every append updates the projection.
-- The lease columns (lease_owner, lease_expires_at, epoch) are left out.
GRANT INSERT (
  run_id, title, config, last_seq, status, status_reason, stage, pending_gate, script_revision, cut_revision,
  failure, tokens_in, tokens_out, cost_micro_usd, active_ms, running_since, re_edits,
  max_tokens, max_cost_micro_usd, max_active_ms, max_re_edits, started_at, ended_at
) ON harness.runs TO harness_web;
GRANT UPDATE (
  title, last_seq, status, status_reason, stage, pending_gate, script_revision, cut_revision,
  failure, tokens_in, tokens_out, cost_micro_usd, active_ms, running_since, re_edits,
  max_tokens, max_cost_micro_usd, max_active_ms, max_re_edits, started_at, ended_at, updated_at
) ON harness.runs TO harness_web;

GRANT INSERT ON harness.events TO harness_web;

-- The owner (and members of harness_owner) bypass these policies.
ALTER TABLE harness.events ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_all ON harness.events TO harness_app USING (true) WITH CHECK (true);

CREATE POLICY web_read ON harness.events FOR SELECT TO harness_web USING (true);

CREATE POLICY web_append ON harness.events FOR INSERT TO harness_web WITH CHECK (
  (actor = 'creator' AND (
     type IN ('run.created', 'gate.decided', 'budget.updated',
              'run.resume_requested', 'run.pause_requested', 'run.cancel_requested')
     OR type LIKE 'x.web.%'))
  OR (actor = 'engine' AND (type LIKE '%.failed' OR type = 'sandbox.completed'))
);

INSERT INTO harness.schema_migrations (version) VALUES ('0002_web_role');

COMMIT;
