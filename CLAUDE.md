# video-agent-harness: rules for agents

Layout and what each folder holds: `README.md`.

- `tools/` holds CLIs the harness calls. Each tool lives in `tools/<name>/` and should be runnable on its own from the command line.
- `tools/attentionos/` is the AttentionOS engine. When working inside it, follow `tools/attentionos/CLAUDE.md` and run its commands (`pnpm check`, `pnpm attentionos <cmd>`) from that folder.
- `harness/` is the agent loop (compaction, tracing, finish and stop logic). `evals/` holds tasks and graders. `results/` holds tables, failure writeups and the traces worth keeping; raw run output goes in `evals/runs/` (git-ignored).
- Skills live in `skills/<name>/SKILL.md` with `name` and `description` frontmatter.
- Never put secrets in the repo. CI runs gitleaks with `.gitleaks.toml`.
