import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createRun, decideGate, Engine, foldRun, JsonlEventStore, requestCancel, requestResume, RunNotFoundError, summarizeRun, updateBudget,
  type Limits, type ModelProvider, type RunOutcome,
} from "@harness/harness";
import { ClaudeProvider } from "@harness/model-claude";
import { OpenAICompatibleProvider } from "@harness/model-openai-compatible";
import { DEFAULT_RE_EDITS, detailOf, networkFrom, pipelineFor, reelRun, takeVoiceover, UsageError, type PipelineDeps } from "./pipeline.ts";
import { describeOutcome, describeSummary, Renderer } from "./render.ts";

export type Io = {
  out: (text: string) => void;
  err: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Replaces the global `fetch`, for tests. */
  fetch?: typeof fetch;
  /** Aborted on Ctrl-C. */
  signal?: AbortSignal;
} & PipelineDeps;

const USAGE = `Usage:
  harness run --task "what to do" [--model claude-opus-5-5 | DeepSeek-V4.1-Flash] [--system "…"] [limits]
  harness reel --topic "what the reel is about" [--seconds 60] [--source <url>]... [--notes <file or folder>] [--network none|public] [--model …] [limits]
  harness resume <run-id> [--approve | --changes "what to fix" | --reject] [limits]
      approving a reel's script also takes --voiceover <your recording>, or --no-voiceover
  harness inspect <run-id>
  harness replay <run-id>
  harness cancel <run-id>

Limits: --max-usd <dollars>  --max-tokens <n>  --max-minutes <n>  --max-steps <n>  --max-rounds <n>  --max-re-edits <n>
A reel, and a run started with --sandbox, need Docker and the sandbox image (docker build -t harness-sandbox:local packages/sandbox-docker/image).
Runs are kept under ./runs (set HARNESS_RUNS_DIR or --runs-dir to change). The default model is MODEL_NAME, or claude-opus-5-5.
Claude models use ANTHROPIC_API_KEY. Any other model goes to the OpenAI-style API at MODEL_BASE_URL with MODEL_API_KEY.`;

const DEFAULT_SYSTEM =
  "You are an agent working in a directory of files. Use the tools to do the task you are given. " +
  "When the task is complete, call finish with a short summary of what you did.";

