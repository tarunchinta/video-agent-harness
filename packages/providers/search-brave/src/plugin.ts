import { z } from "zod";
import { definePlugin } from "@harness/contract";
import { BraveSearchProvider } from "./provider.ts";

/** Brave Search as a plugin. It registers only when the secret `BRAVE_SEARCH_API_KEY` is set. */
export const braveSearchPlugin = definePlugin({
  name: "search-brave",
  version: "0.1.0",
  provides: ["search"],
  config: z.object({
    baseUrl: z.string().url().optional(),
    fetch: z.custom<typeof globalThis.fetch>((value) => typeof value === "function").optional(),
  }),
  apply(ctx, config) {
    const apiKey = ctx.secret("BRAVE_SEARCH_API_KEY");
    if (!apiKey) return;
    ctx.search.register("brave", new BraveSearchProvider({ apiKey, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}), ...(config.fetch ? { fetch: config.fetch } : {}) }));
  },
});
