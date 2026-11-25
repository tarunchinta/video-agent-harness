import { boot, use, type Harness, type PluginUse } from "@harness/contract";
import { claudeModelPlugin, MODELS as CLAUDE_MODELS } from "@harness/model-claude";
import { MODELS as OPENAI_MODELS, openAICompatibleModelPlugin } from "@harness/model-openai-compatible";
import { dockerSandboxPlugin } from "@harness/sandbox-docker";
import { braveSearchPlugin } from "@harness/search-brave";
import { searxngSearchPlugin } from "@harness/search-searxng";
import { mergePrices, priceOverrides } from "./prices.ts";

/**
 * The plugins the harness runs with, from the environment. One profile for every front end. Secrets (API
 * keys) are not in it: each plugin reads its own when it needs it, so they never reach a config hash or the log.
 *
 * - Models: Claude for `claude-*`, any OpenAI-style API for everything else (`MODEL_BASE_URL`, `MODEL_API_KEY`).
 * - Search: SearXNG when `SEARXNG_URL` is set, else Brave when `BRAVE_SEARCH_API_KEY` is set, else none.
 * - Sandbox: Docker.
 */
export function defaultProfile(env: Record<string, string | undefined>, fetch?: typeof globalThis.fetch): PluginUse[] {
  const prices = priceOverrides(env);
  const checked = prices ? { pricesCheckedOn: prices.checked_on } : {};
  const claudePrices = mergePrices(CLAUDE_MODELS, prices, (m) => ({ ...m, adaptiveThinking: true, fallbacks: false }));
  const openaiPrices = mergePrices(OPENAI_MODELS, prices, (m) => m);
  const withFetch = fetch ? { fetch } : {};
  return [
    use(claudeModelPlugin, {
      ...(env.ANTHROPIC_BASE_URL ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}),
      ...(claudePrices ? { models: claudePrices, ...checked } : {}),
      ...withFetch,
    }),
    use(openAICompatibleModelPlugin, { ...(openaiPrices ? { models: openaiPrices, ...checked } : {}), ...withFetch }),
    use(searxngSearchPlugin, withFetch, { enabled: Boolean(env.SEARXNG_URL) }),
    use(braveSearchPlugin, withFetch, { enabled: !env.SEARXNG_URL && Boolean(env.BRAVE_SEARCH_API_KEY) }),
    use(dockerSandboxPlugin, {}),
  ];
}

export function bootDefault(env: Record<string, string | undefined>, fetch?: typeof globalThis.fetch): Promise<Harness> {
  return boot(defaultProfile(env, fetch), { env });
}

/** `harness plugins`: what is loaded, what each provides, and the hash of its config. */
export function describePlugins(harness: Harness): string[] {
  const lines = harness.plugins.map((p) => {
    const gives = p.provides.length ? `provides ${p.provides.join(", ")}` : "";
    const needs = p.requires.length ? `needs ${p.requires.join(", ")}` : "";
    return `${p.name.padEnd(26)} ${p.version.padEnd(8)} ${p.state.padEnd(8)} ${[gives, needs].filter(Boolean).join("; ")}  config ${p.configSha256.slice(0, 12)}`;
  });
  const search = harness.search();
  return [...lines, "", `Web search: ${search ? search.id : "none (set SEARXNG_URL or BRAVE_SEARCH_API_KEY)"}`, `Sandbox: ${harness.sandbox ? "Docker" : "none"}`];
}
