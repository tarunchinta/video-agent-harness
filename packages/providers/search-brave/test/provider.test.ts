import { describe, expect, it } from "vitest";
import type { SearchError } from "@harness/harness";
import { testSearchProvider } from "@harness/contract/conformance";
import { BraveSearchProvider } from "../src/index.ts";

/** A recorded answer in the shape the Brave Search API documents. */
const ANSWER = {
  type: "search",
  web: {
    results: [
      { title: "Library visits, <strong>2026</strong> release", url: "https://stats.example/visits", description: "Visits fell <strong>12 percent</strong> in spring.", page_age: "2026-06-02T00:00:00" },
      { title: "No address" },
      { title: "Where did the readers go?", url: "https://news.example/readers", description: "A report." },
    ],
  },
};

const fake = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const seen: { url: string; headers: Headers }[] = [];
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
};

describe("Brave search", () => {
  it("sends the key in its header and turns the answer into plain results", async () => {
    const { fetch, seen } = fake(200, ANSWER);
    const results = await new BraveSearchProvider({ apiKey: "test-key", fetch }).search("library visits", { count: 5, signal: new AbortController().signal });
    expect(results).toEqual([
      { url: "https://stats.example/visits", title: "Library visits, 2026 release", snippet: "Visits fell 12 percent in spring.", published: "2026-06-02T00:00:00" },
      { url: "https://news.example/readers", title: "Where did the readers go?", snippet: "A report." },
    ]);
    expect(seen[0]!.url).toBe("https://api.search.brave.com/res/v1/web/search?q=library+visits&count=5&text_decorations=false&safesearch=moderate");
    expect(seen[0]!.headers.get("x-subscription-token")).toBe("test-key");
  });

  it("reports failures by kind", async () => {
    const signal = new AbortController().signal;
    const kind = async (status: number, headers: Record<string, string> = {}) => {
      const error = await new BraveSearchProvider({ apiKey: "k", fetch: fake(status, {}, headers).fetch }).search("q", { count: 1, signal }).catch((e: unknown) => e);
      return error as SearchError;
    };
    expect((await kind(401)).kind).toBe("auth");
    const limited = await kind(429, { "retry-after": "2" });
    expect([limited.kind, limited.retryable, limited.retryAfterMs]).toEqual(["rate_limited", true, 2000]);
    expect((await kind(503)).kind).toBe("upstream");
  });

  testSearchProvider("Brave", (fetch) => new BraveSearchProvider({ apiKey: "k", fetch }), {
    ok: () => new Response(JSON.stringify(ANSWER), { status: 200 }),
    empty: () => new Response(JSON.stringify({ type: "search" }), { status: 200 }),
    status: (code) => new Response("{}", { status: code }),
  });
});
