# Status

Where the harness stands against [VISION.md](VISION.md) and the other plans, as of 17 November 2026. It covers what is built, what would be worth building next, and the bugs found in review and what was done about each. [agent-loop.md](agent-loop.md) is the detailed record of the loop; this page is the summary across all the plans.

How this was checked, on 17 November 2026, on Node 24:

- `pnpm typecheck`: 11 of 11 packages.
- `pnpm lint` (Biome): no errors, 4 warnings, all `noDescendingSpecificity` in `packages/web`'s stylesheet.
- `vitest run`: 250 passed, 24 skipped. With `HARNESS_PG_IT_URL` pointing at a throwaway Postgres 18, 257 passed and 17 skipped. The 17 left are the Docker suites (`HARNESS_SANDBOX_IT=1`). The film kit's suite, which now includes the critic, was run by hand against the real sandbox and passed.
- One live run on the Postgres store: `harness run --task "Say hello."` with `HARNESS_STORE=postgres`. It went through the OpenAI-compatible provider, in two model calls at about $0.002, and finished with 13 events, the `runs` row ending `succeeded`.

## In one paragraph

Milestone 1 (Core) is done apart from a live run on the Claude provider: the loop, the plugin contract's first cut, the event log in files or in Postgres, the CLI, the Docker sandbox and two model providers. Milestone 3 (First reel) has research with web search, a script, voiceover timing and a rendered cut, and a live model has taken one short reel to an approved cut without a voiceover. Milestone 4 (Critic) has a first version: code measures every cut and a tool-less model call scores it against a rubric, with code deciding the pass. No video model watches it yet. Milestone 6 (Show) has a web UI. Milestones 2 (Eyes) and 5 (Demos) are not started.

## What has been achieved

### The agent loop (`packages/harness`)

| Capability | State | Evidence |
|---|---|---|
| A loop written by hand, with no agent SDK or vendor SDK | Built | `engine.ts` |
| Append-only transcript, rebuilt from the log as a pure function | Built | A test rebuilds every request from the log and compares SHA-256 hashes |
| The conversation kept up to date as events load, so a step costs the events since the last one | Built | `ContextBuilder` in `context.ts` |
| Write before acting | Built | `resume.test.ts` kills the run at every write and resumes it |
| Crash repair: interrupted calls get error results, and no tool is ever re-run automatically | Built | `Engine.repair` |
| Retries with backoff, jitter and `Retry-After`, for the agent's calls and for tool-less calls alike | Built | `fixes.test.ts` |
| Budgets for tokens, cost, active time, steps, rounds and re-edits, with an 80% warning | Built | Tested for tokens and steps |
| Review gates enforced by dispatch, not by the prompt | Built | Tested with a model that tries to skip them |
| Stages with revision triggers and re-edit counting | Built | `stages.test.ts`, and the critic tests in `packages/reel` |
| Tool dispatch, large-result offloading, pictures by hash | Built | `tools.test.ts`, `images.test.ts` |
| Tool-less calls: `extract` for text written by strangers, `judge` for a critic that looks at pictures | Built | `extract.test.ts`, `fixes.test.ts` |
| Loop guard, context-pressure warning and stop, a cap on cut-off responses | Built | `loop.test.ts`, `fixes.test.ts` |
| Compaction (23 November): old large tool results cleared first, then a tool-less summary with the creator's notes kept by code; one summary and a retry after a provider overflow | Built, on for runs the CLI creates | `compaction.test.ts`, including a crash at every write |
| Event stores: in memory, JSON lines (locked), Postgres | Built | `store.test.ts`, `fixes.test.ts`, `store.integration.test.ts` |
| Pause, resume, cancel (including a run whose worker died), budget changes and gate decisions | Built | `creator.ts` |
| The price table's date on every run, and a warning in `inspect` when it is old | Built | `inspect.ts` |

### The plugin contract (`packages/contract`)

The milestone 1 cut of [PLUGIN_CONTRACT.md](PLUGIN_CONTRACT.md): `definePlugin`, a loader that boots all or nothing in dependency order, process and run scopes whose effects unwind newest first, and four seams: `models`, `sandbox`, `search` and `tools`. Each provider package carries its plugin: `model-claude`, `model-openai-compatible`, `search-brave`, `search-searxng` and `sandbox-docker`. The CLI boots them from one profile (`apps/harness-cli/src/plugins.ts`), and `harness plugins` prints what is loaded. Not built: seam schema tables with a proxy that meters and replays each call, plugin hooks in the tool pipeline, the agent scope, and UI panels. Section 13 of the plan has the details.

### Conformance kits (`@harness/contract/conformance`)

`testModelProvider` checks that a stream is deltas and then one response, plus stop reasons, tool calls, usage, error kinds and `Retry-After`. It also checks that a cut-off stream counts as a failed attempt, that a cancel stops the call, that the same request gives byte-identical bodies, and that prices are sane. `testSearchProvider` checks result shape and error kinds. Both model providers and both search providers pass against recorded answers. `testSandbox` is written for any `SandboxSession` and runs only when Docker is asked for.

