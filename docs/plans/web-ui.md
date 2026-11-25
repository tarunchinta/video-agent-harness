# Web UI plan

The browser front end the vision asks for: follow a run live, read the agent's loop, compare scripts with rendered cuts, answer the two reviews, and keep work in projects. This plan says what is built, how it is put together, and what is left.

Status: a first version is built and tested (`packages/web`, started with `pnpm harness web`). It reads runs only through the event store, so it works on the JSON-lines store and on Postgres (`HARNESS_STORE=postgres`), and writes through the same creator functions as the terminal. Not started: sub-agent views, critic notes, plugin UI panels.

## What it is for

| Vision line | What the UI does |
|---|---|
| "Follow a run live (plan, sub-agents, tool calls, cost)" | The run page streams every event as it is written, and model text as it is typed. A stage stepper, budget meters, and a loop view of every step, retry and tool call |
| "Preview renders" | Every cut in a player, with its contact sheet, size, render time and whether it was revised at your request or on the agent's own judgement |
| "Read the critic's notes" | Not yet: there is no critic. The review cards show the agent's note with each hand-in |
| "Approve or send back at the gates" | The composer turns into the review when a run waits: approve, ask for changes, or reject, and hand over the voiceover with a script approval |
| "Anything the UI shows comes from the log" | Every panel is a pure function of the events. A finished run reads exactly as it did live |

## Using it

```bash
pnpm harness web            # http://localhost:4321, --port to change
```

