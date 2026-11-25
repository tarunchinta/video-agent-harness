# Agent loop plan

This plan covers the agent loop described in [VISION.md](VISION.md): the code that calls a model, runs the tools it asks for, records what happened and decides when to stop. It is split into an MVP that holds every piece the loop cannot work without, and a Phase 2 of additions that make long runs cheaper and multi-agent runs possible.

Status: the MVP is built and tested, and so is the first pipeline on top of it: stages, the sandbox, pictures in tool results and the reel tools (section 10 and "The reel pipeline"). It has run against a live model through the OpenAI-compatible provider, including one reel taken to an approved cut. The Claude provider has only been tested against recorded streams. From Phase 2, a second model provider and the Postgres event store are built. A first critic, web search and the plugin contract were added on 17 November 2026. "What is built" and "What is not built yet" below say exactly where the line is, and [STATUS.md](STATUS.md) is the summary across all the plans.

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

Not planned anywhere yet: the tool family for video understanding. A first web UI is built in `packages/web`, behind `harness web`; [web-ui.md](web-ui.md) covers it. Research and rendering have a first version, described under "The reel pipeline".

## What the vision asks of the loop

| Vision line | What it means for the loop |
|---|---|
| Own the loop, models are swappable | The loop is written here, by hand, and so is the HTTP call to the model. No agent SDK, no vendor SDK, no hosted agent runtime. |
| Code holds the gates, the model does the judgment | Budgets, schemas, tool policy and review gates are checked in code before each model call and each tool call. Nothing depends on the model choosing to comply. |
| Every run is replayable | The model's context, the terminal output, the cost report and resume are all computed from the run's event log. |
| Checkpoint and resume | A run can stop at a gate, crash or be paused, and continue in a new process. |
| Untrusted content stays contained | Scraped or retrieved text never enters the context of a model call that has tools. |
| Budgets: tokens, money, wall-clock time, re-edit count | Limits on tokens, cost, running time, steps, rounds and re-edits, enforced by the loop. Re-edits are counted from stage events (section 10). |
| Traces: every model call, tool call, cost and artifact | The event log is the trace. There is no second record to keep in sync. |
| Milestone 1: a trivial run completes and replays | Done against a scripted model, and a trivial run has completed against a live model through the OpenAI-compatible provider. Not yet run against the Claude API. |

## What is built

Ten packages, with no vendor SDK in any of them.

| Package | What it holds |
|---|---|
| `packages/harness` (`@harness/harness`) | The loop (`Engine`), the event envelope and payload schemas, the run-state reducer, context building, tool dispatch, the built-in file tools and `finish`, budgets, gates, resume, tool-less extraction, and what the creator can write to a run (gate decisions, budget changes, pause, resume, cancel). Two event stores: in memory, and one JSON-lines file per run. |
| `packages/providers/model-claude` (`@harness/model-claude`) | Claude over plain HTTP: one streaming `POST /v1/messages` per call, with its own server-sent-event reader, message assembly, error mapping and price table. |
| `packages/providers/model-openai-compatible` (`@harness/model-openai-compatible`) | Any API that speaks the OpenAI chat format, the same way: one streaming `POST /chat/completions` per call, its own stream reader, and a model table with one entry. |
| `packages/reel` (`@harness/reel`) | The reel pipeline: the stage tool, research over the web (`web_fetch`, and `web_search` when a search plugin is loaded), the two review gates, voiceover timing, the critic (`review_cut`), and the film kit that draws stills, renders a cut and measures it inside the sandbox. |
| `packages/contract` (`@harness/contract`) | The plugin contract's milestone 1 cut: `definePlugin`, a loader that boots all or nothing in dependency order, scoped effects, the `models`, `sandbox`, `search` and `tools` seams, and the conformance kits every provider passes. See [PLUGIN_CONTRACT.md](PLUGIN_CONTRACT.md), section 13 |
| `packages/store-postgres` (`@harness/store-postgres`) | The event log in Postgres, behind the same `EventStore` interface, and `migrate()` for the files in `db/`. See [event-log-and-run-state.md](event-log-and-run-state.md), "Built so far" |
| `packages/providers/search-brave`, `search-searxng` | Web search over plain HTTP, behind the loop's `SearchProvider` interface. SearXNG needs no key |
| `apps/harness-cli` (`@harness/cli`) | `harness reel`, `run`, `resume`, `inspect`, `replay`, `cancel`, `plugins` and `web`. Run it with `pnpm harness`. It boots its providers, search and sandbox from a plugin profile (`src/plugins.ts`), and keeps the log in files unless `HARNESS_STORE=postgres`. |

