# Video Agent Harness: rules for agents working in this repo

An MIT-licensed, open-source agent harness that turns a topic into a finished short-form reel. The design lives in `docs/plans/`; start with `docs/plans/VISION.md`. The repo began as a fork of AttentionOS and was cut down to what the plans reuse (`README.md` lists what is kept). The agent loop, the sandbox and a first reel pipeline are built; much of the rest of what the plans describe is not. `docs/plans/STATUS.md` says where things stand.

## Non-negotiables
- **No secrets, personal data, client data or third-party media in harness code, docs or fixtures.** Examples and fixtures use only obvious placeholders (`@demo_creator_a`, `*.example` domains). CI runs gitleaks.
- **Code holds the gates, the model does the judgment.** Budgets, schemas, tool policy and review gates are deterministic code and are never edited by a model at runtime.
- **Untrusted text** (scraped pages, retrieved posts) only goes to tool-less model calls whose output is validated.
- Core code never imports vendor SDKs. Vendors live in their own provider or plugin packages behind the interfaces in the plans.
- The five files kept from AttentionOS (`packages/core/src/{tools,providers}.ts`, `packages/runner/src/{budget,events,llm}.ts`) are reference source. Leave them unchanged so the line references in the plans stay valid; copy what a plan asks for into the new package.
- Never run git commands; maintainers handle git.

## Layout
- `docs/plans/`: vision, agent loop, plugin contract, event log schema, Docker sandbox, and `STATUS.md`, the summary of what is built against them.
- `packages/sandbox-docker`: the run sandbox image and its driver.
- `db/`: server bootstrap and migrations for the event log.
- `packages/core/src`, `packages/runner/src`: the reference files above. Not packages; they do not build.
- `projects/`, `skills/`, `analysis/`, `scripts/transcription.py`: the creator's own reels and notes. Not harness code.
- `packages/harness`: the agent loop (engine, events, tools, budgets, gates, resume). `packages/providers/model-claude`: Claude over plain HTTP, no SDK. `packages/providers/model-openai-compatible`: any OpenAI-style chat API, the same way. `packages/reel`: the reel pipeline on top of the loop (stage tool, research, the two gates, voiceover timing) and the film kit in `packages/reel/kit` that renders a cut in the sandbox. `packages/contract`: the plugin contract (plugins, seams, the loader) and the conformance kits every provider passes. `packages/store-postgres`: the event log in Postgres. `packages/providers/search-*`: web search (Brave, SearXNG). `packages/providers/blob-azure`: Azure Blob Storage over plain HTTP, for a web server and a worker on two machines. `apps/harness-cli`: `pnpm harness reel|run|resume|inspect|replay|cancel|plugins|web`. `packages/web`: the web UI that `harness web` serves (contract, pure views of the log, server, React client); plan in `docs/plans/web-ui.md`. What is built and what is not: `docs/plans/STATUS.md` in brief, `docs/plans/agent-loop.md` in detail.

## Conventions
- TypeScript strict, ESM, Node 22+. Import local files with explicit `.ts` extensions (`./foo.ts`); packages export `./src/index.ts` (no build step for internal packages).
- Zod v4 for every boundary.
- Tests: Vitest, `test/**/*.test.ts` next to each package; providers use recorded fixtures, no network in tests.
- Commands: `pnpm check` (typecheck + lint + tests). Typecheck is `tools/typecheck.mjs`; lint is Biome (`biome.json`). CI runs the same.
- Copy style for user-facing text: plain language, sentence case, show the work not the wiring ("Drafted 3 scripts for Thursday", never "job 4812 completed").
