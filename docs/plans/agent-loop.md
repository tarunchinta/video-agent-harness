# Agent loop plan

This plan covers the agent loop described in [VISION.md](VISION.md): the code that calls a model, runs the tools it asks for, records what happened and decides when to stop. It is split into an MVP that holds every piece the loop cannot work without, and a Phase 2 of additions that make long runs cheaper and multi-agent runs possible.

Status: the MVP is built and tested. Phase 2 is not started. "What is built" and "What is not built yet" below say exactly where the line is.

## Scope

In this plan:

- The loop itself: steps, turns, stop conditions, retries.
- Tool dispatch: validation, policy, execution, results.
- Resuming and replaying a run from the event log.
- Budgets and review gates, enforced in code.
- The model provider interface and the first provider.
- The parts of context management the loop owns.

Covered by other plans, which this one follows:

- **Storage, the event envelope and event names**: [event-log-and-run-state.md](event-log-and-run-state.md). That plan is decided. Where an earlier draft of this plan said something different about the log, that plan wins and this one has been changed to match.
- **How tools and providers are registered and loaded**: [PLUGIN_CONTRACT.md](PLUGIN_CONTRACT.md).
- **Where agent-written code runs**: [docker-sandbox.md](docker-sandbox.md).

Not planned anywhere yet: the web UI, and the tool families for video understanding, research and rendering.

## What the vision asks of the loop

| Vision line | What it means for the loop |
|---|---|
| Own the loop, models are swappable | The loop is written here, by hand, and so is the HTTP call to the model. No agent SDK, no vendor SDK, no hosted agent runtime. |
| Code holds the gates, the model does the judgment | Budgets, schemas, tool policy and review gates are checked in code before each model call and each tool call. Nothing depends on the model choosing to comply. |
| Every run is replayable | The model's context, the terminal output, the cost report and resume are all computed from the run's event log. |
| Checkpoint and resume | A run can stop at a gate, crash or be paused, and continue in a new process. |
| Untrusted content stays contained | Scraped or retrieved text never enters the context of a model call that has tools. |
| Budgets: tokens, money, wall-clock time, re-edit count | Limits on tokens, cost, running time, steps and rounds, enforced by the loop. Re-edits are counted from stage events, which come later. |
| Traces: every model call, tool call, cost and artifact | The event log is the trace. There is no second record to keep in sync. |
| Milestone 1: a trivial run completes and replays | Done against a scripted model. Not yet run against the live API. |

## What is built

Three packages, with no vendor SDK in any of them.

| Package | What it holds |
|---|---|
| `packages/harness` (`@harness/harness`) | The loop (`Engine`), the event envelope and payload schemas, the run-state reducer, context building, tool dispatch, the built-in file tools and `finish`, budgets, gates, resume, tool-less extraction, and what the creator can write to a run (gate decisions, budget changes, pause, resume, cancel). Two event stores: in memory, and one JSON-lines file per run. |
| `packages/providers/model-claude` (`@harness/model-claude`) | Claude over plain HTTP: one streaming `POST /v1/messages` per call, with its own server-sent-event reader, message assembly, error mapping and price table. |
| `apps/harness-cli` (`@harness/cli`) | `harness run`, `resume`, `inspect`, `replay` and `cancel`. Run it with `pnpm harness`. |

`pnpm check` passes: 139 tests, of which 64 are in these three packages. They need no network and no key. They include a test that kills a run at every single write and resumes it, and a test that rebuilds every model request from the log and compares hashes.

## What is not built yet

- **The Postgres event store.** The loop talks to an `EventStore` interface whose rules are the ones in the event-log plan (gapless per-run `seq`, appends that name the head they expect, a worker lease with an epoch). The migration exists in `db/`; the store that uses it does not. Until then the CLI keeps runs in files.
- **A live run.** Everything was tested against a scripted model and against hand-written streams in the API's documented format. No request has been sent to the real API.
- **Checkpoints and artifacts.** `checkpoint.created` and `artifact.created` are not written. A large tool result is saved as a file and named by path on its event, not registered as an artifact. Restoring the working directory after a crash on another machine is therefore not possible yet.
- **Stages and the re-edit limit.** The loop runs one agent on one task. `stage.*` events, and the re-edit count the reducer derives from them, belong to the pipeline that will sit on top.
- **The sandbox.** Tools get the run's working directory, not a sandbox handle. There is no `run_command`.
- **Tool progress events** (`tool.call.progress`).
- Everything in Phase 2.

