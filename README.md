# Video Agent Harness

An open-source agent harness that turns a topic into a finished short-form reel. It owns its agent loop, watches video with video models (reference reels and its own renders), and is meant to prove its quality with published evals.

- **Status:** design stage. The plans are written, the run sandbox and the event-log schema are in progress, and there is no agent loop yet.
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

## What is kept from AttentionOS

This repo began as a fork of [AttentionOS](https://github.com/evanbaker315/AttentionOS) (MIT), a self-hosted content pipeline. The harness is a clean rewrite, so the fork was cut down to the parts the plans name. Everything else was removed.

### Source files the plans reuse

Five files, unchanged and at their original paths, so the `file:line` references in the plans still resolve. They are listed in "What to reuse" in [agent-loop.md](docs/plans/agent-loop.md#what-to-reuse).

| File | What the plans take from it |
|---|---|
| `packages/core/src/tools.ts` | `ToolDefinition`, `defineTool`, `ToolError` and the annotations. The harness tool contract extends these |
| `packages/core/src/providers.ts` | `ProviderError` and its codes, used as the error taxonomy for retries |
| `packages/runner/src/budget.ts` | `evaluateBudget`, the pure limit check the budget code is modelled on |
| `packages/runner/src/llm.ts` | The tool-less system prompt, `parseJsonFromText` and `validateOutput`, which move into `ctx.extract`. Also the rule that keeps the clock out of the system prompt. The rest of the file is the loop the plan replaces, kept because the plan cites it |
| `packages/runner/src/events.ts` | `EventSink` batching, for live events only |

These are reference source, not working packages. They import AttentionOS packages that were cut, so they do not build on their own. Each one moves into `packages/harness` when the part of the plan that uses it is built.

### Repo tooling and conventions

The plans assume the fork's conventions: TypeScript strict, ESM, explicit `.ts` imports, Zod v4, Vitest. These files carry them.

| File | Change |
|---|---|
| `tsconfig.base.json`, `turbo.json`, `.editorconfig`, `.nvmrc`, `.gitignore`, `pnpm-lock.yaml` | Unchanged |
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
| `db/` | Server bootstrap and the first migration for the event log ([plan](docs/plans/event-log-and-run-state.md)) |
| `.mcp.json` | The Distill MCP server, for Claude Code sessions in this repo ([setup](#distill-mcp-server)) |
| `projects/` | Reels made by hand before the harness: scripts, research, voiceover and one finished film |
| `skills/` | Scriptwriting technique notes |
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
pnpm install       # also rewrites pnpm-lock.yaml, which still lists the removed packages
pnpm check         # typecheck + lint + tests
```

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
