import { describe, expect, it } from "vitest";
import type { SearchError } from "@harness/harness";
import { testSearchProvider } from "@harness/contract/conformance";
import { SearxngSearchProvider } from "../src/index.ts";

/** A recorded answer in the shape SearXNG's JSON format returns. */
const ANSWER = {
  query: "library visits",
  results: [
    { url: "https://stats.example/visits", title: "Library visits, 2026 release ", content: "Visits fell\n12 percent in spring.", publishedDate: "2026-06-02T00:00:00" },
    { url: "https://stats.example/visits", title: "The same page from another engine", content: "Duplicate." },
    { url: "https://news.example/readers", title: "Where did the readers go?" },
  ],
};

const fake = (status: number, body: unknown) => {
  const seen: string[] = [];
  const fetch = (async (url: URL | string) => {
    seen.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
};

describe("SearXNG search", () => {
  it("asks the instance for JSON and keeps each address once", async () => {
    const { fetch, seen } = fake(200, ANSWER);
    const results = await new SearxngSearchProvider({ baseUrl: "http://search.example:8888/", fetch }).search("library visits", { count: 10, signal: new AbortController().signal });
    expect(results).toEqual([
      { url: "https://stats.example/visits", title: "Library visits, 2026 release", snippet: "Visits fell 12 percent in spring.", published: "2026-06-02T00:00:00" },
      { url: "https://news.example/readers", title: "Where did the readers go?", snippet: "" },
    ]);
    expect(seen).toEqual(["http://search.example:8888/search?q=library+visits&format=json&safesearch=1"]);
  });

  it("says how to fix an instance that refuses JSON", async () => {
    const error = (await new SearxngSearchProvider({ baseUrl: "http://search.example", fetch: fake(403, {}).fetch })
      .search("q", { count: 1, signal: new AbortController().signal })
      .catch((e: unknown) => e)) as SearchError;
    expect(error.kind).toBe("invalid_request");
    expect(error.message).toContain("Add json to search.formats");
  });

  testSearchProvider("SearXNG", (fetch) => new SearxngSearchProvider({ baseUrl: "http://search.example", fetch }), {
    ok: () => new Response(JSON.stringify(ANSWER), { status: 200 }),
    empty: () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    status: (code) => new Response("{}", { status: code }),
  });
});
