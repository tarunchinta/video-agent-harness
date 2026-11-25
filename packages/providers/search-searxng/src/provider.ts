import { retryAfterMs, SearchError, searchErrorKind, type SearchOptions, type SearchProvider, type SearchResult } from "@harness/harness";

export type SearxngSearchOptions = {
  /** The instance, for example `http://localhost:8888`. Its settings must allow the `json` format. */
  baseUrl: string;
  /** Replaces the global `fetch`, for tests. */
  fetch?: typeof fetch;
};

type SearxngResult = { url?: unknown; title?: unknown; content?: unknown; publishedDate?: unknown };

/**
 * Web search through a SearXNG instance, with plain HTTP: one `GET /search?format=json` per query. SearXNG is
 * open source and needs no key, so anyone cloning the harness can run their own.
 */
export class SearxngSearchProvider implements SearchProvider {
  readonly id = "searxng";
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: SearxngSearchOptions) {
    if (!options.baseUrl) throw new Error("SearXNG search needs the address of an instance.");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async search(query: string, { count, signal }: SearchOptions): Promise<SearchResult[]> {
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("safesearch", "1");
    let response: Response;
    try {
      response = await this.fetch(url, { headers: { accept: "application/json" }, signal });
    } catch (err) {
      if (signal.aborted) throw new SearchError("aborted", "The search was stopped.");
      throw new SearchError("transport", `The SearXNG instance could not be reached: ${(err as Error).message}`);
    }
    if (response.status === 403) {
      await response.body?.cancel().catch(() => {});
      // SearXNG answers 403 when the json format is turned off in its settings.
      throw new SearchError("invalid_request", "The SearXNG instance refused a JSON search. Add json to search.formats in its settings.yml.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SearchError(searchErrorKind(response.status), `The SearXNG instance answered ${response.status}.`, retryAfterMs(response.headers.get("retry-after")));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SearchError("upstream", "The SearXNG instance sent an answer that is not JSON.");
    }
    const results = (body as { results?: unknown }).results;
    if (!Array.isArray(results)) return [];
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    for (const r of results as SearxngResult[]) {
      if (typeof r.url !== "string" || typeof r.title !== "string" || seen.has(r.url)) continue;
      seen.add(r.url);
      out.push({
        url: r.url,
        title: r.title.trim(),
        snippet: typeof r.content === "string" ? r.content.replace(/\s+/g, " ").trim() : "",
        ...(typeof r.publishedDate === "string" ? { published: r.publishedDate } : {}),
      });
      if (out.length >= count) break;
    }
    return out;
  }
}
