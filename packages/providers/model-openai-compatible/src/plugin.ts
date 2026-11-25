import { z } from "zod";
import { definePlugin } from "@harness/contract";
import type { ModelInfo } from "./models.ts";
import { OpenAICompatibleProvider } from "./provider.ts";

/**
 * Any OpenAI-style chat completions API as a plugin. It takes every model the Claude plugin does not, so put it
 * after that plugin in a profile. The key is the secret `MODEL_API_KEY`; the address is `baseUrl` or the
 * environment's `MODEL_BASE_URL`.
 */
export const openAICompatibleModelPlugin = definePlugin({
  name: "model-openai-compatible",
  version: "0.1.0",
  provides: ["models"],
  config: z.object({
    baseUrl: z.string().url().optional(),
    models: z.record(z.string(), z.custom<ModelInfo>()).optional(),
    pricesCheckedOn: z.string().optional(),
    fetch: z.custom<typeof globalThis.fetch>((value) => typeof value === "function").optional(),
  }),
  apply(ctx, config) {
    ctx.models.register({
      name: "openai-compatible",
      handles: (model) => !model.startsWith("claude-"),
      create: (model) => {
        const apiKey = ctx.secret("MODEL_API_KEY");
        const baseUrl = config.baseUrl ?? ctx.secret("MODEL_BASE_URL");
        if (!apiKey) throw new Error(`Set MODEL_API_KEY to the API key for ${model} first.`);
        if (!baseUrl) throw new Error(`Set MODEL_BASE_URL to the address of the API that serves ${model} first.`);
        return new OpenAICompatibleProvider({
          apiKey,
          baseUrl,
          ...(config.fetch ? { fetch: config.fetch } : {}),
          ...(config.models ? { models: config.models } : {}),
          ...(config.pricesCheckedOn ? { pricesCheckedOn: config.pricesCheckedOn } : {}),
        });
      },
    });
  },
});
