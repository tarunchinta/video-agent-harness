# Video Agent Harness — Vision

## Premise

A short-form video content generating agent harness that runs end to end inside
Muse. Ty triggers everything in natural language by talking about content he
thinks is good — on technical, visual, or substantive merit. There is exactly
one trigger type: conversation.

## Pipeline

### 1. Trigger & context intake

- Ty discusses content with Muse: what caught his eye, why it works, what he
  wants to make.
- Muse pulls the relevant Instagram context via its Instagram connectivity.
- The distill MCP server extracts the videos and builds a semantic index over
  them for later retrieval.

### 2. Analysis

- The agent breaks down each ingested video: what works, what doesn't, and why.
- Editing techniques are distilled into reusable **skills**.
- Topics, content angles, and technical concepts are written to the **database**
  (Postgres) for later retrieval.

### 3. Research & scripting

- A web research agent synthesizes information from multiple sources on the
  chosen topic.
- It works in a VM: executes code, runs small experiments, pulls publicly
  available data, and builds tiny demos tied to the topic. Example: for a video
  on the Olympics, a simple ML model predicting athlete performance from past
  results and other factors.
- Output: a **script** plus **artifacts** — code, images (graphs, plots), and
  cited sources for the data and articles used.

### 4. Edit & animate

- Code-driven video assembly with **Remotion** and **Palmier Pro** (open-source
  agentic video editor; exposes a local MCP server so agents edit the timeline
  directly. Note: macOS-only, Apple Silicon — this step runs on Ty's Mac).
- The cut is synced to the script and to Ty's voiceover. Ty uploads the audio;
  word-level timestamps come from his transcription script (separate repo).
- **Skills** handle signature flourishes, e.g. article-headline screenshots
  synced to name drops, or Seaborn charts that animate fluidly onto the screen
  instead of popping in.

### 5. Feedback & iteration

- Ty reviews, gives notes in natural language, the agent re-renders.
- Rendered versions are delivered as **links in chat**.
- Intermediate versions are stored in **Azure Blob Storage**, with links
  recorded in the database.

## Operating principles

- **Everything within Muse.** No separate harness service to deploy; the
  pipeline is executed by the agent using its tools.
- **Secrets never touch the repo.** Connection strings and keys live in
  environment/config files (`.env`, gitignored). `.env.example` documents the
  contract.
- **CI/CD over long-lived infra.** GitHub Actions rebuilds and updates the
  system on every push. No per-project VMs in v1.
- **One project at a time (v1).** Concurrency and per-project isolation are
  deferred until multiple videos are routinely in flight.

## V1 scope

Trigger → ingest → script + demo artifacts → rendered video → preview link in
chat, with the feedback loop driven manually. The analysis store (skills +
database) grows as a side effect of real projects.

## Deferred

- Second trigger type (dropped; conversation is the only trigger).
- Per-project isolation / parallel video pipelines.