The sandbox driver, `packages/sandbox-docker`, has its own plan: [docker-sandbox.md](docker-sandbox.md). `packages/web`, the web UI that `harness web` serves, is being built and has no tests yet.

The suite passes: 182 tests when last counted, on 16 November 2026. [STATUS.md](STATUS.md) keeps the current figure. They need no network, no key and no Docker. Seventeen more are off by default and run against real containers (`HARNESS_SANDBOX_IT=1`); one of them renders a real film in the real sandbox. The suite includes a test that kills a run at every single write and resumes it, and a test that rebuilds every model request from the log and compares hashes. `pnpm check` runs the typecheck (`tools/typecheck.mjs`, which calls `tsc` in every package without going through a package manager), Biome's lint and the tests, and CI runs the same on every push and pull request, plus the Postgres store's tests against a real Postgres 18 (`.github/workflows/check.yml`).

### Live runs

Three, all on 16 November 2026 with `DeepSeek-V4.1-Flash` through the OpenAI-compatible provider. Their logs are under `runs/`, which is not committed.

- **A trivial run.** It wrote a file, read it back and finished, in three model calls.
- **A ten-second reel, finished.** Research, script, stand-in timing, two cuts. The creator sent the first cut back with notes and approved the second. 62 model calls, about $0.44 at the model table's estimated prices.
- **The same brief again, failed.** The script went back once and was then approved. After the first cut the agent started a re-edit on its own judgement, and the run ended with `context_exhausted` after 64 model calls. The model's window is 128,000 tokens.

Both reels were made without a voiceover, so no recording was timed inside a run. The provider reported cached prompt tokens in all three runs.

## What is not built yet

- **A live run on Claude.** The Claude provider was tested against a scripted model and against hand-written streams in the API's documented format. No request has been sent to the real Claude API. The live runs so far went through the OpenAI-compatible provider (see "Live runs").
- **Checkpoints and artifacts.** `checkpoint.created` and `artifact.created` are not written. A large tool result is saved as a file and named by path on its event. Pictures shown to the model are stored by hash in the run's `artifacts` folder and named on the tool's closing event. A rendered cut is named, with its hash, on the gate that hands it in. None of these is registered as an artifact row yet, and restoring the working directory after a crash on another machine is not possible.
- **A reel with a real voiceover, made by a live model.** A live model has taken a reel to an approved cut, but with stand-in timing and no voice. Timing a real recording has only been checked by hand, outside a run.
- **A critic that watches video.** `review_cut` measures the rendered file in code and has a tool-less model call score a timeline sheet of frames against a rubric. No video model watches the cut, and the rubric is not yet calibrated on the creator's saved reels.
- **Search cost in the budget.** A search provider's own charges are not metered; only model calls count against the money limit.
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
| After a crash | Close what was in flight with error results and carry on. Never re-run a tool automatically | One rule for every case, and a tool with side effects can never run twice without the model deciding to. This is what the DeepSeek harness does. See "Differences settled". |
| Unattended work | A run continues on its own only inside the process that was told to run it | A person authorises each restart. A crashed run never revives itself. |
| Compaction | Built, for runs created with it | Left out of the MVP on the assumption that current context windows are large enough. One live reel on a 128,000-token model then ran out of room (see "Live runs"), so it was pulled forward. See "When the context fills up". |

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
| Compaction | Replaces the oldest span with a summary and keeps the newest 16% as is. Trims oversized tool results first. Wraps the operation in start and end events. Retries once after a real overflow | Built, with two differences: a summary replaces everything after the task (no turns are kept word for word), and each compaction is one event rather than a span |
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
| `stage.started`, `stage.completed`, `stage.failed` | A tool starts a stage, the next stage starts or the run ends |
| `sandbox.started`, `sandbox.completed` | A tool first asks for the sandbox; the worker lets go of the run |
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
| `tool.call.completed` | `images` | The pictures shown with the result, each by hash, type and size |
| `run.created` | `config.pipeline`, `config.sandbox_network` | What the run was started as, so every worker that picks it up builds the same tools and sandbox |
| `run.paused` | `detail` | What went wrong, when the reason is an error |

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

