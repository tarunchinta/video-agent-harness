# Video Agent Harness — Plugin contract

Design for the single contract that every extension registers through
(`VISION.md`, principle "Everything is a plugin", milestone 1). It also answers
the open question in `VISION.md`: how much of the plugin lifecycle to take from
the DeepSeek harness.

Status: proposal. Nothing here is implemented yet.

## 1. What the DeepSeek harness does

Source: the `deepseek-ai/deepseek-harness` docs (`architecture.md`,
`AGENTS.md`, `cordis-primer.md`, `capability-seams.md`,
`tool-execution-pipeline.md`, `agent-lifecycle.md`, `subsystems/core.md`, and
the cookbook pages for tools, packages and extensions). The vendored Cordis
source and the generated event and config catalogs were not read.

How it works, in short:

- **A plugin is a small object**: `name`, `inject` (services it needs) and
  `apply(ctx)`. It is mounted into a shared context.
- **The context is a service registry.** Services claim stable keys
  (`ctx.tools`, `ctx.llm`, `ctx.sandbox`). Plugins find each other by key, never
  by importing an implementation.
- **`inject` decides load order.** A plugin waits until the services it
  declares exist.
- **Every registration is a reversible effect.** Tools, adapters, listeners and
  prompt sections install through `ctx.effect()` or `ctx.on()`, and each
  returns a disposer. Unloading a plugin unwinds what it registered.
- **Capability seams have three roles**: a service definition (the interface),
  a provider (an implementation) and a consumer (often a model-facing tool).
  About 36 seams are swappable this way, for example `ctx.llm`, `ctx.shell`,
  `ctx.fs`, `ctx.subagents` and `ctx.storage`.
- **Typed events with a declared dispatch mode** (`emit`, `waterfall`,
  `parallel`, `serial`, `bail`). Waterfall listeners are around-middleware:
  call `next()` to continue, return without it to short-circuit.
- **A fixed tool pipeline**: log the call, `tools/pre-execute` (allow, deny or
  ask), monotonic guards that can only deny, approval, an execute wrapper, the
  tool body, `tools/post-execute`, then one frozen result written to the
  session log. A missing approver means deny.
- **Tools return a canonical value, not prose.** `output.schema` describes the
  value, `output.render` turns it into what the model sees, and UI presenters
  are pure functions so they work live and on replay.
- **Agent-scoped registration.** An agent has its own `ctx`; what is registered
  there unwinds when the agent is disposed.
- **Composition by config.** Profiles and bundles list plugins and their
  config; patches layer on top. There is no privileged core: the agent loop,
  tool registry and session log are themselves plugins.
- **Rules that keep it honest**: anything that reaches a model request must be
  reconstructable from the session log; config is validated at load and fails
  loudly; defaults are resolved in an explicit step.

### Take, adapt, leave

| DeepSeek harness | Decision | Why |
|---|---|---|
| Plugin as `name` + `inject` + `apply(ctx)` | Take | Small, testable, one shape for every kind |
| Services found by key, three-role seams | Take | It is exactly the "replace without touching the core" principle |
| Registrations as reversible effects | Take | Needed for per-run and per-agent teardown, not only hot reload |
| `inject`-driven load order | Take | No manual sequencing |
| Fixed tool pipeline, deny-only guards, fail closed | Take | "Code holds the gates" |
| Canonical value + `render`, pure presenters | Take | Replayable UI and evals that score values, not prose |
| Agent-scoped contexts | Take | Sub-agents with their own tool sets |
| Config validated at load | Take, with Zod | One schema library across the repo |
| Five dispatch modes | Adapt: three | `emit`, `waterfall`, `serial` cover every case below |
| `ask` outcome and approval prompts | Adapt: gates only | Runs are autonomous with two review gates, not per-tool prompts |
| Profiles, bundles, patch layering | Adapt: one config file with named profiles | One creator, not a product with many distributions |
| No privileged core | Leave | Event log, budgets, gates and the tool pipeline must not be replaceable |
| Cordis as a vendored framework | Leave | "Own the loop": the kernel below is a few hundred lines we write |
| Hot module replacement | Leave for now | Effects make it possible later; nothing in the milestones needs it |
| YAML with `!!js` expressions, plugin manager, locale packs, host/client package split | Leave | Product surface the vision puts out of scope |