### Model and search providers

- **Claude** (`model-claude`) and **OpenAI-compatible** (`model-openai-compatible`), both plain HTTP over server-sent events. Each states the date its price table was checked. `HARNESS_PRICES=<file>` corrects prices without changing code.
- **Brave** (`search-brave`) and **SearXNG** (`search-searxng`), plain HTTP. SearXNG is open source and needs no key. The CLI uses SearXNG when `SEARXNG_URL` is set, otherwise Brave when `BRAVE_SEARCH_API_KEY` is set, otherwise no search.

### Live runs

Four, all with `DeepSeek-V4.1-Flash` through the OpenAI-compatible provider. The first three ran on 16 November 2026, with their logs under `runs/`, which is not committed.

| Run | Outcome | Model calls | Cost at the table's estimated prices |
|---|---|---|---|
| Write a file, read it back, finish | Finished | 3 | Under one cent |
| A ten-second reel | Finished. The script was approved, the first cut was sent back with notes, the second was approved | 62 | About $0.44 |
| The same brief again | Failed with `context_exhausted`. The script was sent back once, then approved. After the first cut the agent started a re-edit on its own judgement and ran out of room | 64 | About $0.39 |
| Say hello, on the Postgres store (17 November) | Finished | 2 | About $0.002 |

What they show: the loop, the gates, resume after each review, the sandbox and the film kit work with a real model, and so does the Postgres store. Both reels predate the critic and web search and were made without a voiceover. A 128,000-token window is tight for a reel. None of the runs used the Claude provider.

### Sandbox (`packages/sandbox-docker`)

One container per run, not root, with no capabilities and no network by default. `public` runs go through a per-run egress proxy that refuses private addresses. The run's working folder now has a limit, 10 GB unless set. No single file can outgrow it, and the result of any command run after the folder is over says so, so the agent is told to make room.

### Reel pipeline (`packages/reel`)

Four stages and two gates, as before, with two new tools:

- **`web_search`**, when a search plugin is loaded. The listing goes only to a tool-less call, which picks results by number. The addresses the agent gets are taken from the listing in code, so none can be invented.
- **`review_cut`**, the critic. `kit/review.mjs` measures the rendered file in the sandbox: black or frozen picture, the hook, the ending, loudness and true peak, and a timeline sheet of sixteen frames, each labelled with the words spoken over it. Code fails a cut on what it can measure. A tool-less model call scores the sheet, the script and the research notes on hook, pacing, sync, legibility and grounding. Code decides the pass: no failing check, no score under 3, an average of at least 3.5. A cut that fails goes back for a revision, which counts as a critique-triggered re-edit. Once no re-edits are left it goes to the creator, with the review attached to the gate. The critic is on for reels created from now on; the run records it, so older runs resume with the rules they began with.

The timeline sheet borrows the idea of `video-use`'s timeline view, which pairs frames with the words heard over them.

### CLI and web UI

`harness reel | run | resume | inspect | replay | cancel | plugins | web`. `HARNESS_STORE=postgres` with `DATABASE_URL` keeps the log in Postgres. `harness web` serves the web UI (`packages/web`, plan in [web-ui.md](web-ui.md)). It reads runs only through the store, so it works on either one; on Postgres it hears appends at once through `LISTEN harness_events`. Split across machines (`harness web --remote` in the cloud, `harness worker` on the desktop), uploads and run files go through blob storage (`HARNESS_BLOB_URL`, `@harness/blob-azure`) and typed text through `NOTIFY harness_text`; neither has met a live Azure account yet.

### Database (`db/`, `packages/store-postgres`)

`migrate()` applies `db/bootstrap.sql` and each migration in order. The store writes `harness.events` and the `runs` projection in one transaction, runs as `harness_app`, and keeps the lease as the plan's SQL. Its tests run against a real Postgres 18, here and in CI. They cover a whole engine run, four writers at once, the lease and stale epochs, a crash at each write followed by a resume, cancelling a run whose worker died, and the append-only grants.

## Against the milestones

| Milestone | State | What is missing |
|---|---|---|
| 1. Core | Done, but for one check | A live run on the Claude provider |
| 2. Eyes | Not started | The video-understanding interface, TwelveLabs and Gemini backends, the Distill plugin and the understanding eval |
| 3. First reel | Built; one live reel, without a voiceover | A reel with a real voiceover made by a live model. Charts and motion graphics beyond the kit |
| 4. Critic | First version | A video model watching the cut, a rubric calibrated on the creator's reels, the critic-validity eval |
| 5. Demos | Not started | `browser()` on the sandbox, and a demo-capture agent |
| 6. Show | Started | Published evals and the write-up. The web UI on Postgres is built but has not been run against a live server |

## What would still be useful

