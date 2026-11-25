# Video Agent Harness

An open-source agent harness that turns a topic into a finished short-form reel. It owns its agent loop, watches video with video models (reference reels and its own renders), and is meant to prove its quality with published evals.

- **Status:** early. The agent loop, the run sandbox and a first reel pipeline (research, script, voiceover timing, a rendered cut, two reviews) are built and tested against a scripted model. A live model has taken one short reel to an approved cut, without a voiceover. A first web UI follows runs live and answers the reviews ([web-ui.md](docs/plans/web-ui.md)). Video understanding is not started, and there is no critic yet. [STATUS.md](docs/plans/STATUS.md) is the summary, and [agent-loop.md](docs/plans/agent-loop.md) says exactly what is built.
- **License:** MIT
- **Stack (planned):** TypeScript (Node 22.18+, ESM, strict), Zod v4, Vitest, Postgres 18 for the event log, one Docker container per run.

## Plans

Everything in this repo exists to serve the plans in `docs/plans/`. Read them in this order.

| Plan | Covers |
|---|---|
| [VISION.md](docs/plans/VISION.md) | Premise, principles, architecture, a run from brief to final cut, milestones |
| [agent-loop.md](docs/plans/agent-loop.md) | The loop, tool dispatch, budgets, gates, resume and replay, the model provider interface |
| [PLUGIN_CONTRACT.md](docs/plans/PLUGIN_CONTRACT.md) | The one contract every extension registers through: plugins, seams, tools, trust |
| [event-log-and-run-state.md](docs/plans/event-log-and-run-state.md) | Postgres schema for the append-only event log and the run row derived from it |
| [docker-sandbox.md](docs/plans/docker-sandbox.md) | The per-run container, its egress proxy and the driver. Says what is built and what is not |
| [web-ui.md](docs/plans/web-ui.md) | The browser front end: what it shows, its contract and stream, what keeps it safe, what is left |
| [STATUS.md](docs/plans/STATUS.md) | Where the harness stands against all of the above: what is built, what to build next, known bugs |

## Make a reel

Needs Node 22.18 or newer, Docker, and a model key (see `pnpm harness --help` for which).

```bash
docker build -t harness-sandbox:local packages/sandbox-docker/image    # once, and after changing the image

pnpm harness reel --topic "Why most A/B tests are underpowered" --seconds 60 \
  --source https://stats.example/power-primer --notes skills
```

The run researches the topic, writes a script and stops. Read the script it names, record yourself reading the narration, and answer:

```bash
pnpm harness resume <run-id> --approve --voiceover my-reading.m4a   # or --no-voiceover, or --changes "what to fix"
```

It then times your recording, builds the film, renders it and stops again with the path of the cut. `--approve` finishes the run; `--changes "…"` sends it back. `pnpm harness inspect <run-id>` shows what each stage cost.

`pnpm harness web` serves the same runs in the browser at http://localhost:4321: follow the agent live, read its loop step by step, read every script next to every cut, and answer the reviews there instead (with the voiceover as an upload). See [web-ui.md](docs/plans/web-ui.md).

To use the UI from other devices while the harness and Docker stay on this machine, run the UI elsewhere with `harness web --remote` and keep `harness worker` running here, both against the same Postgres store. The UI only writes requests; the worker picks them up. See "Running the UI apart from the worker" in [web-ui.md](docs/plans/web-ui.md).

## What is kept from AttentionOS