Three providers exist:

**Scripted provider** (`@harness/harness/testing`). Answers from a list of responses or from a function of the request. Every loop test uses it.

**Claude provider** (`@harness/model-claude`). The settings that matter:

| Concern | What it does |
|---|---|
| Transport | `fetch` to `POST /v1/messages` with `stream: true`, read as server-sent events. No SDK |
| API version | `anthropic-version: 2026-10-21` |
| Default model | `claude-opus-5-5`, unless `MODEL_NAME` or `--model` names another. Set by the CLI and recorded on the run |
| Thinking | Adaptive, with a readable summary returned. Effort is always sent (`high` unless the run sets one), because the model's own default is lower |
| Tool inputs | Streamed as they are generated (`eager_input_streaming`). The server then no longer checks them, so the loop validates each input against the tool's schema. Input that is not valid JSON is handed over as it arrived and fails that check |
| Caching | One cache breakpoint on the system prompt, automatic caching for the rest. Nothing in a request depends on the clock |
| Stop reasons | `max_tokens` becomes `max_output`, `pause_turn` becomes `paused`. A context-window stop is raised as an error, since there is no answer to use |
| Refusals | Stop reason `refusal`, with the category. The API's server-side fallback to another model is on by default; when it happens the answering model is recorded and the call is priced at that model's rates |
| Errors | HTTP status and the API's error type are mapped to the loop's kinds. `Retry-After` is passed on. A stream that ends early is a failed attempt, never a short answer |
| Timeouts | A stream that sends nothing for two minutes is given up |
| History check | An option for tests and CI asks the API to reject any request whose earlier turns changed |
| Prices | A table of per-model prices. It will go stale; check it against the published prices before trusting a budget |

**OpenAI-compatible provider** (`@harness/model-openai-compatible`). For any server that speaks the OpenAI chat format. The CLI uses it for every model whose name does not start with `claude-`, and reads the server's address and key from `MODEL_BASE_URL` and `MODEL_API_KEY`.

| Concern | What it does |
|---|---|
| Transport | `fetch` to `POST <base URL>/chat/completions` with `stream: true`, read as server-sent events. No SDK |
| Models | A table by deployment name, with one entry: `DeepSeek-V4.1-Flash`, a 128,000-token window and 32,000 tokens of output. A model that is not in the table is refused; the caller can pass more entries |
| Reasoning | Kept as an opaque block. Sent back on later turns only when the provider is told to, which is off by default |
| Stop reasons | `length` becomes `max_output`, `content_filter` becomes `refusal`. A response with tool calls that was not cut off is `tool_use` |
| Usage | Asked for on the stream (`include_usage`). Cached prompt tokens are read from `prompt_tokens_details` |
| Errors | A request the server rejects as too long becomes the loop's context-overflow error. A stream that sends nothing for two minutes is given up |
| Prices | The one entry is an estimate, not a published price list |

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
| `max_output` | None of the response's tool calls run; each gets an error result saying it was cut off. With no tool calls, the model is told to continue. The third cut-off response in a run, with tool calls or without, fails it |
| `paused` | Sends the same conversation again so the provider can continue |
| `refusal` | Ends the run with `error.kind = refusal` |