## 2. Shape of the design

Two layers, and the line between them is the main departure from the DeepSeek
harness.

- **Kernel** (not a plugin, not replaceable): the event log, budgets, gates,
  the tool pipeline, the agent loop, the plugin loader and the seam proxy.
  These are the deterministic parts the vision says code must hold.
- **Plugins**: everything else. Model providers, video backends, the sandbox,
  renderers, voice, storage, reference libraries, tool packs, sub-agent roles,
  UI panels and eval suites.

Plugins never import each other or the kernel's internals. They import one
types-and-schemas package (`contract`) and talk through `ctx`.

## 3. Plugin definition

```ts
import { definePlugin, secret } from '@harness/contract'
import { z } from 'zod'

export default definePlugin({
  name: 'video-twelvelabs',
  inject: { required: ['video', 'storage'], optional: ['ui'] },
  config: z.object({
    apiKey: secret(),                       // a reference, resolved per call
    index: z.string().default('reels'),
  }),
  async apply(ctx, config) {
    ctx.video.register('twelvelabs', createBackend(ctx, config))
  },
})
```

| Field | Rule |
|---|---|
| `name` | Unique, kebab-case, `<seam>-<vendor>` for providers |
| `inject.required` | Seams and kernel services the plugin uses. `apply` runs only once all exist |
| `inject.optional` | Used if present. `ctx.<key>` is `undefined` otherwise |
| `config` | Zod schema. Parsed before `apply`; a parse error stops the boot |
| `apply(ctx, config)` | The only entry point. Registers things; holds no globals |

`ctx` is typed from `inject`: reaching for a seam that was not declared is a
type error and a runtime throw. That keeps the dependency graph readable from
the definitions alone.

### What `ctx` offers

```ts
interface Context {
  readonly plugin: { name: string }
  readonly scope: 'process' | 'run' | 'agent'

  effect(setup: () => Disposer | Promise<Disposer>): void   // reversible side effect
  on(event, listener, opts?: { prepend?: boolean }): void    // live bus, auto-removed

  onRun(setup: (run: RunContext) => void | Promise<void>): void
  onAgent(setup: (agent: AgentContext) => void | Promise<void>): void

  // Kernel services (always available when injected)
  log: EventLog        // append namespaced events, read the run's history
  tools: ToolRegistry  // register tools, pre/post hooks, guards
  agents: AgentRoles   // register sub-agent roles
  gates: Gates         // register an answerer (CLI, web UI)
  budget: BudgetView   // read-only
  secrets: Secrets     // resolve a secret reference

  // Seams, present only when listed in `inject` (see section 5)
}
```

Every `register`, `on` and `effect` is owned by the context it was called on
and is undone when that context ends. A plugin never writes its own teardown
bookkeeping.

## 4. Lifecycle

### States

```
declared -> configured -> waiting -> active -> disposing -> disposed
                 \            \         \
                  +------------+---------+--> failed
```

| State | Meaning |
|---|---|
| declared | Listed in the config, module loaded |
| configured | Config parsed against the plugin's schema |
| waiting | Some required `inject` key has no provider yet |
| active | `apply` returned |
| disposing | Effects unwinding, newest first |
| failed | Config, `apply` or a dependency failed |

Boot is all-or-nothing: if an enabled plugin fails, or is still waiting when
loading settles, the harness exits with the plugin name and the missing key.
There is no half-started harness.

### Scopes

Three nested contexts. Each one is a child of the one above, sees its parent's
services, and unwinds on its own.

| Scope | Lives for | Typical registrations |
|---|---|---|
| process | The CLI or server process | Providers, tool packs, roles, UI panels |
| run | One run, including resume | Sandbox container, working directory handles, per-run tools |
| agent | One sub-agent | That agent's tool set, prompt sections, hooks |