This repo began as a fork of [AttentionOS](https://github.com/evanbaker315/AttentionOS) (MIT), a self-hosted content pipeline. The harness is a clean rewrite, so the fork was cut down to the parts the plans name. Everything else was removed.

### Source files the plans reuse

Five files, unchanged and at their original paths, so the `file:line` references in the plans still resolve. They are listed in "What was reused" in [agent-loop.md](docs/plans/agent-loop.md#what-was-reused).

| File | What the harness took from it |
|---|---|
| `packages/core/src/tools.ts` | The shape of `ToolDefinition`, `defineTool` and `ToolError`, rewritten in `packages/harness/src/tools/define.ts` with the flags the loop needs |
| `packages/core/src/providers.ts` | `ProviderError` and its codes, the model for the loop's `ModelError` kinds |
| `packages/runner/src/budget.ts` | `evaluateBudget`, the pure limit check that `packages/harness/src/budget.ts` is modelled on |
| `packages/runner/src/llm.ts` | The tool-less system prompt and `parseJsonFromText`, copied into `packages/harness/src/extract.ts`. Also the rule that keeps the clock out of the system prompt. The rest of the file is the loop the plan replaces, kept because the plan cites it |
| `packages/runner/src/events.ts` | Nothing so far. `EventSink` is built around a loop that lives in a dependency |

These are reference source, not working packages. They import AttentionOS packages that were cut, so they do not build on their own. They stay unchanged so the `file:line` references in the plans still resolve; what the harness needed was copied or rewritten in `packages/harness`.

### Repo tooling and conventions

The plans assume the fork's conventions: TypeScript strict, ESM, explicit `.ts` imports, Zod v4, Vitest. These files carry them.

| File | Change |
|---|---|
| `tsconfig.base.json`, `turbo.json`, `.editorconfig`, `.nvmrc` | Unchanged |
| `.gitignore` | Entries added for `runs/` and other local folders |
| `pnpm-lock.yaml` | Regenerated for the packages in this repo |
| `package.json` | Renamed; scripts and dev dependencies for the removed CLI, plugin, database and changesets taken out |
| `pnpm-workspace.yaml` | `modules/*` and an unused override removed |
| `vitest.config.ts` | Test globs for `modules/` and `scripts/` removed |
| `.gitattributes` | Two entries for removed files taken out |

### Other

- `.gitleaks.toml` and `.github/workflows/gitleaks.yml`: the secret scan, unchanged. It is the only CI left.
- `LICENSE` (unchanged) and `NOTICE` (rewritten to list what is kept).
- `CLAUDE.md`: rewritten for this repo. It keeps the rules that still apply.

## What is not from AttentionOS

| Path | What it is |
|---|---|
| `docs/plans/` | The plans above |
| `packages/sandbox-docker/` | The run sandbox: image, egress proxy and driver ([plan](docs/plans/docker-sandbox.md)) |
| `packages/harness/`, `packages/providers/`, `apps/harness-cli/` | The agent loop, two model providers (Claude and OpenAI-style APIs) and the command line ([plan](docs/plans/agent-loop.md)) |
| `packages/web/` | The web UI behind `pnpm harness web` ([plan](docs/plans/web-ui.md)) |
| `packages/reel/` | The reel pipeline and the film kit that renders a cut ([plan](docs/plans/agent-loop.md#the-reel-pipeline)) |
| `db/` | Server bootstrap and the first migration for the event log ([plan](docs/plans/event-log-and-run-state.md)) |
| `.mcp.json` | The Distill MCP server, for Claude Code sessions in this repo ([setup](#distill-mcp-server)) |
| `projects/` | Reels made by hand before the harness: scripts, research, voiceover and one finished film |
| `skills/` | Scriptwriting and visual technique notes |
| `analysis/` | Reel teardowns |
| `scripts/transcription.py` | Word-level transcription used by the projects |

## What was cut

- **Apps:** `apps/cli`, `apps/studio`, `apps/worker`.
- **Packages:** `db`, `guardrails`, `knowledge`, `mcp`, `media`, `provider-shared`, `render-motion`, `runtime`, `scoring`, every vendor adapter in `packages/providers/`, and all of `core` and `runner` except the five files above.
- **Modules:** all twelve in `modules/`.
- **Media sidecar:** `media-py/`.
- **Claude Code plugin:** `plugin/`, `plugin-src/`, `.claude-plugin/`.
- **Deployment and setup:** `deploy/`, `templates/`, `presets/`, `.dockerignore`, `.env.example`.
- **Vendored projects:** `third-party/`.
- **Design:** `design/`.
- **Docs:** everything in `docs/` except `plans/`, including the ADRs.
- **Project files:** `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.changeset/`, and everything in `.github/` except the secret scan.
- **Scripts:** the brand-literal guard, the plugin builder and `pnpm-locked.sh`.

To bring something back, take it from [upstream](https://github.com/evanbaker315/AttentionOS) or from this repo's history. Commit `9ad824d` is the last one with the full tree:

```bash
git checkout 9ad824d -- media-py
```

## Development

```bash
corepack enable    # pnpm version is pinned in package.json
pnpm install
pnpm check         # typecheck + lint + tests
```

The lint step is Biome (`biome.json`). CI (`.github/workflows/check.yml`) runs the same three steps on every push and pull request, plus the Postgres store's tests against a real Postgres 18; the secret scan runs separately.

### Distill MCP server

`.mcp.json` adds [Distill](https://github.com/tarunchinta/Distill) as an external MCP server for Claude Code sessions in this repo. Distill is the reference library in the vision: semantic search over saved reels, transcripts, and reel ingestion.

- **Server:** `https://mcp.distillmcp.com/mcp/` (streamable HTTP).
- **Sign-in:** OAuth, with nothing stored in the repo. Approve the server when Claude Code asks, run `/mcp`, pick `distill` and choose Authenticate. A browser opens for Google sign-in, and searches are scoped to that account.
- **No client ID or secret needed.** Claude Code registers itself with the server and uses PKCE.

The harness's own `references-distill` plugin is not built yet, so this config serves people and agents working in the repo, not harness runs.

Node 22.18 or newer. New packages go in `packages/<name>`, `packages/providers/<name>` or `apps/<name>`; the workspace and test globs already cover those paths. Rules for agents working in the repo: [CLAUDE.md](CLAUDE.md).

## License

[MIT](LICENSE). Attribution for the files kept from AttentionOS is in [NOTICE](NOTICE).

This is an independent open-source project. It uses Claude and other models and isn't affiliated with or endorsed by their makers.
