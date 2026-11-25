import { z } from "zod";
import { defineTool, inStage, SearchError, ToolError, type SearchProvider, type SearchResult } from "@harness/harness";

const MAX_RESULTS = 10;
const ATTEMPTS = 3;

const pickedSchema = z.object({
  results: z
    .array(
      z.object({
        n: z.number().int().positive().describe("The number of the result, as listed."),
        title: z.string().max(120).describe("The page's title, shortened if needed."),
        covers: z.string().max(200).describe("What the page appears to say about the question, in one plain sentence."),
      }),
    )
    .max(MAX_RESULTS),
});

const outputSchema = z.object({
  query: z.string(),
  results: z.array(z.object({ url: z.string(), host: z.string(), title: z.string(), covers: z.string(), published: z.string().optional() })),
});

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new ToolError("The search was stopped."));
    }, { once: true });
  });

async function searchWithRetries(provider: SearchProvider, query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await provider.search(query, { count, signal });
    } catch (err) {
      if (!(err instanceof SearchError)) throw new ToolError("The search failed.", "Try again, or fetch a source you already know.");
      if (err.kind === "aborted" || signal.aborted) throw new ToolError("The search was stopped.");
      if (!err.retryable || attempt >= ATTEMPTS) {
        throw new ToolError(
          err.kind === "auth" ? "Web search is not set up: the search service refused the key." : `Web search did not work right now (${err.kind}).`,
          "Carry on with the sources you have, and fetch pages you already know of with web_fetch.",
        );
      }
      await sleep(Math.min(err.retryAfterMs ?? 1_000 * 2 ** (attempt - 1), 10_000), signal);
    }
  }
}

/**
 * Finds pages about a question. A search engine's titles and snippets are written by strangers, so they never
 * reach the agent: they go to a tool-less call that picks the relevant results by number and describes each in
 * a short checked sentence. The addresses the agent gets are taken from the search results in code, by those
 * numbers, so the reading call cannot invent or alter an address.
 */
export function webSearchTool(provider: SearchProvider) {
  return defineTool({
    name: "web_search",
    description:
      "Search the web for pages about one question. You get back up to ten addresses, each with a short note on what the page seems to cover, " +
      "not the pages themselves: read the ones worth reading with web_fetch. Prefer primary sources (papers, official statistics, the organisation's own page) over articles about them.",
    input: z.object({
      query: z.string().min(3).max(300).describe("What to search for, as you would type it into a search engine."),
      question: z.string().min(8).max(400).describe("What you want to find out, so only results that can answer it are kept."),
    }),
    output: outputSchema,
    untrusted: true,
    readOnly: true,
    idempotent: true,
    parallelSafe: true,
    requires: [inStage("research", "script")],
    timeoutMs: 90_000,
    async execute(input, exec) {
      const found = (await searchWithRetries(provider, input.query, MAX_RESULTS, exec.signal))
        .filter((r) => URL.canParse(r.url) && /^https?:$/.test(new URL(r.url).protocol))
        .slice(0, MAX_RESULTS);
      if (!found.length) return { query: input.query, results: [] };
      const listing = found
        .map((r, i) => `${i + 1}. ${r.title.slice(0, 300)}\n${r.url}\n${r.snippet.slice(0, 600)}${r.published ? `\nDated: ${r.published.slice(0, 40)}` : ""}`)
        .join("\n\n");
      const picked = await exec.extract({
        instructions:
          `These are web search results for the query ${JSON.stringify(input.query)}. ` +
          `Keep only the results that look able to answer this question: ${JSON.stringify(input.question)}, best first. ` +
          "For each, give its number as listed, its title, and what it appears to cover, judged only from the listing. Leave out advertising, shops and content farms.",
        untrusted: listing,
        schema: pickedSchema,
      });
      const used = new Set<number>();
      const results = picked.results.flatMap((p) => {
        const hit = found[p.n - 1];
        if (!hit || used.has(p.n)) return [];
        used.add(p.n);
        return [{ url: hit.url, host: new URL(hit.url).hostname, title: p.title, covers: p.covers, ...(hit.published ? { published: hit.published.slice(0, 40) } : {}) }];
      });
      return { query: input.query, results };
    },
    render(_input, value) {
      if (!value.results.length) return `Nothing found for ${JSON.stringify(value.query)} that answers the question. Try other words, or a source you know.`;
      const rows = value.results.map((r, i) => `${i + 1}. ${r.title} (${r.host})${r.published ? `, ${r.published}` : ""}\n   ${r.url}\n   ${r.covers}`);
      return `${rows.join("\n")}\n\nThese notes come from search listings, not the pages. Read a page with web_fetch before using anything from it.`;
    },
  });
}
