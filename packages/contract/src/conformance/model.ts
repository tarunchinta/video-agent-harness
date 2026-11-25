import { describe, expect, it } from "vitest";
import { ModelError, type ModelProvider, type ModelRequest, type ModelStreamEvent } from "@harness/harness";

/**
 * The checks every model provider must pass before the loop can rely on it (PLUGIN_CONTRACT.md, section 10).
 * A provider package runs this against its own recorded answers: no network, no key. What it proves is the
 * part of the provider interface the loop depends on, whatever the vendor:
 *
 * - a stream is text deltas and then exactly one response, last;
 * - stop reasons, tool calls and usage arrive in the loop's terms;
 * - failures are `ModelError`s whose kind says whether trying again can help, with `Retry-After` passed on;
 * - a stream cut short is a failed attempt, never a short answer;
 * - a cancelled call stops;
 * - the same request always sends the same bytes, so prompt caches hit;
 * - prices are finite, never negative, and grow with tokens.
 */

export type ModelFixtures = {
  /** A model the provider knows. */
  model: string;
  /** An answer that is the text `expectText`, ending the turn. */
  text: () => Response;
  expectText: string;
  /** An answer that calls the tool `lookup` with input `{ "q": "x" }`. */
  toolCall: () => Response;
  /** An answer that stops at the output limit. */
  maxOutput: () => Response;
  /** An answer whose stream stops halfway. */
  truncated: () => Response;
  /** An error answer with this HTTP status, and `Retry-After` in seconds when given. */
  status: (code: number, retryAfterSeconds?: number) => Response;
};

type Fetched = { url: string; body: string };

/** A fetch that answers from a queue and records what was sent. */
function scripted(answers: (Response | Error)[]) {
  const sent: Fetched[] = [];
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? "") });
    if (init?.signal?.aborted) throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    const next = answers.shift();
    if (!next) throw new Error("No answer was scripted for this request.");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const request = (model: string): ModelRequest => ({
  model,
  system: "You are a test agent.",
  tools: [{ name: "lookup", description: "Looks something up.", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
  messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }],
  maxOutputTokens: 1_000,
});

async function collect(provider: ModelProvider, req: ModelRequest, signal = new AbortController().signal): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(req, signal)) events.push(event);
  return events;
}

async function failure(provider: ModelProvider, req: ModelRequest, signal?: AbortSignal): Promise<ModelError> {
  try {
    await collect(provider, req, signal);
  } catch (err) {
    expect(err, "a provider throws only ModelError").toBeInstanceOf(ModelError);
    return err as ModelError;
  }
  throw new Error("The call was expected to fail, and it returned an answer.");
}

export function testModelProvider(name: string, make: (fetch: typeof globalThis.fetch) => ModelProvider, fx: ModelFixtures): void {
  describe(`${name} meets the model provider contract`, () => {
    it("streams text and then exactly one response, last", async () => {
      const { fetch } = scripted([fx.text()]);
      const events = await collect(make(fetch), request(fx.model));
      const responses = events.filter((e) => e.type === "response");
      expect(responses).toHaveLength(1);
      expect(events.at(-1)!.type).toBe("response");
      const response = (events.at(-1) as Extract<ModelStreamEvent, { type: "response" }>).response;
      const deltas = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []));
      expect(deltas.join("")).toBe(fx.expectText);
      expect(response.stopReason).toBe("end_turn");
      expect(response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")).toBe(fx.expectText);
      for (const n of [response.usage.inputTokens, response.usage.outputTokens]) {
        expect(Number.isInteger(n) && n >= 0, "usage is whole, non-negative token counts").toBe(true);
      }
    });

    it("reports a tool call with its input parsed", async () => {
      const { fetch } = scripted([fx.toolCall()]);
      const events = await collect(make(fetch), request(fx.model));
      const response = (events.at(-1) as Extract<ModelStreamEvent, { type: "response" }>).response;
      expect(response.stopReason).toBe("tool_use");
      const call = response.content.find((b) => b.type === "tool_call");
      expect(call).toMatchObject({ type: "tool_call", name: "lookup", input: { q: "x" } });
      expect(typeof (call as { id: unknown }).id).toBe("string");
    });

    it("says when the answer stopped at the output limit", async () => {
      const { fetch } = scripted([fx.maxOutput()]);
      const events = await collect(make(fetch), request(fx.model));
      expect((events.at(-1) as Extract<ModelStreamEvent, { type: "response" }>).response.stopReason).toBe("max_output");
    });

    it("treats a stream that stops halfway as a failed attempt worth retrying", async () => {
      const { fetch } = scripted([fx.truncated()]);
      const error = await failure(make(fetch), request(fx.model));
      expect(error.retryable).toBe(true);
    });

    it("maps failures to kinds the loop can act on", async () => {
      const kinds: [number, string, boolean][] = [
        [401, "auth", false],
        [400, "invalid_request", false],
        [429, "rate_limited", true],
        [500, "upstream", true],
        [503, "upstream", true],
      ];
      for (const [code, kind, retryable] of kinds) {
        const { fetch } = scripted([fx.status(code)]);
        const error = await failure(make(fetch), request(fx.model));
        expect([code, error.kind, error.retryable]).toEqual([code, kind, retryable]);
      }
      const { fetch } = scripted([fx.status(429, 3)]);
      expect((await failure(make(fetch), request(fx.model))).retryAfterMs).toBe(3_000);
    });

    it("reports a network failure as retryable, and stops when cancelled", async () => {
      const down = scripted([new TypeError("fetch failed")]);
      const error = await failure(make(down.fetch), request(fx.model));
      expect([error.kind, error.retryable]).toEqual(["transport", true]);

      const cancelled = new AbortController();
      cancelled.abort();
      const { fetch } = scripted([fx.text()]);
      const stopped = await failure(make(fetch), request(fx.model), cancelled.signal);
      expect(["aborted", "transport"]).toContain(stopped.kind);
    });

    it("sends the same bytes for the same request, so a prompt cache can hit", async () => {
      const { fetch, sent } = scripted([fx.text(), fx.text()]);
      const provider = make(fetch);
      await collect(provider, request(fx.model));
      await collect(provider, request(fx.model));
      expect(sent).toHaveLength(2);
      expect(sent[1]!.body).toBe(sent[0]!.body);
    });

    it("knows the model's limits and prices calls sensibly", () => {
      const { fetch } = scripted([]);
      const provider = make(fetch);
      const caps = provider.capabilities(fx.model);
      expect(caps.contextWindow).toBeGreaterThan(0);
      expect(caps.maxOutputTokens).toBeGreaterThan(0);
      const small = provider.priceMicroUsd(fx.model, { inputTokens: 1_000, outputTokens: 100 });
      const large = provider.priceMicroUsd(fx.model, { inputTokens: 1_000, outputTokens: 10_000 });
      expect(Number.isFinite(small) && small >= 0).toBe(true);
      expect(large).toBeGreaterThan(small);
      expect(provider.priceMicroUsd(fx.model, { inputTokens: 0, outputTokens: 0 })).toBe(0);
      expect(() => provider.capabilities("no-such-model-anywhere")).toThrow();
    });
  });
}