1. **A live run on Claude, and a reel with a real voiceover, the critic and web search.** Everything new on 17 November was tested against recorded answers. A live run would show whether the critic's scores make sense, and how much context `review_cut` adds to a 128,000-token window.
2. **Compaction on a live reel.** Built on 23 November and tested against scripted answers only. The second live reel failed on context alone; running that brief again would show whether clearing and summarising let it survive its revisions, and whether the thresholds are right.
3. **A video model behind the critic.** The `video` seam in the plugin contract, with one backend, so the critic hears the sound and sees motion rather than sixteen frames.
4. **The seam proxy.** Metering, validation and replay for every seam call, which would also bring search costs into the budget.
5. **The web UI against the live Postgres server.** `listRuns` and `watch` are tested against a throwaway Postgres 18; they have not met the Azure server.
6. **A speech fixture.** Voiceover timing still has no automated test, because the repo holds no recording.
7. **Artifacts and checkpoints.** `artifact.created` and `checkpoint.created` are never written, so cuts and reviews are named by path and hash but not registered.

## Bugs found in review, and what was done

All eleven from the 16 November review are resolved. Each fix has a test unless noted.

| # | Bug | Fix |
|---|---|---|
| 1 | The JSON-lines store could give two writers the same `seq`, making a run unreadable | Every check-then-write runs under a lock file created exclusively, with stale locks taken over. A worker that lost its lease is refused before it touches the file. `fixes.test.ts` runs four interleaved writers from two store objects |
| 2 | Cut-off responses that held tool calls never counted toward the max-output limit | Every cut-off response counts; the third fails the run. `fixes.test.ts` |
| 3 | `harness cancel` did not end a run whose worker had died | A run that says `running` with no live lease is closed in the same write as the request. `EventStore.leaseHeld` was added to every store. Tested on the memory store and on Postgres |
| 4 | `web_fetch` checked DNS separately from the connection, so a name could rebind to a private address. IPv6 forms that embed IPv4 were missed | The connection's own lookup checks the address and connects to exactly that one. Mapped, compatible, NAT64, 6to4, Teredo, documentation and discard ranges are judged. `research.test.ts` has a rebinding name |
| 5 | `web_fetch` cited the first address, not the page it read | It cites the final address and says where the request began |
| 6 | Each append re-read the whole log, and each step rescanned it | The file store reads only what was added since the last read. The engine keeps the conversation and its counters (steps, notes, cut-offs, the repeat streak, pictures) as events load |
| 7 | Tool-less calls did not retry an outage | They use the loop's backoff and `Retry-After`, and log each attempt. `fixes.test.ts` |
| 8 | Nothing limited the size of `work/` | The disk limit described under "Sandbox". Tested with a fake Docker; the limit cannot stop many files written by one command before the measurement |
| 9 | Price tables were hand-kept with no sign of their age | Each provider states when its prices were checked; runs record it; `inspect` warns after 90 days; `HARNESS_PRICES` corrects them |
| 10 | `pnpm check` did not lint | Biome, configured in `biome.json` |
| 11 | `pnpm typecheck` failed on machines whose global pnpm could not switch versions | `tools/typecheck.mjs` calls `tsc` in each package directly |

The doc drift found in the same review (stale status lines, the package list, the interrupted-call rule, a broken link in `README.md`) was fixed on 17 November, and the plans now say what the code above added.

Still open from that pass: `README.md`, "What was cut", says commit `9ad824d` in this repo's history is the last one with the full tree, but this repo's history starts at a single commit made after the cut. If `9ad824d` is an upstream commit, the sentence should say so.

## Known gaps in compaction (23 November)

- **Untested on a live model.** The thresholds (clear down to 60% of the window, keep the newest four steps, skip results under 2,000 characters) are first guesses.
- **Clearing drops thinking blocks** before the last cleared result, and invalidates the provider's cache from that point. On Claude the API's own context editing would avoid both; it is not used yet.
- **A summary replaces everything after the task.** Recent turns are not kept word for word. The facts code adds (stage, reviews, the creator's notes, what was last handed in) are what a reel must not lose; anything else rests on the summarising model.

## Known gaps in what was built on 17 November

- **The critic has only judged recorded answers and one real render.** The real render was a static test film, which drew two "holds still" notes and passed. Its thresholds (for example a 4-second freeze, or 2.5 seconds after the last word) are first guesses, not calibrated.
- **Two values can still hide text.** `web_search` results pass through a tool-less call like pages do, but a title or a one-line note could still carry a misleading sentence, as with `web_fetch`.
- **The tool list on resume is rebuilt from the environment.** If search keys change between a run's start and its resume, `web_search` can appear or disappear mid-run. The critic is recorded on the run; search is not.
- **The Postgres store reads the whole log once per store object.** It does this when it has no cached state for a run, for example on the first append after a restart.
- **The web UI holds every run's log in memory.** It reads each run once when it starts and then only what is appended. Fine for hundreds of runs; thousands would want the list built from `harness.runs` alone, with a log read only when a run is opened.
