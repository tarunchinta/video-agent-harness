# Video Agent Harness — Vision

## Premise

An open-source, end-to-end AI agent harness that turns a topic into a finished
short-form reel. It owns its agent loop, understands video for real (it watches
reference reels and its own renders), and proves its quality with published
evals and reels that earn views.

It has two jobs, and both count:

1. **Make reels worth watching.** AI and tech explainers and data stories,
   built from code-driven motion graphics, live demos the agent runs itself,
   and the creator's own voice and footage.
2. **Be a credible piece of engineering.** The repo should stand on its own as
   evidence of agent-harness design, multimodal video understanding, evals and
   production discipline.

This replaces the previous vision. The harness is a clean rewrite in this repo;
old code is pulled in only where it earns its place.

## What changed from the previous vision

| Before | Now |
|---|---|
| Pipeline runs inside Muse, driven by conversation | Standalone harness with its own agent loop, CLI and web UI |
| Muse pulls context, analyses and edits | Muse does one thing: its daily job indexes saved posts through Distill |
| Creator steers every stage | Autonomous run with two review gates |
| Feedback is manual | A video-model critic watches every render and drives re-edits |
| No measurement | Eval suite is a first-class deliverable |
| Evolve the existing engine | Clean rewrite |

## Principles

- **Own the loop.** Tool dispatch, context management, sub-agents, checkpoints
  and traces are written here, not rented from an SDK. Models are swappable.
- **Everything is a plugin.** Borrowed from the DeepSeek harness: tools, model
  providers, video-understanding backends, sandboxes, renderers and UI panels
  all register through one plugin contract with a clear lifecycle, so each can
  be loaded, replaced or removed without touching the core.
- **Code holds the gates, the model does the judgment.** Budgets, schemas,
  safety checks and review gates are deterministic. Taste and reasoning belong
  to the model.
- **The agent watches video, it does not read about it.** Understanding comes
  from video models over actual frames and audio, not from transcripts alone.
- **Every run is replayable.** A run is an append-only event log. Anything the
  UI shows, an eval scores or a resume needs comes from that log.
- **Untrusted content stays contained.** Scraped pages and retrieved posts only
  reach tool-less model calls whose output is validated. Agent-written code and
  browser sessions run in a sandbox.
- **Cloneable.** Tuned to one creator's workflow, but anyone can run it with
  their own keys. Personal integrations (Distill) are optional plugins.

## Architecture

### Core loop

- A model-agnostic agent loop: plan, call tools, observe, repeat.
- **Sub-agents** with their own context and tool set (researcher, scriptwriter,
  demo operator, editor, critic), coordinated by an orchestrator.
- **Context management:** compaction, tool-result offloading to files, and a
  per-run working directory the agents share.
- **Checkpoint and resume:** a run can stop at a gate, crash, or be paused, and
  pick up from the event log.
- **Budgets:** tokens, money, wall-clock time and re-edit count, enforced in
  code.
- **Traces:** every model call, tool call, cost and artifact recorded.

### Plugin kinds

| Kind | First implementations |
|---|---|
| Model provider | Claude, Gemini (others by adapter) |
| Video understanding | TwelveLabs (index, search, embeddings, video-to-text), Gemini (long-context reasoning over clips) |
| Reference library | Distill MCP (semantic search over saved reels, video files from blob storage) |
| Sandbox | Local Docker container per run: code execution, headless browser, ffmpeg, renderer |
| Research | Web search and fetch, public datasets, code experiments |
| Demo capture | Browser agent that performs and records a demo |
| Render | Films drawn in code as HTML pages, rendered frame by frame in headless Chromium and ffmpeg; chart animation, captions |
| Voice | Creator-uploaded voiceover with word timestamps; ElevenLabs as an option |
| Storage | Local disk; blob storage for shareable renders |

### Video understanding

One interface, two backends. The agent can ask of any video (a reference reel
or its own render):

- What happens, shot by shot, with timestamps.
- Where the hook lands, how the pacing moves, when text is on screen and
  whether it is legible.