**Retries.** Rate limits, server errors, timeouts, transport errors and empty responses are retried inside the same step, up to five times, with backoff from 500 ms to 10 s plus jitter. A `Retry-After` of up to two minutes replaces the local delay. Each attempt is its own span. Retries are never shown to the model. If an outage outlasts the retries the run is paused with the reason `error:<kind>`, so it can be picked up later. An error that retrying cannot fix, such as a rejected key, fails the run.

**Rounds.** The run's objective is that `finish` was called with a valid result. When a turn ends without it, the loop starts another with a note it writes itself, naming the task, the round number and the limit. The default limit is three. At the limit the run fails with `error.kind = round_limit`. A successful `finish` ends the run in the same write as its result, with no further model call.

**Loop guard.** If the model makes the same tool call with the same input three times in a row, the loop tells it once. At six, the run fails with `error.kind = stuck`.

**When the context fills up.** Before each call the loop projects the size of the next request: the prompt size the provider reported for the last one, plus an estimate for what has been appended since. With window `W` and output limit `O`, the warning line is `min(W × 0.8, W − O − headroom)` and the stop line is `W − O`.

For a run created with `config.compaction` (the CLI sets it on every new run), passing the warning line between steps makes the conversation smaller, in at most two moves between two model responses, and never while a tool call is waiting for its result:

1. **Trim.** Successful tool results over 2,000 characters (or carrying pictures) are cleared, oldest first, until the projection is about 60% of the stop line. Results from the newest four model responses are not cleared. Each cleared result keeps its first 300 characters and a pointer to its full text in `tool-results/`; a result whose text cannot be saved is left as it is. Thinking and other opaque blocks before the last cleared result are dropped, because they are tied to the history that just changed. This costs no model call. It is written as `context.compacted` with `mode: "trim"`, and the projection stays anchored on the provider's last measurement, minus what was cleared.
2. **Summary**, if the conversation is still over the line. A tool-less call (agent `main/compactor`, purpose `compact`, paid from the run's budget) reads the conversation as text, with each block cut to a preview, and writes notes under fixed headings. Code then adds facts read from the log, not from the model: the stage and revision, the re-edits used, every review decision, the creator's notes word for word, and what was last handed in. The result is written as `context.compacted` with `mode: "summary"`, and the conversation becomes the task plus that summary.

A request the provider rejects as too long gets one summary and is tried again; a second rejection fails the run. If the summary cannot be made, nothing is lost: the loop warns the model once past the warning line, as runs without compaction always do, and fails the run with `error.kind = context_exhausted` past the stop line. `context.compacted` is a pure input to the context fold, so every request still rebuilds from the log; it starts a new request prefix, which is the one place a request does not repeat the one before.

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
| Re-edits (`max_re_edits`) | Revisions of the edit the agent started on its own judgement. At the limit a further one is refused, and the agent is told to hand the cut in. Revisions the creator asked for do not count |

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
| `harness reel --topic "…" [--seconds 60] [--source <url>]… [--notes <path>] [--network none\|public] [--model …] [limits]` | Starts a reel: research, script, voiceover, film, with the two reviews |
| `harness run --task "…" [--sandbox] [--model …] [--system "…"] [limits]` | Starts a plain run and prints what it does. `--sandbox` adds `run_command` and `view_image` |
| `harness resume <run-id> [--approve \| --changes "…" \| --reject] [limits]` | Answers a gate, raises limits, and continues a waiting, paused or crashed run. Approving a reel's script also takes `--voiceover <file>` or `--no-voiceover` |
| `harness inspect <run-id>` | Status, and cost and time for each model call and tool call |
| `harness replay <run-id>` | Plays the recorded run back |
| `harness cancel <run-id>` | Ends a run for good |
| `harness web [--port 4321]` | Serves the web UI, which is still being built, over the same runs |

Limits are `--max-usd`, `--max-tokens`, `--max-minutes`, `--max-steps`, `--max-rounds` and `--max-re-edits` (2 for a reel unless set). `Ctrl-C` pauses the run after the current step. The exit code is 0 when the run finished, 2 when it is waiting on the creator, and 1 otherwise. Runs are kept under `./runs`, or wherever `--runs-dir` or `HARNESS_RUNS_DIR` says.

The model is `--model`, or `MODEL_NAME`, or `claude-opus-5-5`. A Claude model needs `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL` points the same API at another host. Any other model needs `MODEL_BASE_URL` and `MODEL_API_KEY`.

### 10. Stages, the sandbox and pictures

Three additions the first pipeline needed. Each is a mechanism in the loop; what uses it lives in `packages/reel`.

**Stages.** A tool calls `exec.enterStage(stage, { reviewGate })`. The loop closes the stage that is open and starts the new one in one write. Starting a stage again starts its next revision, and the loop reads the reason from the log: the first start is the `plan`; a later one is the `creator` if the named review came back with changes since the last start, and a `critique` otherwise. The reducer counts revisions of `edit` with the trigger `critique` as re-edits, as the event-log plan says, and the loop refuses another once `max_re_edits` is reached. `inStage("edit")` is a precondition like `gateApproved`: dispatch checks it, not the prompt. `exec.gate(name, payload, { completeStage: true })` closes the stage in the same write that opens the gate. An open stage is closed when the run ends, whatever the reason.

**The sandbox.** The loop knows a `SandboxSession` (`exec`, `stop`) and a factory that starts one; the Docker driver fits the shape and the loop never imports it. `exec.sandbox()` starts it the first time a tool asks, and `sandbox.started` records the image and container. The sandbox lives only while a worker drives the run: the write that lets go of the run (a gate, a pause, the end) removes the container first and puts `sandbox.completed` ahead of itself in the same batch. After a crash the next worker closes the dead sandbox's span as `interrupted`. If the sandbox cannot be started, the tool call fails, the run pauses with the reason `error:sandbox`, and nothing is spent on a model that cannot fix it. `run_command` is the general tool: an argument list, no shell, a folder inside `/work`, a timeout.

**Pictures.** A tool lists pictures to show with its result (`images`). Dispatch copies each into the run's `artifacts` folder under the hash of its bytes, and the closing event names it by hash, type and size. The conversation built from the log carries the same references, so the request hash is still a function of the log alone. The bytes are read back and added only on the request handed to the provider. A picture that cannot be attached (not an image, too large, or one more than the conversation's limit of 60) becomes a sentence in the result and never fails the call. One that has gone missing later is said so in words. `view_image` is the general tool.

What this leaves open:

- **Network and the trust rule.** A sandbox started with `--network public` lets agent-written code fetch pages, and what that code prints goes back to the agent as a tool result. That is untrusted text in a context that has tools. The default is `none`, and research goes through `web_fetch`. A run that needs downloads in the sandbox takes that risk knowingly until results can be marked by where their text came from.
- **A sandbox that dies mid-run** is not restarted. The call fails and the run carries on without one until the next worker.

### Definition of done

