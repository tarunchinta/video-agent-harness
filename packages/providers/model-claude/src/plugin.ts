import { z } from "zod";
import { definePlugin } from "@harness/contract";
import { MODELS, type ModelInfo } from "./models.ts";
import { ClaudeProvider } from "./provider.ts";

/**
 * Claude as a plugin: it routes every model whose name starts with `claude-` to the Messages API. The key is a
 * secret, read from `ANTHROPIC_API_KEY` when the provider is first needed, so a profile can list this plugin
 * without a key and only the run that asks for Claude needs one.
 */
export const claudeModelPlugin = definePlugin({
  name: "model-claude",
  version: "0.1.0",
  provides: ["models"],
  config: z.object({
    /** Another host for the same API, such as a Microsoft Foundry resource. */
    baseUrl: z.string().url().optional(),
    /** Corrected or added models, merged over the built-in table. */
    models: z.record(z.string(), z.custom<ModelInfo>()).optional(),
    pricesCheckedOn: z.string().optional(),
    /** Replaces `fetch`, for tests. Not part of the config hash: functions are left out of it. */
    fetch: z.custom<typeof globalThis.fetch>((value) => typeof value === "function").optional(),
  }),
  apply(ctx, config) {
    ctx.models.register({
      name: "claude",
      handles: (model) => model.startsWith("claude-"),
      create: () => {
        const apiKey = ctx.secret("ANTHROPIC_API_KEY");
        if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY to your Anthropic API key first.");
        return new ClaudeProvider({
          apiKey,
          ...(config.baseUrl ? { baseUrl: config.baseUrl.replace(/\/+$/, "") } : {}),
          ...(config.fetch ? { fetch: config.fetch } : {}),
          ...(config.models ? { models: config.models } : {}),
          ...(config.pricesCheckedOn ? { pricesCheckedOn: config.pricesCheckedOn } : {}),
        });
      },
    });
  },
});

/** Models this plugin knows, for a front end to offer. */
export const claudeModels = (): string[] => Object.keys(MODELS);