- Whether visuals match the words being spoken at that moment.
- Which saved reels are most similar in structure or technique.

Running both backends behind one interface also yields a head-to-head
comparison, published as part of the evals.

### Interfaces

- **CLI:** start, resume, inspect and evaluate runs.
- **Web UI:** follow a run live (plan, sub-agents, tool calls, cost), preview
  renders, read the critic's notes, approve or send back at the gates.

## A run, end to end

1. **Brief.** The creator gives a topic or points at saved reels. The agent
   retrieves similar references from Distill and studies them with the video
   models: structure, hook, pacing, techniques.
2. **Research.** A research agent gathers sources, pulls public data and runs
   small experiments in the sandbox. Output: findings, charts and citations.
3. **Script.** A script with shot-level intent, grounded in the research and in
   the patterns found in the references.
   **Gate 1: the creator approves the script.**
4. **Assets.** The demo operator drives a browser to perform and record demos.
   Charts and motion graphics are generated as code. The creator records
   voiceover or footage, or a synthetic voice is used.
5. **Edit.** The editor assembles the cut in code, synced to word-level
   timestamps.
6. **Critique.** The critic watches the render and scores it against a rubric
   (hook, pacing, audio-visual sync, legibility, factual grounding). The rubric
   is calibrated on the creator's saved reels. Failing scores come back as
   timestamped notes; the editor revises and re-renders until the cut passes or
   the budget runs out.
   **Gate 2: the creator approves the final cut.**
7. **Learn.** After publishing, view and retention numbers are recorded against
   the run so the rubric can be checked against what actually performs.

## Proof

Four artifacts, in the order a reader should meet them:

1. **Eval suite**, reproducible from the repo:
   - Video understanding: accuracy on timestamped questions about a labelled
     set of reels, TwelveLabs against Gemini, with cost and latency.
   - Critic validity: does the critic's score agree with human ratings, and
     with real view and retention data?
   - Agent performance: task success per stage, re-edits needed, cost and time
     per finished reel.
   - Ablations: with and without the critic loop, with and without references.
2. **Live demo and traces.** Recorded runs anyone can replay in the web UI.
3. **Real reels.** A public account whose reels are made by the harness, with
   their numbers.
4. **Technical write-up.** The architecture, what the evals found and what
   failed.

## What it should demonstrate

The project is aimed at applied-AI and agent-engineering roles at companies
working on video, media and generative tools. It should show:

- A shipped agent with evals, not a prototype.
- Agent infrastructure: loop, plugins, sub-agents, sandboxing, MCP.
- Multimodal pipelines over real media assets, including retrieval.
- Agents that edit video and judge the result.
- Honest measurement: cost, latency, failure cases.

## Milestones

1. **Core.** Loop, plugin contract, event log, CLI, Docker sandbox, one model
   provider. A trivial run completes and replays.
2. **Eyes.** Video-understanding interface with both backends, Distill plugin,
   first understanding eval.
3. **First reel.** Research, script, render with motion graphics and uploaded
   voiceover. Both gates working.
4. **Critic.** Rubric, critique loop, critic-validity eval.
5. **Demos.** Browser agent records its own demos.
6. **Show.** Web UI with replay, published evals, write-up, first public reels.

## Out of scope

- Muse as a runtime. It only indexes saved posts through Distill.
- Multi-user product features: onboarding, brand kits, accounts.
- Generative text-to-video and avatars.
- Auto-publishing to social platforms.
- Cloud sandboxes (the sandbox interface leaves room for one later).
- Reference clips appearing in output. They inform style only.

## Open questions

- How the labelled eval set is built and whether it can be shared, given
  third-party reels cannot be redistributed.
- Where post-publish metrics come from.

Answered since this was written:

- **The language of the core.** TypeScript. Python runs only inside the
  sandbox: the script that times a voiceover's words, and whatever the agent
  writes.
- **How much of the plugin lifecycle to take from the DeepSeek harness.**
  `PLUGIN_CONTRACT.md`, section 1, goes through it line by line. That plan is
  still a proposal.