| Check | State |
|---|---|
| A run writes a file, reads it back and finishes; `replay` shows the same lines; `inspect` shows cost per call | Done, against scripted streams |
| The same, against a live API | Done through the OpenAI-compatible provider: the run wrote a file, read it back and finished. Not done on the Claude API |
| Every model request repeats the one before it and only adds to it | Tested in the loop, and at the level of the bytes sent to the API |
| Any model request can be rebuilt from the log alone | Tested |
| Killing the process at any write and resuming leaves every tool call with one result, and the run still finishes. Resume itself never runs a tool | Tested at every write of a run with four model calls and five tool calls |
| No run exceeds a budget by more than one in-flight call | Tested for tokens and steps |
| A tool behind a gate cannot run before approval | Tested with a model that tries |
| Cache reads show up from the second step of a live run | Seen through the OpenAI-compatible provider: cached prompt tokens were reported in every live run. Not checked on Claude, where the cache breakpoint is the provider's own |
| All tests run without network access | Yes |
| A stage's tools are refused until the stage is open; the run cannot finish before the final cut is approved | Tested with a model that tries |
| The sandbox is removed whenever the run stops, and its record is closed even after a crash | Tested |
| A request that carries pictures still rebuilds from the log to the recorded hash | Tested |
| The film kit draws stills and renders a cut with sound in the real sandbox | Checked with `HARNESS_SANDBOX_IT=1`: 1080 by 1920, 30 frames a second, H.264 and AAC |
| A voiceover is timed word by word in the real sandbox, with no network | Checked by hand on the recording in `projects/`: 156 words in 34 seconds, numbers kept whole, and a film rendered with the voice at -1.5 dB peak. No automated test, because a test needs speech and the repo holds no fixture of any |
| A live model takes a reel from a topic to an approved cut | Done once, through the OpenAI-compatible provider, with stand-in timing and no voice. A second run of the same brief ran out of context |

## The reel pipeline

One agent, four stages, two reviews. The agent says which stage it is starting; code decides whether it may, and each stage's instructions come back as the result of starting it.

| Stage | Tools | Ends when |
|---|---|---|
| `research` | `web_fetch`, `run_command`, the file tools | The script stage starts |
| `script` | `web_fetch`, the file tools, `submit_script` | `submit_script` opens the `script` gate |
| `assets` | `prepare_voiceover` | The edit stage starts |
| `edit` | the file tools, `render_stills`, `render_film`, then `review_cut` and `submit_cut` | `render_film` succeeds. Each full render is one revision of the cut |

| Tool | What it does | What code enforces |
|---|---|---|
| `start_stage` | Starts a stage, or the next revision of one | `assets` and `edit` need the script approved; `edit` needs word timings; a self-started revision of the edit needs a re-edit left |
| `web_fetch` | Fetches one public page for one question | The page goes only to a tool-less call; the agent gets up to twelve short facts in a checked shape. Private and local addresses are refused on every redirect, and the connection goes to the address that was checked, so a name that changes its answer cannot reach a private one. The citation is the page that was read, after redirects |
| `web_search` | Finds pages about one question, when a search plugin is loaded | The listing goes only to a tool-less call, which picks results by number; the addresses come from the listing in code, so none can be invented |
| `submit_script` | Hands `script/script.md` and `script/narration.txt` to the creator | Both exist; the narration is 25 to 520 words in caption-sized lines |
| `prepare_voiceover` | Times the creator's recording word by word (faster-whisper in the sandbox), trims the silence before the first word and lists where what was heard differs from the narration. Called again with `corrections`, it puts right what was misheard without timing the recording again. With no recording it makes stand-in timing | Script approved |
| `render_stills` | Draws frames of the film and shows the agent one contact sheet | Script approved, edit open |
| `render_film` | Renders the cut with voice and sound effects, keeps it as `cuts/cut-<n>.mp4`, shows a contact sheet cut from the file, and closes the revision | Script approved, edit open |
| `review_cut` | The critic: measures the file in the sandbox (black or frozen picture, the hook, the ending, the sound), then a tool-less call scores a timeline sheet against the rubric. Writes `cuts/review-<n>.json` | Code decides the pass: no failing check, no score under 3, an average of at least 3.5 |
| `submit_cut` | Hands the latest cut to the creator, with its hash and its review | A cut exists and no unrendered revision is open. For reels created with the critic, the cut has a review, and a failing one goes in only once no revisions of the agent's own are left |
| `finish` | Ends the run | The final cut is approved |

