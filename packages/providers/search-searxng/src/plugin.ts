import { z } from "zod";
import { definePlugin } from "@harness/contract";
import { SearxngSearchProvider } from "./provider.ts";

/** SearXNG as a plugin. It registers only when it has an instance: `baseUrl`, or the environment's `SEARXNG_URL`. */
export const searxngSearchPlugin = definePlugin({
  name: "search-searxng",
  version: "0.1.0",
  provides: ["search"],
  config: z.object({
    baseUrl: z.string().url().optional(),
    fetch: z.custom<typeof globalThis.fetch>((value) => typeof value === "function").optional(),
  }),
  apply(ctx, config) {
    const baseUrl = config.baseUrl ?? ctx.secret("SEARXNG_URL");
    if (!baseUrl) return;
    ctx.search.register("searxng", new SearxngSearchProvider({ baseUrl, ...(config.fetch ? { fetch: config.fetch } : {}) }));
  },
});
