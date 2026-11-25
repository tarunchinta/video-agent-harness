import { describe, expect, it } from "vitest";
import { SearchError, type SearchProvider } from "@harness/harness";

/**
 * The checks every web search provider must pass. Results are plain values the `web_search` tool can trust in
 * shape (if never in content), and failures say whether trying again can help.
 */
export type SearchFixtures = {
  /** An answer with at least one result. */
  ok: () => Response;
  /** An answer with no results. */
  empty: () => Response;
  status: (code: number) => Response;
};

function scripted(answers: (Response | Error)[]) {
  return (async (_url: URL | string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    const next = answers.shift();
    if (!next) throw new Error("No answer was scripted.");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
}

async function failure(provider: SearchProvider, signal = new AbortController().signal): Promise<SearchError> {
  try {
    await provider.search("query", { count: 5, signal });
  } catch (err) {
    expect(err, "a search provider throws only SearchError").toBeInstanceOf(SearchError);
    return err as SearchError;
  }
  throw new Error("The search was expected to fail, and it returned results.");
}

export function testSearchProvider(name: string, make: (fetch: typeof globalThis.fetch) => SearchProvider, fx: SearchFixtures): void {
  describe(`${name} meets the search provider contract`, () => {
    it("returns results with a web address, a title and a snippet", async () => {
      const results = await make(scripted([fx.ok()])).search("query", { count: 5, signal: new AbortController().signal });
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(5);
      for (const r of results) {
        expect(URL.canParse(r.url)).toBe(true);
        expect(typeof r.title).toBe("string");
        expect(typeof r.snippet).toBe("string");
      }
    });

    it("returns an empty list when nothing matches", async () => {
      expect(await make(scripted([fx.empty()])).search("query", { count: 5, signal: new AbortController().signal })).toEqual([]);
    });

    it("maps failures to kinds a tool can act on", async () => {
      for (const [code, kind, retryable] of [
        [401, "auth", false],
        [429, "rate_limited", true],
        [500, "upstream", true],
      ] as const) {
        const error = await failure(make(scripted([fx.status(code)])));
        expect([error.kind, error.retryable]).toEqual([kind, retryable]);
      }
      const down = await failure(make(scripted([new TypeError("fetch failed")])));
      expect([down.kind, down.retryable]).toEqual(["transport", true]);
      const cancelled = new AbortController();
      cancelled.abort();
      expect((await failure(make(scripted([fx.ok()])), cancelled.signal)).kind).toBe("aborted");
    });
  });
}
