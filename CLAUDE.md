# Video Agent Harness: rules for agents working in this repo

An MIT-licensed, open-source agent harness that turns a topic into a finished short-form reel. The design lives in `docs/plans/`; start with `docs/plans/VISION.md`. The repo began as a fork of AttentionOS and was cut down to what the plans reuse (`README.md` lists what is kept). Most of what the plans describe is not built yet.

## Non-negotiables
- **No secrets, personal data, client data or third-party media in harness code, docs or fixtures.** Examples and fixtures use only obvious placeholders (`@demo_creator_a`, `*.example` domains). CI runs gitleaks.
- **Code holds the gates, the model does the judgment.** Budgets, schemas, tool policy and review gates are deterministic code and are never edited by a model at runtime.
- **Untrusted text** (scraped pages, retrieved posts) only goes to tool-less model calls whose output is validated.
- Core code never imports vendor SDKs. Vendors live in their own provider or plugin packages behind the interfaces in the plans.
- The five files kept from AttentionOS (`packages/core/src/{tools,providers}.ts`, `packages/runner/src/{budget,events,llm}.ts`) are reference source. Leave them unchanged so the line references in the plans stay valid; copy what a plan asks for into the new package.
- Never run git commands; maintainers handle git.

## Layout
- `docs/plans/`: vision, agent loop, plugin contract, event log schema, Docker sandbox.
- `packages/sandbox-docker`: the run sandbox image and its driver.
- `db/`: server bootstrap and migrations for the event log.
- `packages/core/src`, `packages/runner/src`: the reference files above. Not packages; they do not build.
- `projects/`, `skills/`, `analysis/`, `scripts/transcription.py`: the creator's own reels and notes. Not harness code.
- `packages/harness`: the agent loop (engine, events, tools, budgets, gates, resume). `packages/providers/model-claude`: Claude over plain HTTP, no SDK. `apps/harness-cli`: `pnpm harness run|resume|inspect|replay|cancel`. What is built and what is not: `docs/plans/agent-loop.md`.

## Conventions
- TypeScript strict, ESM, Node 22+. Import local files with explicit `.ts` extensions (`./foo.ts`); packages export `./src/index.ts` (no build step for internal packages).
- Zod v4 for every boundary.
- Tests: Vitest, `test/**/*.test.ts` next to each package; providers use recorded fixtures, no network in tests.
- Commands: `pnpm check` (typecheck + lint + tests).
- Copy style for user-facing text: plain language, sentence case, show the work not the wiring ("Drafted 3 scripts for Thursday", never "job 4812 completed").