- **Home**: runs waiting for you, runs in progress, projects, recent runs.
- **New reel**: the brief `harness reel` takes (topic, length, sources, network, model, limits), plus a project whose notes the agent is given. Also plain tasks.
- **Run page**: three tabs on the left and a studio on the right.
  - **Chat**: your brief, what the agent said, its tool calls folded under the step that asked for them (input, what it read back, pictures it was shown), stage changes, reviews and your answers, and notes from the harness. The composer at the bottom depends on where the run is: answer a review, pause or cancel a working run, raise a limit and resume a paused one.
  - **Loop**: totals (steps, turns, rounds, tool calls, refusals, retries, safe reads, tokens, cost), a timeline with lanes for stages, reviews, model calls and tools (long waits squeezed), and a ledger of steps with each attempt and tool call. Clicking a span opens its raw events.
  - **Log**: the events themselves, filterable.
  - **Studio**: *Script* (every revision handed in, rebuilt from the `write_file` call that wrote it, with your notes and a diff from the one before; the narration with words per line and an estimate of its length), *Cuts* (every render, its contact sheet, the agent's note and your answer), *Script vs cut* (the cut playing next to the narration, lit word by word from `film/words.json`; click a word to jump there), *Files* (the working folder).
- **Projects**: a project is a folder under `projects/`. Its page shows recordings and footage in players, scripts and notes rendered, and the runs filed under it. A run is filed when it is created, or later from its page.

Runs driven from a terminal show up live as well. The page says who is driving a run, and refuses to answer a review that another process is driving.

## How it is built

The DeepSeek harness's GUI (`apps/web` over a host/client package split, an RPC protocol with four message kinds, a WebSocket downlink) was read for its layering and protocol. This is the same shape, cut down to one local creator.

| Layer | Here | Taken from the DeepSeek harness |
|---|---|---|
| Contract | `packages/web/src/api/contract.ts`: Zod schemas for every call and every stream frame. Browser-safe: it imports only types from the harness | One contract source of truth, method map keyed by URL path, `Result` instead of thrown business errors |
| Views | `packages/web/src/views/`: pure folds of the log into chat items, the trajectory, deliverables and progress | "The view is a pure projection", the turn/step ledger with a timing overview |
| Server | `packages/web/src/server/`: `node:http`, no framework. A hub that folds each run's log, follows the store for changes, drives runs in this process and fans frames out | Host/carrier split. The server is given a `RunHost` and never imports a provider or the Docker driver |
| Client | `packages/web/src/client/`: React, bundled in memory by esbuild when the server starts. No build step and no `dist/` | Three-column frame, sidebar of projects and sessions, conversation with a composer, a right-hand panel for deliverables |
| Application | `apps/harness-cli/src/web.ts`: `harness web` builds the `RunHost` from the same pieces as `reel`, `run` and `resume` (`host.ts`) | "Assembly is written in the app" |

**Calls** are `POST /api/<method>` with JSON, answered with HTTP 200 and `{ ok, value | error }`. The client checks every answer against the contract.

| Method | Does |
|---|---|
| `host.describe` | Folders, default model, models the keys allow |
| `runs.list`, `runs.get`, `runs.files` | Cards for every run; one run's whole log and folded state; its working folder |
| `runs.createReel`, `runs.createTask` | Creates a run and starts driving it here |
| `runs.decide` | Answers the open review. A reel's script approval takes the voiceover: an upload, none, or keep |
| `runs.resume`, `runs.pause`, `runs.cancel` | Through `requestResume` (with `updateBudget`), `requestPause`, `requestCancel` |
| `runs.file` | Files a run under a project (`x.web.filed`) |
| `projects.list`, `projects.create` | Folders under `projects/` |

`POST /api/upload?run=…&name=…` takes a recording as a raw body, up to 512 MB, into the run's `uploads/` folder.

**Frames** come on one server-sent event stream, `GET /api/stream?run=<id>&after=<seq>`: `runs` (every card, on change), `events` (new events of the open run, with its state folded on the server), `text` (model text as it streams, never stored), `projects`. A reconnect rebuilds: the client reopens from the last `seq` it holds and reloads the run if it sees a gap, as the DeepSeek harness does.

**Live, from any process.** Runs driven here push each event the moment the engine writes it. The hub sees every other run only through the store's `RunDirectory` methods (`packages/harness/src/events/store.ts`), never through files or tables:

- **`listRuns`**, once a second: every run's last `seq` and the worker holding a live lease, if any. A run whose `seq` moved is read past the events the hub holds (`read(runId, afterSeq)`). The lease says whether another process is driving. The file store answers from each run's folder, parsing only what was appended. Postgres answers with one query on `harness.runs`.
- **`watch`**, when the store has it: Postgres `LISTEN harness_events`, which the insert trigger notifies on every append, so a change shows up at once rather than within a second. It needs a direct connection on port 5432. If it fails, the listing still finds every change.

Each run's files (working folder, renders, uploads) stay on this machine under `runs/<id>` with either store.

**Files** are served from `/files/runs/<id>/…` (the working folder), `/files/artifacts/<id>/<sha>.<ext>` (pictures shown to the model) and `/files/projects/<slug>/…`, with byte ranges so video can seek.

## What keeps it safe

The server can approve reviews and spend money, so it is treated as a door into the run.

- **This machine only.** It listens on `127.0.0.1` and answers only requests whose `Host` is `localhost:<port>` or `127.0.0.1:<port>`, so a page cannot reach it by pointing another name at the port (DNS rebinding).
- **No calls from other sites.** Every call needs the `x-harness-client` header and a JSON body. A page on another origin cannot send either without a CORS preflight, which is never answered.
- **Nothing a run wrote runs in the page.** Files are confined to their root (paths and links that leave it are refused), served as their media type or as plain text (agent-written HTML and SVG included), with `X-Content-Type-Options: nosniff` and a `sandbox` content security policy. The app page has a strict CSP: scripts only from itself.
- **Untrusted text stays text.** Markdown is rendered into React elements, never as HTML. Links open only for `http(s)`. Events marked untrusted are flagged in the log view.
- **The same gates.** Every write goes through the creator functions in `packages/harness/src/creator.ts`. A review answered here is the same `gate.decided` event as one answered with `harness resume`, and the voiceover lands through the same `placeVoiceover`.

There is no login of its own. On this machine anyone who can reach the port can answer reviews. Served wider, it refuses to listen beyond `127.0.0.1` until `HARNESS_WEB_AUTH` says who signs people in (see below).

## Running the UI apart from the worker

The harness and the Docker sandbox stay on the desktop; the UI can run anywhere that reaches the same Postgres store, such as Azure Container Apps. The desktop takes no inbound connection: both halves only connect out to the database.

| Half | Command | Does |
|---|---|---|
| Cloud | `harness web --remote --bind 0.0.0.0` | Writes what the creator asks for (create, answer a review, budget, resume, pause, cancel) through the creator functions. Drives nothing; `RunHost.drive` is absent, so `Hub.drive` does nothing |
| Desktop | `harness worker [--concurrency 1]` | Lists runs (and listens for `harness_events`) and drives each one whose status is `created` or `running` with no live lease: new runs, answered reviews, resumes, and runs whose worker died. The lease keeps two workers off one run. A run that fails to start (no key, say) is tried again after 30 seconds, doubling to 15 minutes |

What the creator hands a reel that has to land on the desktop's disk goes through the log (`apps/harness-cli/src/handover.ts`):

- **Voiceover.** The remote server saves the upload to the `UploadStore`, records `x.web.voiceover { choice, name, extension }`, and tells the agent where the recording will be. Before driving, the worker copies the latest choice into `inputs/` and notes it in `runs/<id>/handover.json` so a later pickup does not repeat it. Keeping a recording works for one uploaded through the remote server.
- **Notes.** A reel filed under a project gets that project's notes from the desktop's own `projects/<slug>` when the worker first picks it up.

The two halves share files through blob storage (`BlobStore` in `packages/web/src/server/blobs.ts`: `put`, `head`, and `get` by range; no listing). Both are given the same setting, `HARNESS_BLOB_URL` (an Azure Blob container URL with a SAS token, read by `@harness/blob-azure` over plain HTTP) or `HARNESS_BLOB_DIR` (a folder, such as a share both machines mount; also what the tests use). `blobsFor` in `apps/harness-cli/src/blobs.ts` picks it. With neither, everything stays in each run's folder, which only works when both halves share a disk.

- **Uploads.** `uploadsFor` in `handover.ts` gives both halves `BlobUploads`, the same three methods as `DirectoryUploads`, at `runs/<id>/uploads/<name>`.
- **Run files.** The worker's `RunMirror` copies the working folder (as `listFiles` sees it, so without `film/kit` and `tool-results`) and the pictures in `artifacts/` to `runs/<id>/work/…` and `runs/<id>/artifacts/…`, a second after each burst of events and again, awaited, before a drive returns, so a review never shows a draft that is not there yet. Only changed files go up (by size and time), remembered in `runs/<id>/mirror.json`. The listing, `runs/<id>/files.json`, goes up last. The remote server's `BlobRunFiles` answers `runs.files` from that listing and serves `/files/runs/…` only for paths on it, and `/files/artifacts/…` only for picture names; ranges work, so video seeks. A file missing from a run that moved in the last two minutes is waited for, up to 30 seconds, since the event naming it can arrive before the copy. Projects' files are still read from the server's own disk.
- **Typed text.** The worker sends model text as it is typed with `NOTIFY harness_text, '<run id>:<text>'` (`RunStore.publishText`), gathered every 150 ms and split under the 8000-byte limit. The remote hub listens (`watchText`) and sends it on as `text` frames, as it does for a run it drives itself. It needs no grant and no extra service, and it is never in the log; a missed delta is harmless because the finished text arrives with its event. Like `harness_events`, listening needs a direct connection, not PgBouncer in transaction mode.

Settings for the cloud half:

| Variable | Meaning |
|---|---|
| `HARNESS_STORE=postgres`, `DATABASE_URL` | The same database as the worker, as `harness_web` (migration 0002): it can read everything and write only creator events, and cannot take a lease |
| `HARNESS_WEB_ALLOWED_HOSTS` | The names the browser uses, such as the app's `*.azurecontainerapps.io` name |
| `HARNESS_WEB_AUTH=entra` | Every request must carry `x-ms-client-principal-id`, which Container Apps and App Service authentication set after a Microsoft Entra sign-in. `none` means you put your own sign-in in front |
| `HARNESS_MODELS` | The models the worker has keys for, offered in the composer |
| `HARNESS_BLOB_URL` | The blob container, on both halves. A container-scoped SAS with read, create and write; keep it in a secret, not in the image. The cloud half needs it for uploads and run files |

## What changed elsewhere

- `CreateRunInput.project` in `creator.ts` writes `brief.project` on `run.created`. The reducer ignores it.
- `x.web.filed { project }`, a plugin event the reducer ignores, records filing a run after it was created.
- `apps/harness-cli/src/host.ts` holds `providerFor` and `driveRun`, moved out of `main.ts` so the terminal and the web drive runs the same way.

## Tests

`packages/web/test/views.test.ts` folds a hand-written reel log (a script sent back once, two cuts, a retried model call, a refused tool) through every view. `packages/web/test/server.test.ts` runs the server against a scripted model: a run is started over HTTP, followed on the stream with no gaps in `seq`, stopped at a review, answered and finished. It also checks the host, header and path guards, and follows a run through an in-memory store with no log files, taking a pushed change without waiting for the listing. `apps/harness-cli/test/web.test.ts` starts and stops `harness web`. `packages/web/test/blobs.test.ts` covers blob uploads and the mirror (only changes sent, the listing as the allow-list, progress kept when a send fails); `server.test.ts` serves mirrored files by range, waits for one not mirrored yet, and streams typing sent through the store; `packages/providers/blob-azure/test/store.test.ts` runs the Azure store against an in-memory stand-in for the REST API; `apps/harness-cli/test/worker.test.ts` hands a recording over through blob storage and checks that a drive mirrors the draft before it returns.

## Not built yet

| Item | Needs |
|---|---|
| Steering a working agent (a message mid-run, cancelling one tool call) | Steering in the loop (agent-loop Phase 2) |
| Partial text kept on cancel | Agent-loop open question 4 |
| Sub-agent lanes in the loop view | Sub-agents |
| Critic notes, timestamped against the cut | The critic |
| Plugin UI panels (`ctx.ui.panel`) | The plugin contract's loader |
| Replay at speed (scrubbing a finished run event by event) | Only a UI change; the views already fold any prefix of the log |
| Cleaning up a run's blobs | Deleting a run; blobs are left in place today |
| Managed identity for blob storage | A token from the Container Apps identity endpoint in `@harness/blob-azure`; today it is a SAS URL |