**The film kit** (`packages/reel/kit`) is the render path, taken from the reel in `projects/paxton-talarico-400k`. A film is one HTML page that can draw any moment of itself: `Film.define({ duration, T, captions, draw(t) })`. Every beat is timed with `cue("phrase")` against the voiceover's words, so a new recording re-times the film. Captions are checked word for word against the recording when the page loads. `render.mjs` steps the page frame by frame in headless Chromium, pipes the frames to ffmpeg, mixes the voice and any sound effects, and levels the sound. The kit's own files are written fresh into `film/kit` before every use, so the agent cannot break them. Remotion is not used: this path needs nothing the sandbox image does not already have, and it runs with no network.

**The voiceover** arrives with the script's approval: `harness resume <id> --approve --voiceover <file>`. The CLI copies the recording into the run and adds a note to the approval saying where it is, which the agent reads as the result of `submit_script`. `--no-voiceover` gives stand-in timing and a film with captions and no voice, so a run can finish unattended.

## Differences settled

Three plans used to give three rules for a tool call that was in flight when a run stopped:

| Plan | What it said |
|---|---|
| Event log | Run it again if the tool is marked idempotent. Otherwise leave it to the agent |
| Plugin contract | An interrupted call that is not idempotent stops the run for a person |
| This plan, and the code | Never run it again automatically. Tell the model what happened, including whether the tool is safe to repeat, and let it decide |

The third is the rule. It is the DeepSeek harness's rule and the simplest to reason about: a tool only ever runs because a model asked for it in a response that is in the log. The event-log plan ("Resume") and the plugin contract (section 7) were changed on 17 November 2026 to say the same. Changing the rule later is a small change in `Engine.repair`.

Two smaller ones, both now written into the event-log plan's catalogue:

- **Pause reasons.** The event-log plan paused a run only on a budget or at the creator's request. The loop also pauses with `error:<kind>` when the model cannot be reached after retries, and with `error:sandbox` when the sandbox cannot be started, so the run can be picked up later instead of failing.
- **Run-ending reasons.** The loop uses these `error.kind` values on `run.failed`: `cancelled`, `refusal`, `round_limit`, `stuck`, `max_output`, `context_exhausted`, and the model error kinds `auth` and `invalid_request`.

## Phase 2

Additions that are not needed for a correct run. Suggested order follows the vision's milestones.

| Item | What it adds | Depends on |
|---|---|---|
| **Postgres event store** | The store the event-log plan describes, behind the existing interface, with artifacts and checkpoints | The migration in `db/` |
| **Sub-agents** | An orchestrator starts child agents (researcher, scriptwriter, editor, critic) with their own context, tool set and model. A child returns its final message, an optional structured value checked against a schema, a short diagnostic and a stop reason. Anything but a normal finish reaches the parent as an error result. The child's transcript stays out of the parent's context. Budgets are carved from the parent's, depth is limited, and children can run at the same time | Agent ids in the log |
| **Provider-side clearing of old tool results** | Compaction is built (section 3). On Claude, the API's own context editing could clear old results without counting as a history edit, and so keep thinking blocks and the cache | Provider capability flag |
| **More model providers** | Gemini, plus a conformance test suite that every provider must pass. A second provider, for OpenAI-style APIs, is already built (section 2) | Provider interface |
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
- **Compaction** breaks the "each request repeats the one before" test, and only at the point of compaction; tests treat `context.compacted` as the start of a new prefix. Its thresholds (60% target, four protected steps, 2,000 characters) are first guesses, tested only against scripted answers.
- **Keeping recent turns.** The DeepSeek harness keeps the newest 16% of the window word for word and summarises the rest. On Claude, turns kept that way cannot carry their thinking blocks, because those are tied to the full history that came before them. The summary here replaces everything after the task; keeping recent turns with their thinking removed is the alternative. Worth measuring on real runs.

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
  src/sandbox.ts                what the loop needs from a sandbox
  src/artifacts.ts              pictures shown to the model, stored by hash
  src/events/                   envelope and payload schemas, reducer, stores
  src/model/types.ts            the provider interface
  src/tools/                    contract, dispatch, built-in tools, run_command
  src/testing/                  scripted provider, a store that dies on cue, a sandbox that runs nothing
