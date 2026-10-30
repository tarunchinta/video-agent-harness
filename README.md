# video-agent-harness

An agent harness for making short-form explainer videos, built on tools derived from AttentionOS, with an eval suite that measures how well the agent does.

## Layout

```
video-agent-harness/
  tools/       # the AttentionOS-derived scripts, each callable as a CLI
  harness/     # loop, compaction, tracing, finish/stop logic
  evals/       # task suite, graders, run-all script
  results/     # tables, failure writeups, selected traces
  acp/         # thin wrapper, added later
  skills/      # one nested folder per skill (skills/<name>/SKILL.md)
```

| Folder | What's in it now |
|---|---|
| `tools/attentionos/` | The full AttentionOS engine (TypeScript packages, modules, the `attentionos` CLI, the `media-py` sidecar, the Docker stack). Run its commands from inside that folder, for example `cd tools/attentionos && pnpm install && pnpm check`. |
| `tools/transcription/` | `transcription.py`, a WhisperX transcription service carried over from another app. Not yet a standalone CLI. |
| `harness/` | Empty. The agent loop goes here. |
| `evals/` | Empty. Tasks, graders and the run-all script go here. |
| `results/` | The two video projects made so far (`results/projects/`) and a teardown export (`results/analysis/`). |
| `acp/` | Empty. Reserved for a thin ACP wrapper. |
| `skills/` | Writing and structure skills for explainer videos. |

The engine's own module skills stay in `tools/attentionos/modules/<id>/skills/` because `pnpm plugin:build` generates the Claude Code plugin from them.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