```ts
ctx.onRun(async (run) => {
  const session = await docker.start(run.id, run.workdir)
  run.effect(() => () => session.stop())     // stops when the run ends or pauses
  run.sandbox.provide(session)
})
```

Teardown order is fixed: agent scopes, then the run scope, then process scope;
inside a scope, effects unwind in reverse registration order. A disposer that
throws is logged and does not stop the rest.

### What the kernel emits

`plugin/active`, `plugin/failed` and `plugin/disposed` go to the event log
with the plugin name, version and a hash of its resolved config (secrets
excluded). A replay can therefore say exactly which plugins produced a run.

## 5. Seams

A seam is an interface with a key. The definition lives in `contract`,
providers are plugins, consumers are tools and agents.

A seam is declared as a table of methods with schemas, not as a free-form
TypeScript interface:

```ts
export const video = defineSeam({
  key: 'video',
  cardinality: 'many',          // 'one' = single provider, 'many' = named registry
  scope: 'process',
  methods: {
    shots: {
      input: z.object({ video: artifactRef, }),
      output: z.object({ shots: z.array(shot) }),
      replay: 'recorded',
    },
    // ...
  },
})
```

Because the kernel knows every method's schema, it wraps each provider in a
proxy that does the same five things for every call, so no provider can forget
them:

1. Validate input and output.
2. Check the budget before the call and charge it after.
3. Pass an `AbortSignal` that fires on cancel or budget exhaustion.
4. Append `seam/call` and `seam/result` to the event log, with cost and
   latency.
5. On resume or replay, serve `recorded` methods from the log instead of
   calling the provider.

Rules for every seam method:

- Input and output are JSON plus `ArtifactRef`s. No buffers, streams of bytes
  or class instances cross a seam. Media moves as files in the run's working
  directory or in storage.
- The return type is `Metered<T> = { value: T, usage: { usd, tokens?, seconds? } }`.
  Providers report what they spent; the kernel does the accounting.
- Errors are typed (`code`, `retryable`). Anything else thrown is logged as an
  unexpected failure.
- No vendor escape hatch. A capability one backend lacks is expressed as a
  `capabilities` flag on the provider, not as a pass-through option.

### The seams

One row per plugin kind in `VISION.md`.

| Kind | Key | Cardinality | Scope | Core methods |
|---|---|---|---|---|
| Model provider | `models` | many | process | `stream(request)`, `extract(content, schema)` |
| Video understanding | `video` | many | process | `ingest`, `shots`, `ask`, `similar` |
| Reference library | `references` | many | process | `search(query)`, `fetch(id)` |
| Sandbox | `sandbox` | one | run | `exec`, `read`, `write`, `browser` |
| Render | `renderers` | many | process | `render(spec)`, `probe(artifact)` |
| Voice | `voice` | many | process | `align(audio, script)`, `synthesize(text)` |
| Storage | `storage` | many | process | `put`, `get`, `url` |
| UI panel | `ui` | many | process | `panel(def)` (section 8) |

Three kinds are not seams, because they have no interface of their own to
swap. They are plugins that consume seams and register tools:

| Kind | What the plugin does |
|---|---|
| Research | Registers `web_search`, `web_fetch`, `dataset_query`, `run_experiment` tools; uses `sandbox` and `models` |
| Demo capture | Registers `demo_record`; uses `sandbox.browser` and `storage` |
| Tool packs | Any other set of tools |

Sub-agent roles (researcher, scriptwriter, demo operator, editor, critic) and
eval suites also register through plugins, via `ctx.agents.role(def)` and an
optional `evals` seam, so a role or an eval can be added or swapped the same
way.

### Interface sketches

