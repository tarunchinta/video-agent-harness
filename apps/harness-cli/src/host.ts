import { join } from "node:path";
import { Engine, foldRun, type HarnessEvent, type ModelProvider, type RunOutcome, type RunStore } from "@harness/harness";
import { ClaudeProvider, MODELS as CLAUDE_MODELS } from "@harness/model-claude";
import { OpenAICompatibleProvider, MODELS as OPENAI_MODELS } from "@harness/model-openai-compatible";
import { mergePrices, priceOverrides } from "./prices.ts";
import { bootDefault } from "./plugins.ts";
import { pipelineFor, UsageError, type PipelineDeps } from "./pipeline.ts";

/**
 * How a run is driven, shared by the terminal and the web UI: which provider answers for a model, and the
 * engine built from what the run was started as. Both front ends call `driveRun`, so a run behaves the same
 * whichever one picks it up.
 */

export type HostIo = {
  env: Record<string, string | undefined>;
  /** Replaces the global `fetch`, for tests. */
  fetch?: typeof fetch;
} & PipelineDeps;

export const DEFAULT_MODEL = "claude-opus-5-5";

export const defaultModel = (env: Record<string, string | undefined>) => env.MODEL_NAME ?? DEFAULT_MODEL;

export function providerFor(model: string, io: HostIo): ModelProvider {
  // Corrected prices from HARNESS_PRICES, when set. They go on the run's record with the date they were checked.
  const prices = priceOverrides(io.env);
  const checked = prices ? { pricesCheckedOn: prices.checked_on } : {};
  if (model.startsWith("claude-")) {
    const models = mergePrices(CLAUDE_MODELS, prices, (m) => ({ ...m, adaptiveThinking: true, fallbacks: false }));
    const apiKey = io.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new UsageError("Set ANTHROPIC_API_KEY to your Anthropic API key first.");
    // ANTHROPIC_BASE_URL points the same Messages API at another host, such as a Microsoft Foundry
    // resource: https://<resource>.services.ai.azure.com/anthropic
    return new ClaudeProvider({
      apiKey,
      ...(io.env.ANTHROPIC_BASE_URL ? { baseUrl: io.env.ANTHROPIC_BASE_URL.replace(/\/+$/, "") } : {}),
      ...(io.fetch ? { fetch: io.fetch } : {}),
      ...(models ? { models, ...checked } : {}),
    });
  }
  const apiKey = io.env.MODEL_API_KEY;
  const baseUrl = io.env.MODEL_BASE_URL;
  if (!apiKey) throw new UsageError(`Set MODEL_API_KEY to the API key for ${model} first.`);
  // Such as a Microsoft Foundry resource: https://<resource>.services.ai.azure.com/openai/v1
  if (!baseUrl) throw new UsageError(`Set MODEL_BASE_URL to the address of the API that serves ${model} first.`);
  const models = mergePrices(OPENAI_MODELS, prices, (m) => m);
  return new OpenAICompatibleProvider({ apiKey, baseUrl, ...(io.fetch ? { fetch: io.fetch } : {}), ...(models ? { models, ...checked } : {}) });
}

/** Models a front end can offer, given which keys are set. The configured default comes first. */
export function availableModels(env: Record<string, string | undefined>): string[] {
  const models = [defaultModel(env)];
  if (env.ANTHROPIC_API_KEY) models.push(DEFAULT_MODEL, "claude-sonnet-5-5", "claude-haiku-5-5");
  return [...new Set(models)];
}

export type DriveHooks = {
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void;
  onText?: (delta: string) => void;
};

export type { RunStore };

export const workDirOf = (store: RunStore, runId: string) => join(store.runDir(runId), "work");

/**
 * Builds the engine for a run from its own record, and drives it until it finishes, pauses or waits. The model
 * provider, web search and sandbox come from the plugin profile; the run's own record decides which of them it
 * uses, so a resume builds the same ones.
 */
export async function driveRun(store: RunStore, runId: string, io: HostIo, hooks: DriveHooks = {}): Promise<RunOutcome> {
  const recorded = await store.read(runId);
  const plugins = await bootDefault(io.env, io.fetch);
  try {
    const model = foldRun(recorded).config.model;
    let provider: ModelProvider;
    try {
      provider = plugins.model(model);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    const search = io.search ?? plugins.search();
    const engine = new Engine({
      store,
      provider,
      workDir: (run) => workDirOf(store, run),
      artifactsDir: (run) => join(store.runDir(run), "artifacts"),
      ...pipelineFor(recorded, { ...io, ...(search ? { search } : {}), ...(plugins.sandbox ? { sandboxDriver: plugins.sandbox } : {}) }),
      ...(hooks.onText ? { onText: hooks.onText } : {}),
      ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
    });
    return await engine.run(runId, hooks.signal ? { signal: hooks.signal } : {});
  } finally {
    await plugins.dispose();
  }
}
