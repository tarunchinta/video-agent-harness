import { retryAfterMs, SearchError, searchErrorKind, type SearchOptions, type SearchProvider, type SearchResult } from "@harness/harness";

export type BraveSearchOptions = {
  apiKey: string;
  /** Defaults to the public API. */
  baseUrl?: string;
  /** Replaces the global `fetch`, for tests. */
  fetch?: typeof fetch;
};

const DEFAULT_BASE = "https://api.search.brave.com/res/v1";
/** The API returns at most 20 web results per request. */
const MAX_COUNT = 20;

type BraveResult = { url?: unknown; title?: unknown; description?: unknown; page_age?: unknown; age?: unknown };

const strip = (text: string) => text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/**
 * Web search through the Brave Search API, with plain HTTP: one `GET /web/search` per query. One attempt per
 * call; the tool that uses it decides what to retry.
 */
export class BraveSearchProvider implements SearchProvider {
  readonly id = "brave";
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: BraveSearchOptions) {
    if (!options.apiKey) throw new Error("Brave search needs an API key.");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  }

  async search(query: string, { count, signal }: SearchOptions): Promise<SearchResult[]> {
    const url = new URL(`${this.baseUrl}/web/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.max(1, Math.min(MAX_COUNT, count))));
    url.searchParams.set("text_decorations", "false");
    url.searchParams.set("safesearch", "moderate");
    let response: Response;
    try {
      response = await this.fetch(url, { headers: { accept: "application/json", "x-subscription-token": this.options.apiKey }, signal });
    } catch (err) {
      if (signal.aborted) throw new SearchError("aborted", "The search was stopped.");
      throw new SearchError("transport", `Brave search could not be reached: ${(err as Error).message}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SearchError(searchErrorKind(response.status), `Brave search answered ${response.status}.`, retryAfterMs(response.headers.get("retry-after")));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SearchError("upstream", "Brave search sent an answer that is not JSON.");
    }
    const results = ((body as { web?: { results?: unknown } }).web?.results ?? []) as BraveResult[];
    if (!Array.isArray(results)) return [];
    return results.flatMap((r) => {
      if (typeof r.url !== "string" || typeof r.title !== "string") return [];
      const published = typeof r.page_age === "string" ? r.page_age : typeof r.age === "string" ? r.age : undefined;
      return [{ url: r.url, title: strip(r.title), snippet: typeof r.description === "string" ? strip(r.description) : "", ...(published ? { published } : {}) }];
    });
  }
}