packages/reel/
  src/prompt.ts                 the reel agent's system prompt and task
  src/tools/                    start_stage, web_fetch, web_search, submit_script, prepare_voiceover, render_stills, render_film, review_cut, submit_cut
  src/kit.ts, words.ts          installing the kit, word timings
  kit/                          film.js, render.mjs, align.py, the page template and its guide
packages/providers/model-claude/
  src/provider.ts               the HTTP call
  src/sse.ts                    the stream reader
  src/wire.ts                   to and from the API's shapes
  src/models.ts                 prices and limits per model
packages/providers/model-openai-compatible/
  src/provider.ts, sse.ts, wire.ts, models.ts   the same four parts, for OpenAI-style chat APIs
apps/harness-cli/
  src/main.ts, render.ts        commands, and events as plain lines
  src/host.ts                   which provider answers for a model, and the engine built from a run's own record
  src/pipeline.ts               a run's tools and sandbox from its own record; notes, sources and the voiceover
  src/web.ts                    `harness web`: what the web server needs to create and drive runs
packages/web/                   the web UI, being built: a server, views over the event log, a browser client
```

## Open questions

1. **A first live run on Claude.** It needs an API key and spends a few cents. The live runs so far used the OpenAI-compatible provider, so the Claude provider's stream format assumptions and its cache reads are still unproven.
2. **Thinking summaries.** On by default in the provider. They make a recorded run easier to follow and cost nothing extra.
3. **Fallback on refusal.** On by default in the provider, and visible in the trace. Turning it off is one option.
4. **Partial output on cancel.** The DeepSeek harness keeps the text already streamed when a call is cancelled, so the next request contains what the user saw. This loop drops it, since nobody reads the stream during an unattended run. Worth revisiting when the web UI shows runs live.
5. **Node version on this machine.** The repo needs Node 22.18 or later and the tests need it too. The machine the code was written on has Node 20, so the tests were run on a separate copy of Node 24.

## Sources

- [VISION.md](VISION.md), [event-log-and-run-state.md](event-log-and-run-state.md), [PLUGIN_CONTRACT.md](PLUGIN_CONTRACT.md), and the reference runner in `packages/runner/`.
- Claude API documentation on the Messages API, streaming, tool use, prompt caching, stop reasons, errors, compaction, context editing and preserved thinking: <https://platform.claude.com/docs>.
- DeepSeek harness source (`deepseek-ai/deepseek-harness`, read from a fork): `docs/architecture.md`, `docs/agent-lifecycle.md`, `docs/tool-execution-pipeline.md`, `docs/glossary.md`, `docs/subsystems/` (`core`, `session`, `persistence`, `tools`, `approval`, `spill`, `token-meter`, `compaction`, `subagent`, `goal`), and the READMEs of `packages/core/agent-loop`, `packages/llm/llm-retry`, `packages/session/session-checkpoint-policy`, `packages/spill/spill-policy`, `packages/compaction/compaction-basic` and `packages/goal/goal-round-driver`.
- Durable execution for agents: [event sourcing and replay](https://loopy.js.org/core-concepts/event-sourcing/), [write-ahead logging for agents](https://tianpan.co/blog/2026/04/12/write-ahead-logging-for-ai-agents-crash-safe-execution), [checkpoints and the event log](https://prod.stately.ai/docs/packages/agent/checkpoints), [durable state and resumability](https://agentic-ai-wiki.vercel.app/operations/agentops/durable-state-and-resumability/).