## Findings from research

**The runner this repo started from did not own its loop.** `packages/runner/src/llm.ts:330` hands the whole run to the Claude Agent SDK's `query()` or to `claude -p`, and reads back a stream of messages. Turn limits, tool execution and context handling all happen inside that dependency. This is the part the vision replaces. A few pieces around it were worth carrying over (see "What was reused").

**The DeepSeek harness** (the vision's reference for plugins) has the same shape as this plan and had already solved several problems the first draft got wrong. Its architecture docs, subsystem docs and agent-loop package were read from source on 16 November 2026. Three ideas from it underpin the loop:

- A session is divided into *turns* and *steps*.
- Events are either *durable* (appended to the log) or *live* (shown to observers while work is in progress, never needed again).
- "Model-visible means logged": every model request must be reconstructable from the log.

The section "Checked against the DeepSeek harness" lists what else was found and what changed because of it.

**Durable-execution writing agrees on four rules.** State is a fold over the log, and any snapshot is only a cache. Record the intent to run a side effect before running it, so a crash leaves evidence. Never repeat a side effect on resume unless it is safe to repeat. Read clocks and random values through one injected source, or replay will drift.

**The Claude API rewards append-only transcripts and punishes edits.** Three facts shape the design:

- Prompt caching is a prefix match. Changing the system prompt, the tool list or any earlier message makes every later token full price again.
- On current Claude models a thinking block is tied to the conversation that produced it. If the harness edits, reorders or removes an earlier message and then sends that thinking block back, the API can reject the request with a 400. On the default model this is enforced for accounts created from 31 August 2026, and on the newest tier for every account. Appending is always safe.
- Forced tool choice (`tool_choice` of `any` or a named tool) is rejected on the current Opus, Sonnet and Fable models. The loop cannot rely on forcing a tool call and must check that the call it needed was made.

The first two point the same way as the event log: if the transcript is only ever appended to, it stays cheap, valid and replayable. That is the central design choice.

Sources are listed at the end.

## Design decisions

| Decision | Choice | Why |
|---|---|---|
| How to call the model | Plain HTTP to the provider's messages endpoint, with a hand-written stream reader, inside a provider package | The vision rules out renting the loop, and the project's owner ruled out the vendor SDK as well. The provider makes one attempt per call and reports what went wrong; the loop decides what to retry, so every attempt is in the log and in the budget. |
| Event store | Postgres, as decided in the event-log plan. The loop only knows the `EventStore` interface | The memory and JSON-lines stores keep the same rules, so tests and local runs behave like the database will. |
| Transcript | Append-only. Never edit the system prompt, the tool list or an earlier message during an agent's life | Keeps the prompt cache warm, keeps thinking blocks valid, and makes the transcript a pure function of the log. |
| One model per agent | An agent keeps the model it started with | Switching models resets the cache and drops the previous model's thinking blocks. A different model means a different agent, which is what sub-agents are for. |
| Finishing | A `finish` tool, with automatic tool choice. A model that stops without calling it is sent back to work | Works on models that reject forced tool choice. |
| After a crash | Close what was in flight with error results and carry on. Never re-run a tool automatically | One rule for every case, and a tool with side effects can never run twice without the model deciding to. This is what the DeepSeek harness does. See "Differences to settle". |
| Unattended work | A run continues on its own only inside the process that was told to run it | A person authorises each restart. A crashed run never revives itself. |
| Compaction | Phase 2 | Current context windows are large enough for the MVP's runs. See "When the context fills up" for what the MVP does instead. |

## Checked against the DeepSeek harness

What its source does, and what this plan does about it.

| Topic | What the DeepSeek harness does | Here |
|---|---|---|
| Turns and steps | A step is one model request plus the tools it calls. A turn is zero or more steps. Both boundaries are durable events | Same idea. The event-log plan records them as spans, not as their own events |
| Request reconstruction | Logs the request header (call settings and full tool schemas). History is a pure projection of the log | Built. `agent.started` carries the full system prompt and tool schemas, and a test rebuilds every request from the log |
| Failed model attempts | Recorded with their token usage. They never enter model history | Built. `model.call.failed` keeps what was billed and counts toward budgets |
| Durability | A checkpoint policy flushes before a model request, before a top-level tool runs, and before the next step. A failed flush stops the operation | Built. Each of those points is an awaited append, and an awaited append is durable |
| Crash recovery | On resume the loop appends an error result for each unanswered tool call and closes what was open. Nothing is retried automatically | Built |
| Recovery wording | Two results: outcome unknown (the call started), and not started (safe to retry) | Built |
| Unattended continuation | A goal has an objective and a round limit. After a resume, nothing continues until a person re-arms it | Built as rounds |
| Retries | Five retries for empty response, rate limit, server, timeout and transport errors. Backoff from 500 ms to 10 s with 10% jitter. Honours `Retry-After`. The retry is logged before the wait. Nothing about a retry is shown to the model | Built |
| Tool scheduling | Each call is `parallel` or `exclusive`. Exclusive calls run alone and act as barriers. Parallel calls share a pool of 10 by default. Results are recorded in the model's order | Built |
| Tool policy | Plugin hooks run first and may change a call. Then guards run, which can only deny | Guards built. Hooks come with the plugin contract |
| Approval | A grant covers one call. Anything but an explicit approval denies. The audit events are log-only | Built for review gates. There is no per-tool prompt, as the plugin contract decided |
| Large results | Keeps the head and the tail, half the budget each, plus a notice with the size, the path and how to read it. If saving fails the full result stays in context. The read tool is exempt | Built |
| Context pressure | Starts from the prompt size the provider reported for the last request and adds an estimate for what changed since | Built |
| Compaction | Replaces the oldest span with a summary and keeps the newest 16% as is. Trims oversized tool results first. Wraps the operation in start and end events. Retries once after a real overflow | Phase 2, with one difference noted there |
| Sub-agents | Each child has its own session log. The child returns output, an optional structured value, a diagnostic and a stop reason | Phase 2. The event-log plan keeps one log per run, with an agent id on every event |
| Forking | Only at a closed turn | Phase 2. The event-log plan allows forks only at a checkpoint |
| Unknown events | A reader must refuse a log holding an event type it does not know, unless the event is marked ignorable | The event-log plan's rule is used instead: plugin types carry an `x.` prefix and can never change run state |
| Budgets | None built in; its docs list this as a known limitation | Differs. Budgets are core here because the vision requires them |
| Model changes mid-session | Allowed | Differs. One model per agent |
| Untrusted content | Nothing like a tool-less quarantine call in the docs read | Built here |

## Terms

- **Run**: one piece of work from start to finish. It has one event log and one working directory.
- **Agent**: one conversation with one model inside a run. The MVP has exactly one, called `main`. Every event carries an agent id, so sub-agents need no change to the log.
- **Turn**: everything from one input (the task, a note from the harness, a resume) until the model stops asking for tools.
- **Step**: one model call plus the tool calls it asked for.
- **Round**: one more turn started by the harness because the run's objective is not met yet. Rounds are counted and capped.
- **Span**: a unit of work with a start and an end in the log: the run, an agent, a model call, a tool call.
- **Durable event**: written to the log before the loop moves on. Resume depends on it.
- **Live event**: sent to whoever is watching (streamed text). Never written, never needed for resume.

## MVP

The MVP is a single-agent loop that is safe to leave running: it stops when told, stays inside its limits, survives a crash and can be replayed.

### 1. What the loop writes

The envelope, the event names and the run states are the ones in [event-log-and-run-state.md](event-log-and-run-state.md). The loop writes these:

| Event | Written when |
|---|---|
| `run.created` | The creator starts a run: the task, the model, the system prompt, the limits |
| `run.started`, `agent.started` | A worker first picks the run up |
| `run.resumed` | A worker picks it up again, with the reason (`crash`, `gate` or `unpaused`) and the spans that were cut off |
| `model.call.started` | Before each attempt at a model call |
| `model.call.completed` | The model answered: every content block as received, the stop reason, token usage, cost, timing |
| `model.call.failed` | An attempt failed, was cancelled, or its answer could not be used |
| `tool.call.started` | Before a tool runs, and durable before it can have any effect |
| `tool.call.completed`, `tool.call.failed` | A tool returned, or was refused, or failed. Exactly one per call |
| `context.message` | The harness says something to the model: a warning, a round prompt |
| `gate.opened`, `gate.decided` | A review gate |
| `budget.exceeded`, `budget.updated` | A limit was hit, or the creator changed one |
| `run.pause_requested`, `run.paused`, `run.resume_requested`, `run.cancel_requested` | Stopping and restarting |
| `agent.completed`, `run.completed` | The agent called `finish` |
| `agent.failed`, `run.failed` | The run ended for any other reason, with the reason as `error.kind` |

Fields the loop adds to the catalogue's payloads. Each is one the event-log plan's readers can ignore:

| Event | Added field | Why |
|---|---|---|
| `agent.started` | `system_prompt`, `tool_specs` | The catalogue stores only a hash of the prompt and the tool names. With the full text, a request can be rebuilt from the log alone |
| `model.call.started` | `step` | Which step of the agent this attempt belongs to |
| `model.call.failed` | `retry_in_ms` | The retry is on record before the wait starts |
| `model.call.completed` | `served_model`, `refusal` | Set when another model answered, or when the model declined |
| `context.message` | `kind` | Lets each warning be sent once, and rounds be counted |
| `gate.opened` | `tool_call_id` | Ties the gate to the call that asked for it, so the decision can become that call's result |
| `tool.call.completed` | `output_path` | Where the full text of a cut result was saved |

Rules the loop keeps:

- **State is a fold.** The conversation, budget totals, gate status and run status are computed from the log. There is no separate state to fall out of step.
- **Model-visible means logged.** Three things produce messages the model sees: the task on `agent.started`, `context.message`, and the model's own responses with the results of the tools it called. Everything else is a record only.
- **Write before acting.** `model.call.started` and `tool.call.started` are appended, and the append awaited, before the call they describe.
- **Store what the model sent, exactly.** Thinking blocks and their signatures go into `model.call.completed` untouched, because the provider checks them when they are sent back.
- **Store requests as a hash, not a copy.** The request can be rebuilt from the log, so `model.call.started` stores `request_sha256` and `context_through_seq`. A test rebuilds each request and compares.
- **One event per span end.** Every model call and tool call that starts gets exactly one closing event, whatever happens. The stores reject a second.

### 2. Model provider interface

Lives in `packages/harness/src/model/types.ts`. It uses its own types so that nothing vendor-specific reaches the loop.

```ts
interface ModelProvider {
  readonly id: string;
  capabilities(model: string): { contextWindow: number; maxOutputTokens: number };
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>; // text deltas, then one response
  priceMicroUsd(model: string, usage: Usage): number;
}

type ModelRequest = {
  model: string;
  system: string;            // fixed for the life of the agent
  tools: ToolSpec[];         // fixed for the life of the agent, sorted by name
  messages: Message[];       // append-only
  maxOutputTokens: number;
  effort?: string;
};

type StopReason = "end_turn" | "tool_use" | "max_output" | "paused" | "refusal";
```

Message content is a list of blocks: `text`, `tool_call`, `tool_result`, and `opaque`. An `opaque` block is anything provider-specific that must be returned unchanged, such as a thinking block. The loop stores and replays opaque blocks without reading them. A provider throws only `ModelError`, whose `kind` tells the loop whether another attempt can help.

Two providers exist:

**Scripted provider** (`@harness/harness/testing`). Answers from a list of responses or from a function of the request. Every loop test uses it.

**Claude provider** (`@harness/model-claude`). The settings that matter:

| Concern | What it does |
|---|---|
| Transport | `fetch` to `POST /v1/messages` with `stream: true`, read as server-sent events. No SDK |
| API version | `anthropic-version: 2026-10-21` |
| Default model | `claude-opus-5-5`, set by the CLI and recorded on the run |
| Thinking | Adaptive, with a readable summary returned. Effort is always sent (`high` unless the run sets one), because the model's own default is lower |
| Tool inputs | Streamed as they are generated (`eager_input_streaming`). The server then no longer checks them, so the loop validates each input against the tool's schema. Input that is not valid JSON is handed over as it arrived and fails that check |
| Caching | One cache breakpoint on the system prompt, automatic caching for the rest. Nothing in a request depends on the clock |
| Stop reasons | `max_tokens` becomes `max_output`, `pause_turn` becomes `paused`. A context-window stop is raised as an error, since there is no answer to use |
| Refusals | Stop reason `refusal`, with the category. The API's server-side fallback to another model is on by default; when it happens the answering model is recorded and the call is priced at that model's rates |
| Errors | HTTP status and the API's error type are mapped to the loop's kinds. `Retry-After` is passed on. A stream that ends early is a failed attempt, never a short answer |
| Timeouts | A stream that sends nothing for two minutes is given up |
| History check | An option for tests and CI asks the API to reject any request whose earlier turns changed |
| Prices | A table of per-model prices. It will go stale; check it against the published prices before trusting a budget |

### 3. The loop

One pass, in order:

1. **Fold the log** into run state and the agent's conversation.
2. **Check for requests from outside.** A cancel request ends the run. A pause request or an abort signal pauses it.
3. **If the model stopped without asking for tools**, decide what that means (rounds, below).
4. **Check the limits.** If one is used up, write `budget.exceeded` and `run.paused`, and stop.
5. **Say what needs saying.** A budget near its limit, or a context window filling up, gets one note to the model.
6. **Call the model.** Write `model.call.started`, stream the response, forward text to live listeners, write the result.
7. **Run the tools it asked for** (section 4), and go round again.

What each stop reason leads to:

| Stop reason | What the loop does |
|---|---|
| `tool_use` | Runs the calls and continues |
| `end_turn` | If `finish` was not called, starts another round |
| `max_output` | None of the response's tool calls run; each gets an error result saying it was cut off. With no tool calls, the model is told to continue. After three in a run, the run fails |
| `paused` | Sends the same conversation again so the provider can continue |
| `refusal` | Ends the run with `error.kind = refusal` |

**Retries.** Rate limits, server errors, timeouts, transport errors and empty responses are retried inside the same step, up to five times, with backoff from 500 ms to 10 s plus jitter. A `Retry-After` of up to two minutes replaces the local delay. Each attempt is its own span. Retries are never shown to the model. If an outage outlasts the retries the run is paused with the reason `error:<kind>`, so it can be picked up later. An error that retrying cannot fix, such as a rejected key, fails the run.

**Rounds.** The run's objective is that `finish` was called with a valid result. When a turn ends without it, the loop starts another with a note it writes itself, naming the task, the round number and the limit. The default limit is three. At the limit the run fails with `error.kind = round_limit`. A successful `finish` ends the run in the same write as its result, with no further model call.

**Loop guard.** If the model makes the same tool call with the same input three times in a row, the loop tells it once. At six, the run fails with `error.kind = stuck`.

**When the context fills up.** Before each call the loop projects the size of the next request: the prompt size the provider reported for the last one, plus an estimate for what has been appended since. With window `W` and output limit `O`, it warns the model once the projection passes `min(W × 0.8, W − O − headroom)`, and fails the run with `error.kind = context_exhausted` once it passes `W − O`. Nothing is summarised or dropped. Offloading large tool results (section 6) keeps most runs well below the limit.

**Notes from the harness.** Warnings and round prompts are `context.message` events. They are placed after all of a step's tool results, never between a call and its result. Each states the situation in full, not a change from the last note, so the newest one still makes sense if older ones are later summarised away.

**Responses too large to record.** An event payload is capped at 256 KB. A response over that is recorded as a failed attempt with its usage, and the model is told to send large content in smaller parts.

### 4. Tools and dispatch

The contract is `defineTool` in `packages/harness/src/tools/define.ts`:

```ts
defineTool({
  name: "render_cut",
  description: "…what it does and when to call it…",
  input: z.object({ … }),
  output: z.object({ … }),            // required when `untrusted`
  readOnly: false,      // changes nothing outside the run
  idempotent: false,    // safe to run twice with the same input
  parallelSafe: false,  // may overlap with neighbouring calls
  untrusted: false,     // reads content written by strangers
  requires: [gateApproved("script")],   // checked in code before the tool runs
  timeoutMs: 600_000,
  async execute(input, exec) { … },    // returns a value
  render(input, value) { … },          // what the model reads
});
```

Every call goes through the same steps:

1. **Record it.** `tool.call.started`, durable before anything else.
2. **Look it up.** Unknown name: an error result listing the tools that exist.
3. **Validate** the input with the tool's schema. Invalid: an error result with the reasons.
4. **Guards.** A tool turned off in config is refused. Each `requires` entry is checked against state from the log. A run at a token, cost or time limit runs nothing more. Guards can only refuse.
5. **Run** with a timeout and the abort signal.
6. **Check and shape the result.** Validate against `output` if declared, render it, apply the size cap (section 6).
7. **Record the outcome.** `tool.call.completed` or `tool.call.failed`.

Failures never crash the loop. A `ToolError` becomes an error result with its hint. Any other exception becomes a short generic error result, with the detail kept in the log and away from the model.

Calls in one response are taken in the order the model gave. A `parallelSafe` call may overlap with its neighbours, up to ten at once. Any other call runs alone and nothing after it starts until it finishes. Results always go back in the model's order, in one message.

Built-in tools: `read_file`, `write_file` and `list_files`, all confined to the run's working directory, and `finish`.

### 5. Budgets and gates

**Budgets.** Set when the run is created, changed with `budget.updated`:

| Limit | Counts |
|---|---|
| Tokens (`max_tokens`) | Prompt and output tokens across all model calls, cache reads included |
| Money (`max_cost_micro_usd`) | Model cost from the provider's price table |
| Running time (`max_active_ms`) | Time a worker is driving the run. Waiting at a gate or paused does not count |
| Steps (`max_steps`) | Model responses. Stops the next model call, not tools already asked for |
| Rounds (`max_rounds`) | Turns the harness started because `finish` was not called |

At 80% of a token, cost, time or step limit the loop tells the model once. At the limit it pauses the run. A run can overshoot by at most the one call that was in flight. The creator raises the limit and resumes.

**Gates.** A gate is a point where the run stops and waits for a person.

- A tool calls `exec.gate("script", payload)`. The loop writes `gate.opened` and returns. A waiting run uses no process, no tokens and no clock.
- The creator's answer is `gate.decided`: `approved`, `changes_requested` with notes, or `rejected`.
- On the next `run`, the decision becomes the result of the tool call that asked. A rejection ends the run in the same write as the decision.
- Tools that must not run before approval declare `requires: [gateApproved("script")]`. Dispatch enforces it, not the prompt.
- A gate never passes by default. The database allows two gate names, `script` and `final_cut`.

### 6. Working directory and large results

- **Size cap.** A tool result over about 12,000 tokens is saved in full to `tool-results/<call-id>.txt` in the working directory. The model sees the start and the end of it, half the allowance each, and a notice giving the size left out, the path and how to read it.
- **Best effort.** If the file cannot be written, the result stays in context. A successful tool call is never turned into an error by the cap.
- **`read_file` is exempt.** It has its own offset and limit, and capping it would send the model in circles.
- **Decided once.** What the model sees is fixed when the result is recorded and never rewritten later.

### 7. Resume and replay

**Resume** is calling `run` again. It never repeats work on its own.

A run that stopped cleanly is reported as it is, and nothing is written, until something changes: a waiting run needs its gate decided, a paused run needs a resume request.

Otherwise the loop first makes the log whole, by appending only:

1. A tool call that opened a gate which has since been decided gets the decision as its result.
2. Every other tool call that started but has no result gets an error result: the call was interrupted and its outcome is unknown. If the tool is marked read-only or idempotent the text says it is safe to call again. Otherwise it tells the model to check the current state first.
3. A tool call the model asked for that never started gets an error result saying so.
4. A model call that was in flight is closed as failed. Nothing from it reached the conversation.
5. `run.resumed` is written, and the loop carries on. The model sees the error results and decides what to do.

**Replay** reads the log and prints the same lines the live run printed, with no model calls and no tool calls.

**Lease.** One worker drives a run at a time. It takes a lease that lasts a minute and renews it on a timer. A crashed worker's lease runs out on its own, and writes from a worker that lost the lease are refused.

### 8. Tool-less calls for untrusted content

A tool marked `untrusted` (web fetch, retrieved posts) must declare the shape of what it returns, and gets the text through `exec.extract`:

```ts
const facts = await exec.extract({
  instructions: "List the factual claims this page makes.",
  untrusted: pageText,
  schema: z.object({ claims: z.array(z.object({ text: z.string().max(200) })).max(10) }),
});
```

`exec.extract` makes one model call with no tools and a fixed system prompt that says the text is data, not instructions. The answer must parse as JSON and match the schema. Only that value goes back to the tool. The call is logged under its own agent id, marked untrusted, and paid for from the run's budget. Context building refuses any event marked untrusted.

This limits what injected text can do. It does not remove the risk: a string field can still carry a misleading sentence. Short length limits on string fields keep that small.

### 9. CLI

| Command | Does |
|---|---|
| `harness run --task "…" [--model …] [limits]` | Starts a run and prints what it does |
| `harness resume <run-id> [--approve \| --changes "…" \| --reject] [limits]` | Answers a gate, raises limits, and continues a waiting, paused or crashed run |
| `harness inspect <run-id>` | Status, and cost and time for each model call and tool call |
| `harness replay <run-id>` | Plays the recorded run back |
| `harness cancel <run-id>` | Ends a run for good |

Limits are `--max-usd`, `--max-tokens`, `--max-minutes`, `--max-steps` and `--max-rounds`. `Ctrl-C` pauses the run after the current step. The exit code is 0 when the run finished, 2 when it is waiting on the creator, and 1 otherwise. Runs are kept under `./runs`.

### Definition of done

| Check | State |
|---|---|
| A run writes a file, reads it back and finishes; `replay` shows the same lines; `inspect` shows cost per call | Done, against scripted streams |
| The same, against the live API | Not done |
| Every model request repeats the one before it and only adds to it | Tested in the loop, and at the level of the bytes sent to the API |
| Any model request can be rebuilt from the log alone | Tested |
| Killing the process at any write and resuming leaves every tool call with one result, and the run still finishes. Resume itself never runs a tool | Tested at every write of a run with four model calls and five tool calls |
| No run exceeds a budget by more than one in-flight call | Tested for tokens and steps |
| A tool behind a gate cannot run before approval | Tested with a model that tries |
| Cache reads show up from the second step of a live run | Not checked: needs a live run |
| All tests run without network access | Yes |

## Differences to settle

Three plans describe what happens to a tool call that was in flight when a run stopped, and they do not agree:

| Plan | Rule |
|---|---|
| Event log (decided) | Run it again if the tool is marked idempotent. Otherwise leave it to the agent |
| Plugin contract | An interrupted call that is not idempotent stops the run for a person |
| This plan, and the code | Never run it again automatically. Tell the model what happened, including whether the tool is safe to repeat, and let it decide |

The code follows the third because it is the DeepSeek harness's rule and the simplest to reason about: a tool only ever runs because a model asked for it in a response that is in the log. Changing to either of the others is a small change in `Engine.repair`.

Two smaller ones:

- **The event-log plan pauses a run on a budget; it has no reason for an outage.** The loop also pauses with `error:<kind>` when the model cannot be reached after retries, so the run can be picked up later instead of failing.
- **Run-ending reasons.** The loop uses these `error.kind` values on `run.failed`: `cancelled`, `refusal`, `round_limit`, `stuck`, `max_output`, `context_exhausted`, and the model error kinds `auth` and `invalid_request`. The event-log plan does not list kinds.

## Phase 2

Additions that are not needed for a correct run. Suggested order follows the vision's milestones.

| Item | What it adds | Depends on |
|---|---|---|
| **Postgres event store** | The store the event-log plan describes, behind the existing interface, with artifacts and checkpoints | The migration in `db/` |
| **Sub-agents** | An orchestrator starts child agents (researcher, scriptwriter, editor, critic) with their own context, tool set and model. A child returns its final message, an optional structured value checked against a schema, a short diagnostic and a stop reason. Anything but a normal finish reaches the parent as an error result. The child's transcript stays out of the parent's context. Budgets are carved from the parent's, depth is limited, and children can run at the same time | Agent ids in the log |
| **Compaction** | When an agent nears its window, trim oversized old tool results first, which costs no model call and may be enough. If not, summarise the conversation into one message and start a fresh context from it. Written as `context.compacted`. Done only between steps, never while a tool call is waiting for its result. Also runs once, then retries, when the provider rejects a request as too long | The context thresholds |
| **Clearing old tool results** | Drop the bodies of old tool results while keeping the calls. On Claude this is done by the API's own context editing, which does not count as a history edit | Provider capability flag |
| **Second model provider** | Gemini, plus a conformance test suite that every provider must pass | Provider interface |
| **MCP tools** | Tools from an MCP server appear in the registry like any other tool. Needed for the Distill reference library in milestone 2 | Tool contract |
| **Steering** | Send a message to a running agent, cancel one tool call | `context.message` |
| **Live stream for the web UI** | Events pushed as they are written, with catch-up from any `seq` | The event store |
| **Background tools** | A long render runs as a job the model can start, check and wait on, instead of holding a step open | Dispatch |
| **Forking a run** | Start a new run from a checkpoint of an old one. This is how the ablations in the eval suite share a common start | Checkpoints |
| **Hooks for plugins** | Fixed points where a plugin can observe, change or veto: before a step, around a model request, after a failed request, before and after a tool call, and when a turn is about to stop. Hooks run before the guards in dispatch and cannot loosen them | The plugin contract |
| **Deferred tool loading** | Keep rarely used tool schemas out of the context until the model searches for them | Many tools existing |
| **Trace export** | OpenTelemetry spans generated from the log | The event store |
| **Memory across runs** | Lessons from past runs available to new ones | The vision's Learn stage |

Notes on the two most likely to be pulled forward:

- **Sub-agents** change who owns a tool call, not how one runs. Every event already carries an agent id, and every model and tool call already goes through one path, so a `spawn_agent` tool is mostly new code.
- **Compaction** is the only planned feature that breaks the "each request repeats the one before" test, and only at the point of compaction. The test should treat `context.compacted` as the start of a new prefix.
- **Keeping recent turns.** The DeepSeek harness keeps the newest 16% of the window word for word and summarises the rest. On Claude, turns kept that way cannot carry their thinking blocks, because those are tied to the full history that came before them. The choice is between summarising everything, which is the default proposed here, and keeping recent turns with their thinking removed. Worth measuring on real runs before deciding.

## What was reused

| From | Reused | How |
|---|---|---|
| `packages/core/src/tools.ts` | The shape of `ToolDefinition`, `defineTool` and `ToolError` | Rewritten in `tools/define.ts` with the flags the loop needs |
| `packages/core/src/providers.ts:13` | The error codes of `ProviderError` | The model for `ModelError` kinds |
| `packages/runner/src/budget.ts` | The budget rule as a pure function | Same idea in `budget.ts`, with the run's own limits |
| `packages/runner/src/llm.ts:49`, `:69` | The tool-less system prompt and JSON parsing | Copied into `extract.ts` |
| `packages/runner/src/llm.ts:108` | Keeping the clock out of the system prompt | Same rule |

Not reused: `runLlmJob`, the `claude -p` engine, the job queue and `EventSink`. They are built around a loop that lives in a dependency.

## Layout

```
packages/harness/
  src/engine.ts                 the loop: start, repair, rounds, limits, model calls
  src/context.ts                the conversation, built from events
  src/creator.ts                what the creator writes: create, gates, budgets, pause, cancel
  src/budget.ts                 the limit rule
  src/extract.ts                tool-less extraction
  src/inspect.ts                the cost and time summary
  src/events/                   envelope and payload schemas, reducer, stores
  src/model/types.ts            the provider interface
  src/tools/                    contract, dispatch, built-in tools
  src/testing/                  scripted provider, a store that dies on cue
packages/providers/model-claude/
  src/provider.ts               the HTTP call
  src/sse.ts                    the stream reader
  src/wire.ts                   to and from the API's shapes
  src/models.ts                 prices and limits per model
apps/harness-cli/
  src/main.ts, render.ts        commands, and events as plain lines
```

## Open questions

1. **A first live run.** It needs an API key and spends a few cents. It is the one check that proves the stream format assumptions and shows cache reads.
2. **Thinking summaries.** On by default in the provider. They make a recorded run easier to follow and cost nothing extra.
3. **Fallback on refusal.** On by default in the provider, and visible in the trace. Turning it off is one option.
4. **Partial output on cancel.** The DeepSeek harness keeps the text already streamed when a call is cancelled, so the next request contains what the user saw. This loop drops it, since nobody reads the stream during an unattended run. Worth revisiting when the web UI shows runs live.
5. **Node version on this machine.** The repo needs Node 22.18 or later and the tests need it too. The machine the code was written on has Node 20, so the tests were run on a separate copy of Node 24.

## Sources

- [VISION.md](VISION.md), [event-log-and-run-state.md](event-log-and-run-state.md), [PLUGIN_CONTRACT.md](PLUGIN_CONTRACT.md), and the reference runner in `packages/runner/`.
- Claude API documentation on the Messages API, streaming, tool use, prompt caching, stop reasons, errors, compaction, context editing and preserved thinking: <https://platform.claude.com/docs>.
- DeepSeek harness source (`deepseek-ai/deepseek-harness`, read from a fork): `docs/architecture.md`, `docs/agent-lifecycle.md`, `docs/tool-execution-pipeline.md`, `docs/glossary.md`, `docs/subsystems/` (`core`, `session`, `persistence`, `tools`, `approval`, `spill`, `token-meter`, `compaction`, `subagent`, `goal`), and the READMEs of `packages/core/agent-loop`, `packages/llm/llm-retry`, `packages/session/session-checkpoint-policy`, `packages/spill/spill-policy`, `packages/compaction/compaction-basic` and `packages/goal/goal-round-driver`.
- Durable execution for agents: [event sourcing and replay](https://loopy.js.org/core-concepts/event-sourcing/), [write-ahead logging for agents](https://tianpan.co/blog/2026/04/12/write-ahead-logging-for-ai-agents-crash-safe-execution), [checkpoints and the event log](https://prod.stately.ai/docs/packages/agent/checkpoints), [durable state and resumability](https://agentic-ai-wiki.vercel.app/operations/agentops/durable-state-and-resumability/).