```ts
interface ModelProvider {
  models: ModelInfo[]          // id, modalities, context window, prices
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>
}

interface VideoBackend {
  capabilities: { similar: boolean; maxSeconds: number; audio: boolean }
  ingest(video: ArtifactRef): Metered<{ handle: string }>
  shots(video: ArtifactRef): Metered<{ shots: Shot[] }>            // what happens, with timestamps
  ask<T>(video: ArtifactRef, question: string, schema: Schema<T>): Metered<T>
  similar(video: ArtifactRef, limit: number): Metered<{ matches: Match[] }>
}

interface ReferenceLibrary {
  search(query: string, limit: number): Metered<{ items: ReferenceItem[] }>
  fetch(id: string): Metered<{ video: ArtifactRef }>               // origin: 'external'
}

interface SandboxSession {
  exec(cmd: string[], opts: ExecOptions): Metered<ExecResult>
  read(path: string): Metered<{ file: ArtifactRef }>
  write(path: string, file: ArtifactRef): Metered<void>
  browser(): BrowserHandle                                          // navigate, act, record
}

interface Renderer {
  kinds: string[]                                                   // 'composition', 'chart', 'captions'
  render(spec: RenderSpec): Metered<{ video: ArtifactRef }>
}

interface VoiceProvider {
  align(audio: ArtifactRef, script: string): Metered<{ words: WordTiming[] }>
  synthesize?(text: string, voice: string): Metered<{ audio: ArtifactRef }>
}

interface StorageBackend {
  put(file: ArtifactRef): Metered<{ key: string }>
  get(key: string): Metered<{ file: ArtifactRef }>
  url?(key: string): Metered<{ url: string }>
}
```

The four questions the vision wants answered about any video (shot list, hook
and pacing and legibility, audio-visual match, similar reels) map to `shots`,
`ask` with a fixed schema per question, and `similar`. Both video backends
implement the same methods, which is what makes the head-to-head eval a plain
loop over `ctx.video.list()`.

## 6. Trust

Untrusted content is tracked by the kernel, not left to each plugin.

- Every `ArtifactRef` carries `origin: 'creator' | 'harness' | 'external'`.
- A seam method or tool can declare `trust: 'untrusted'` (web fetch, reference
  search).
- A result is tainted if its method is untrusted **or** any input artifact is
  external. A shot list of a saved reel is tainted; a shot list of the
  harness's own render is not.
- A tainted result never enters the context of an agent that has tools. The
  pipeline writes it to the working directory and passes it through
  `ctx.models.extract(content, schema)`: a tool-less call whose output must
  parse against the schema the tool declared. Only that parsed value reaches
  the agent.

This is one code path in the tool pipeline, so a new research or reference
plugin gets containment by declaring a schema, not by remembering a rule.

## 7. Tools

```ts
ctx.tools.register(defineTool({
  name: 'video_shots',
  description: 'List the shots in a video with timestamps.',
  input: z.object({ video: artifactRef, backend: z.string().optional() }),
  output: z.object({ shots: z.array(shot) }),
  render: (input, value) => [{ type: 'text', text: formatShots(value.shots) }],
  idempotent: true,
  async execute(input, exec) {
    const backend = exec.ctx.video.get(input.backend)
    return (await backend.shots(input.video)).value
  },
}))
```

- `execute` returns the canonical value only. `render` produces what the model
  reads. Evals and the UI use the value.
- `exec` carries `callId`, `agent`, `run`, `signal` and a scoped `ctx`.
- `idempotent` tells resume whether an interrupted call can run again. A
  non-idempotent call that was interrupted stops the run for attention rather
  than repeating a side effect.
- Results over a size limit are written to the working directory and replaced
  in context by a path and a summary.

### Pipeline

Fixed order, owned by the kernel. Plugins hook in at three marked points.

| # | Step | Owner |
|---|---|---|
| 1 | Append `tool/call` | Kernel |
| 2 | Validate input | Kernel |
| 3 | Budget check | Kernel |
| 4 | `tools/pre-execute` (waterfall: allow or deny) | Plugins |
| 5 | Guards (deny only, cannot be overridden) | Plugins |
| 6 | `tools/execute` (waterfall: timeout, retry, metrics) | Plugins |
| 7 | Tool body | Plugin |
| 8 | Validate output, freeze, apply trust rule, offload if large | Kernel |
| 9 | `tools/post-execute` (waterfall: annotate or block) | Plugins |
| 10 | Append `tool/result`, charge budget | Kernel |

Any throw in steps 4 to 9 becomes an error result; it never crashes the loop.
There is no `ask` outcome. Human decisions happen only at the two gates.