const options = {
  task: { type: "string" },
  topic: { type: "string" },
  seconds: { type: "string" },
  source: { type: "string", multiple: true },
  notes: { type: "string" },
  sandbox: { type: "boolean" },
  network: { type: "string" },
  voiceover: { type: "string" },
  "no-voiceover": { type: "boolean" },
  "max-re-edits": { type: "string" },
  model: { type: "string" },
  system: { type: "string" },
  "runs-dir": { type: "string" },
  "max-usd": { type: "string" },
  "max-tokens": { type: "string" },
  "max-minutes": { type: "string" },
  "max-steps": { type: "string" },
  "max-rounds": { type: "string" },
  approve: { type: "boolean" },
  reject: { type: "boolean" },
  changes: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Flags = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>["values"];

function limitsFrom(flags: Flags): Limits {
  const number = (name: "max-usd" | "max-tokens" | "max-minutes" | "max-steps" | "max-rounds" | "max-re-edits") => {
    const raw = flags[name];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new UsageError(`--${name} needs a number, not "${raw}".`);
    return value;
  };
  const usd = number("max-usd");
  const minutes = number("max-minutes");
  const limits: Limits = {
    ...(usd !== undefined ? { max_cost_micro_usd: Math.round(usd * 1_000_000) } : {}),
    ...(number("max-tokens") !== undefined ? { max_tokens: Math.round(number("max-tokens")!) } : {}),
    ...(minutes !== undefined ? { max_active_ms: Math.round(minutes * 60_000) } : {}),
    ...(number("max-steps") !== undefined ? { max_steps: Math.round(number("max-steps")!) } : {}),
    ...(number("max-rounds") !== undefined ? { max_rounds: Math.round(number("max-rounds")!) } : {}),
    ...(number("max-re-edits") !== undefined ? { max_re_edits: Math.round(number("max-re-edits")!) } : {}),
  };
  return limits;
}

const exitCode = (outcome: RunOutcome) => (outcome.status === "succeeded" ? 0 : outcome.status === "waiting_gate" || outcome.status === "paused" ? 2 : 1);

/** Runs one command and returns the process exit code: 0 done, 2 waiting on you, 1 anything else. */
export async function main(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true });
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { values: flags, positionals } = parsed;
  const [command, runId] = positionals;
  if (flags.help || !command) {
    io.out(`${USAGE}\n`);
    return flags.help ? 0 : 1;
  }

  const store = new JsonlEventStore(resolve(io.cwd, flags["runs-dir"] ?? io.env.HARNESS_RUNS_DIR ?? "runs"));
  const workDir = (run: string) => join(store.runDir(run), "work");
  const needRun = () => {
    if (!runId) throw new UsageError(`"harness ${command}" needs a run id.`);
    return runId;
  };
  // Whole lines go through `line`. Model text is written as it arrives, without one.
  const line = (text: string) => io.out(`${text}\n`);
  const providerFor = (model: string): ModelProvider => {
    if (model.startsWith("claude-")) {
      const apiKey = io.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new UsageError("Set ANTHROPIC_API_KEY to your Anthropic API key first.");
      // ANTHROPIC_BASE_URL points the same Messages API at another host, such as a Microsoft Foundry
      // resource: https://<resource>.services.ai.azure.com/anthropic
      return new ClaudeProvider({
        apiKey,
        ...(io.env.ANTHROPIC_BASE_URL ? { baseUrl: io.env.ANTHROPIC_BASE_URL.replace(/\/+$/, "") } : {}),
        ...(io.fetch ? { fetch: io.fetch } : {}),
      });
    }
    const apiKey = io.env.MODEL_API_KEY;
    const baseUrl = io.env.MODEL_BASE_URL;
    if (!apiKey) throw new UsageError(`Set MODEL_API_KEY to the API key for ${model} first.`);
    // Such as a Microsoft Foundry resource: https://<resource>.services.ai.azure.com/openai/v1
    if (!baseUrl) throw new UsageError(`Set MODEL_BASE_URL to the address of the API that serves ${model} first.`);
    return new OpenAICompatibleProvider({ apiKey, baseUrl, ...(io.fetch ? { fetch: io.fetch } : {}) });
  };
  const drive = async (id: string): Promise<number> => {
    const recorded = await store.read(id);
    const provider = providerFor(foldRun(recorded).config.model);
    const renderer = new Renderer(line, false);
    let streaming = false;
    const engine = new Engine({
      store,
      provider,
      workDir,
      artifactsDir: (run) => join(store.runDir(run), "artifacts"),
      // What the run was started as decides its tools and its sandbox, so a resume builds the same ones.
      ...pipelineFor(recorded, io),
      onText: (delta) => {
        streaming = true;
        io.out(delta);
      },
      onEvent: (event) => {
        // End the line the model was typing before saying what happened next.
        if (streaming && event.type !== "model.call.started") {
          io.out("\n");
          streaming = false;
        }
        renderer.event(event);
      },
    });
    const outcome = await engine.run(id, io.signal ? { signal: io.signal } : {});
    if (streaming) io.out("\n");
    for (const text of describeOutcome(outcome, detailOf(await store.read(id), workDir(id)))) line(text);
    return exitCode(outcome);
  };

  try {
    switch (command) {
      case "run": {
        if (!flags.task) throw new UsageError('"harness run" needs --task "what to do".');
        const network = networkFrom(flags.network) ?? (flags.sandbox ? "none" : undefined);
        const id = await createRun(store, {
          task: flags.task,
          model: flags.model ?? io.env.MODEL_NAME ?? "claude-opus-5-5",
          system: flags.system ?? DEFAULT_SYSTEM,
          maxOutputTokens: 64_000,
          limits: limitsFrom(flags),
          ...(network ? { sandboxNetwork: network } : {}),
        });
        return await drive(id);
      }
      case "reel": {
        const reel = await reelRun(flags, io.cwd);
        const id = await createRun(store, {
          ...reel.input,
          model: flags.model ?? io.env.MODEL_NAME ?? "claude-opus-5-5",
          limits: { max_re_edits: DEFAULT_RE_EDITS, ...limitsFrom(flags) },
        });
        await reel.prepare(workDir(id));
        return await drive(id);
      }
      case "resume": {
        const id = needRun();
        const state = foldRun(await store.read(id));
        const decision = flags.approve ? "approved" : flags.reject ? "rejected" : flags.changes !== undefined ? "changes_requested" : undefined;
        // Approving a reel's script is also when the creator hands over their reading of it.
        const scriptApproval = decision === "approved" && state.pendingGate === "script" && state.config.pipeline === "reel";
        if ((flags.voiceover !== undefined || flags["no-voiceover"]) && !scriptApproval) {
          throw new UsageError("--voiceover and --no-voiceover go with --approve, when a reel is waiting for its script to be reviewed.");
        }
        if (decision) {
          if (!state.pendingGate) throw new UsageError("This run is not waiting for a review.");
          const notes = flags.changes ? [flags.changes] : [];
          if (scriptApproval) notes.push(await takeVoiceover(workDir(id), flags, io.cwd));
          await decideGate(store, id, { gate: state.pendingGate, decision, notes });
        }
        const limits = limitsFrom(flags);
        if (Object.keys(limits).length) await updateBudget(store, id, limits);
        await requestResume(store, id);
        return await drive(id);
      }
      case "inspect": {
        for (const text of describeSummary(summarizeRun(await store.read(needRun())))) line(text);
        return 0;
      }
      case "replay": {
        const renderer = new Renderer(line, true);
        for (const event of await store.read(needRun())) renderer.event(event);
        return 0;
      }
      case "cancel": {
        const state = await requestCancel(store, needRun());
        line(state.status === "cancelled" ? "Cancelled." : "Asked the run to stop. It ends at its next step.");
        return 0;
      }
      default:
        throw new UsageError(`There is no "${command}" command.`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${err.message}\n\n${USAGE}`);
      return 1;
    }
    if (err instanceof RunNotFoundError) {
      io.err(`There is no run ${err.runId} in the runs folder.`);
      return 1;
    }
    io.err(`Something went wrong: ${(err as Error).message}`);
    return 1;
  }
}
