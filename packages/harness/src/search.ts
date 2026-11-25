/**
 * What the loop needs from a web search backend, in its own vocabulary. A provider package (Brave, SearXNG)
 * translates to and from its API; nothing here names a vendor. Results are text written by strangers: a tool
 * that uses a provider must pass them through a tool-less call before the agent sees any of them.
 */

export type SearchResult = {
  url: string;
  title: string;
  /** The search engine's excerpt of the page. */
  snippet: string;
  /** The page's own date, when the engine reports one. */
  published?: string;
};

export type SearchOptions = {
  /** Most results wanted. A provider may return fewer. */
  count: number;
  signal: AbortSignal;
};

export interface SearchProvider {
  readonly id: string;
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

export type SearchErrorKind = "auth" | "rate_limited" | "upstream" | "invalid_request" | "transport" | "aborted";

const RETRYABLE: ReadonlySet<SearchErrorKind> = new Set(["rate_limited", "upstream", "transport"]);

/** The only error a search provider throws. */
export class SearchError extends Error {
  readonly retryable: boolean;
  constructor(public readonly kind: SearchErrorKind, message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = "SearchError";
    this.retryable = RETRYABLE.has(kind);
  }
}

/** The kind a provider should report for an HTTP status. */
export function searchErrorKind(status: number): SearchErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream";
  return "invalid_request";
}

/** Seconds or an HTTP date in `Retry-After`, as milliseconds. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