## 8. Events, gates and UI panels

**Two channels.**

- **Event log** (`ctx.log`): durable, append-only, versioned. The source for
  resume, replay, evals and the UI. A plugin may append its own event types
  under `plugin.<name>/…` after registering a schema. An event type the reader
  does not know stops a replay unless the event was written with
  `ignorable: true`.
- **Bus** (`ctx.on`): live, transient, for coordination and streaming. Nothing
  on the bus is needed to reconstruct a run.

**Dispatch modes**: `emit` (observe, no return), `waterfall` (middleware with
`next()`), `serial` (awaited in order, a throw aborts). Each event declares its
mode in `contract`.

**Gates** are kernel events (`gate/opened`, `gate/resolved`). Interfaces
register an answerer with `ctx.gates.answerer(fn)`. With no answerer a gate
stays open and the run pauses; it never passes by default. No plugin can
resolve a gate on its own behalf: answers carry the identity of the interface
they came through.

**UI panels**

```ts
ctx.ui.panel({
  id: 'critic-notes',
  title: 'Critic notes',
  slot: 'run.side',                         // 'run.main' | 'run.side' | 'gate'
  project: (state, event) => nextState,     // pure reducer over the event log
  client: new URL('./panel.client.tsx', import.meta.url),
})
```

`project` is pure: no I/O, clock or randomness. The server folds the log
through it and sends state to the client bundle. The same panel therefore
works on a live run and on a replay with no extra code.

## 9. Composition

One file, `harness.config.ts`, with named profiles.

```ts
export default defineConfig({
  profiles: {
    default: [
      use('model-claude', { apiKey: env('ANTHROPIC_API_KEY') }),
      use('video-twelvelabs', { apiKey: env('TWELVELABS_API_KEY') }),
      use('video-gemini', { apiKey: env('GEMINI_API_KEY') }),
      use('sandbox-docker'),
      use('storage-local'),
      use('references-distill', { enabled: false }),   // optional, personal
    ],
    replay: [use('replay-providers'), use('storage-local')],
  },
})
```

- A plugin is in-tree (`plugins/<name>`) or any package that default-exports a
  `definePlugin` result. Both load the same way.
- The `replay` profile mounts providers that serve every seam from a recorded
  log, so replays and keyless tests need no credentials.
- `harness plugins` prints the resolved tree: each plugin, its state, what it
  provides and what it injects.

## 10. Conformance

Each seam ships a test kit in `contract`: `testVideoBackend(provider)`,
`testSandbox(provider)` and so on. A provider plugin passes the kit against
recorded fixtures before it is accepted. The kits check schemas, cancellation
through the signal, usage reporting and typed errors. This is what makes "can
be replaced without touching the core" a tested claim.

## 11. Milestone 1 cut

Build first:

- `definePlugin`, loader with `inject` ordering and all-or-nothing boot.
- Contexts with `effect`, `on`, `onRun`; process and run scopes.
- `defineSeam` and the proxy (validate, meter, log, replay).
- `defineTool` and the pipeline, steps 1 to 10, without the trust step.
- Seams: `models`, `sandbox`, `storage`. Plugins: one model provider,
  `sandbox-docker`, `storage-local`, `replay-providers`.

Later, in milestone order: `video` and `references` with the trust rule (2),
`renderers` and `voice` and gates (3), agent scope and roles for the critic
loop (4), `sandbox.browser` (5), `ui` panels (6).

## 12. Decisions to confirm

1. **A kernel that is not a plugin.** The DeepSeek harness makes the loop and
   the log replaceable. This design does not. Recommended, because budgets,
   gates and the log are the parts the vision says must be deterministic.
2. **Seams as schema tables.** More ceremony per method than a plain
   interface, in exchange for uniform logging, metering and replay.
   Recommended.
3. **No hot reload.** Recommended until the web UI milestone, then revisit.
4. **Research and demo capture as tool packs, not seams.** Recommended; promote
   one to a seam only when a second implementation appears.
5. **Zod for config and seam schemas**, on the assumption the core is
   TypeScript (still listed as open in `VISION.md`).
