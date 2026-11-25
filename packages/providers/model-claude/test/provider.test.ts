import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRun, Engine, MemoryEventStore, ModelError, type ModelRequest, type ModelResponse } from "@harness/harness";
import { testModelProvider } from "@harness/contract/conformance";
import { ClaudeProvider, readSse, type ClaudeProviderOptions } from "../src/index.ts";

/**
 * The streams below are written to the format the API documents for server-sent events. They were not
 * recorded from the live API: there is no network in tests, and no key was used to make them.
 */
type Json = Record<string, unknown>;

const sse = (events: Json[]) => events.map((e) => `event: ${e.type as string}\ndata: ${JSON.stringify(e)}\n\n`).join("");

function body(text: string, chunkBytes = 0): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      if (!chunkBytes) controller.enqueue(bytes);
      else for (let i = 0; i < bytes.length; i += chunkBytes) controller.enqueue(bytes.slice(i, i + chunkBytes));
      controller.close();
    },
  });
}

const ok = (text: string, chunkBytes = 0) => new Response(body(text, chunkBytes), { status: 200, headers: { "content-type": "text/event-stream" } });
const fail = (status: number, error: Json, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: "error", error }), { status, headers: { "content-type": "application/json", ...headers } });

const start = (usage: Json = { input_tokens: 25, output_tokens: 1 }, model = "claude-opus-5-5"): Json => ({
  type: "message_start",
  message: { id: "msg_demo_01", type: "message", role: "assistant", model, content: [], stop_reason: null, usage },
});
const textBlock = (index: number, parts: string[]): Json[] => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...parts.map((text) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } })),
  { type: "content_block_stop", index },
];
const toolBlock = (index: number, id: string, name: string, fragments: string[]): Json[] => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
  ...fragments.map((partial_json) => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } })),
  { type: "content_block_stop", index },
];
const end = (stop_reason: string, output_tokens = 40, extra: Json = {}): Json[] => [
  { type: "message_delta", delta: { stop_reason, stop_sequence: null, ...extra }, usage: { output_tokens } },
  { type: "message_stop" },
];

type Sent = { url: string; headers: Record<string, string>; body: Json };

function make(responses: Array<Response | Error | (() => Response)>, options: Partial<ClaudeProviderOptions> = {}) {
  const sent: Sent[] = [];
  const fake = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) as Json });
    const next = responses[sent.length - 1];
    if (next === undefined) throw new Error("No response was scripted for this request.");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { sent, provider: new ClaudeProvider({ apiKey: "test-key", fetch: fake, ...options }) };
}

const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "claude-opus-5-5",
  system: "You are a test agent.",
  tools: [{ name: "write_file", description: "Write a file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
  messages: [{ role: "user", content: [{ type: "text", text: "Write a note." }] }],
  maxOutputTokens: 16_000,
  ...extra,
});

async function call(provider: ClaudeProvider, req = request(), signal = new AbortController().signal) {
  const deltas: string[] = [];
  let response: ModelResponse | undefined;
  for await (const event of provider.stream(req, signal)) {
    if (event.type === "text_delta") deltas.push(event.text);
    else response = event.response;
  }
  return { deltas, response: response! };
}

const errorOf = async (run: Promise<unknown>): Promise<ModelError> => {
  try {
    await run;
  } catch (err) {
    if (err instanceof ModelError) return err;
    throw err;
  }
  throw new Error("Expected the call to fail.");
};

describe("the request", () => {
  it("is a single streaming POST with caching, thinking and effort set", async () => {
    const { provider, sent } = make([ok(sse([start(), ...textBlock(0, ["Hi"]), ...end("end_turn")]))]);
    await call(provider);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]!.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "test-key",
      "anthropic-version": "2026-10-21",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    });
    expect(sent[0]!.body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 16_000,
      stream: true,
      system: [{ type: "text", text: "You are a test agent.", cache_control: { type: "ephemeral" } }],
      tools: [
        {
          name: "write_file",
          description: "Write a file.",
          input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          eager_input_streaming: true,
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "Write a note." }] }],
      cache_control: { type: "ephemeral" },
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      fallbacks: "default",
    });
  });

  it("follows the run's effort and the provider's options", async () => {
    const { provider, sent } = make([ok(sse([start(), ...end("end_turn")]))], { fallbacks: false, strictHistory: true, thinkingDisplay: "omitted" });
    await call(provider, request({ effort: "low", tools: [], system: "" }));
    const sentBody = sent[0]!.body;
    expect(sentBody.output_config).toEqual({ effort: "low" });
    expect(sentBody.thinking).toEqual({ type: "adaptive", display: "omitted", block_binding: { prefix_mismatch_behavior: "error" } });
    expect(sent[0]!.headers["anthropic-beta"]).toBe("thinking-binding-controls-2026-08-01");
    expect(sentBody).not.toHaveProperty("fallbacks");
    expect(sentBody).not.toHaveProperty("tools");
    expect(sentBody).not.toHaveProperty("system");
  });

  it("sends tool calls, results and the model's own blocks back in the API's shape", async () => {
    const thinking = { type: "thinking", thinking: "Plan the note.", signature: "sig-abc" };
    const { provider, sent } = make([ok(sse([start(), ...end("end_turn")]))]);
    await call(
      provider,
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "Write a note." }] },
          {
            role: "assistant",
            content: [
              { type: "opaque", provider: "claude", data: thinking },
              { type: "opaque", provider: "another-vendor", data: { secret: true } },
              { type: "tool_call", id: "toolu_1", name: "write_file", input: { path: "a.txt" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", toolCallId: "toolu_1", content: "No such folder.", isError: true }] },
        ],
      }),
    );
    expect(sent[0]!.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Write a note." }] },
      { role: "assistant", content: [thinking, { type: "tool_use", id: "toolu_1", name: "write_file", input: { path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "No such folder.", is_error: true }] },
    ]);
  });

  it("sends a tool result's pictures after its text, and leaves out one that has no bytes", async () => {
    const { provider, sent } = make([ok(sse([start(), ...end("end_turn")]))]);
    await call(
      provider,
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "Look at the frames." }] },
          { role: "assistant", content: [{ type: "tool_call", id: "toolu_1", name: "write_file", input: { path: "a.txt" } }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolCallId: "toolu_1",
                content: "Twelve frames.",
                images: [
                  { type: "image", mediaType: "image/jpeg", sha256: "aa", data: "QUJD" },
                  { type: "image", mediaType: "image/png", sha256: "bb" },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect((sent[0]!.body.messages as Json[])[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [
            { type: "text", text: "Twelve frames." },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
          ],
        },
      ],
    });
  });
});

describe("the response", () => {
  const full = sse([
    start({ input_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 30, output_tokens: 1 }),
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Write it, " } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "then read it." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-xyz" } },
    { type: "content_block_stop", index: 0 },
    { type: "ping" },
    ...textBlock(1, ["Writing the note, ", "café ☕."]),
    ...toolBlock(2, "toolu_a", "write_file", ['{"path": "no', 'te.txt", "content": "hel', 'lo"}']),
    ...toolBlock(3, "toolu_b", "list_files", []),
    ...end("tool_use", 77),
  ]);

  it("is assembled from the stream, however the network cuts it up", async () => {
    for (const chunkBytes of [0, 1, 7, 64]) {
      const { provider } = make([ok(full, chunkBytes)]);
      const { deltas, response } = await call(provider);
      expect(deltas).toEqual(["Writing the note, ", "café ☕."]);
      expect(response).toEqual({
        responseId: "msg_demo_01",
        model: "claude-opus-5-5",
        stopReason: "tool_use",
        content: [
          { type: "opaque", provider: "claude", data: { type: "thinking", thinking: "Write it, then read it.", signature: "sig-xyz" } },
          { type: "text", text: "Writing the note, café ☕." },
          { type: "tool_call", id: "toolu_a", name: "write_file", input: { path: "note.txt", content: "hello" } },
          { type: "tool_call", id: "toolu_b", name: "list_files", input: {} },
        ],
        usage: { inputTokens: 12, outputTokens: 77, cacheReadTokens: 900, cacheWriteTokens: 30 },
      });
    }
  });

  it("hands over a tool input that is not valid JSON as it arrived, for the loop to reject", async () => {
    const { provider } = make([ok(sse([start(), ...toolBlock(0, "toolu_a", "write_file", ['{"path": "note.txt", "content": "unterminated']), ...end("tool_use")]))]);
    const { response } = await call(provider);
    expect(response.content).toEqual([{ type: "tool_call", id: "toolu_a", name: "write_file", input: { INVALID_JSON: '{"path": "note.txt", "content": "unterminated' } }]);
  });

  it("names why the model stopped in the loop's terms", async () => {
    const stop = async (reason: string, extra: Json = {}) => (await call(make([ok(sse([start(), ...textBlock(0, ["x"]), ...end(reason, 5, extra)]))]).provider)).response;
    expect((await stop("end_turn")).stopReason).toBe("end_turn");
    expect((await stop("max_tokens")).stopReason).toBe("max_output");
    expect((await stop("pause_turn")).stopReason).toBe("paused");
    expect(await stop("refusal", { stop_details: { type: "refusal", category: "cyber", explanation: "Declined." } })).toMatchObject({
      stopReason: "refusal",
      refusal: { category: "cyber", explanation: "Declined." },
    });
    const overflow = await errorOf(stop("model_context_window_exceeded"));
    expect(overflow.kind).toBe("context_overflow");
  });

  it("reports the model that answered when a fallback took over", async () => {
    const fallback = { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } };
    const { provider } = make([
      ok(sse([start({ input_tokens: 1000, output_tokens: 1 }, "claude-opus-4-8"), { type: "content_block_start", index: 0, content_block: fallback }, { type: "content_block_stop", index: 0 }, ...textBlock(1, ["Done."]), ...end("end_turn", 100)])),
    ]);
    const { response } = await call(provider);
    expect(response.model).toBe("claude-opus-4-8");
    expect(response.content[0]).toEqual({ type: "opaque", provider: "claude", data: fallback });
    // Priced at the rates of the model that answered: 1000 x $5 + 100 x $25 per million.
    expect(provider.priceMicroUsd(response.model!, response.usage)).toBe(7500);
  });
});

describe("failures", () => {
  it("maps HTTP errors to what the loop can retry and what it cannot", async () => {
    const cases: Array<[Response, string, boolean, number | undefined]> = [
      [fail(429, { type: "rate_limit_error", message: "Slow down." }, { "retry-after": "7" }), "rate_limited", true, 7000],
      [fail(529, { type: "overloaded_error", message: "Overloaded." }), "upstream", true, undefined],
      [fail(500, { type: "api_error", message: "Internal error." }), "upstream", true, undefined],
      [fail(401, { type: "authentication_error", message: "Bad key." }), "auth", false, undefined],
      [fail(403, { type: "permission_error", message: "Not allowed." }), "auth", false, undefined],
      [fail(400, { type: "invalid_request_error", message: "prompt is too long: 1200000 tokens > 1000000 maximum" }), "context_overflow", false, undefined],
      [fail(400, { type: "invalid_request_error", message: "messages: field required" }), "invalid_request", false, undefined],
      [fail(429, { type: "rate_limit_error", message: "Spend limit reached." }, { "x-should-retry": "false" }), "invalid_request", false, undefined],
      [new Response("<html>bad gateway</html>", { status: 502 }), "upstream", true, undefined],
    ];
    for (const [response, kind, retryable, retryAfterMs] of cases) {
      const error = await errorOf(call(make([response]).provider));
      expect([error.kind, error.retryable, error.retryAfterMs]).toEqual([kind, retryable, retryAfterMs]);
    }
    expect((await errorOf(call(make([fail(401, { type: "authentication_error", message: "Bad key." })]).provider))).message).toBe("Bad key.");
  });

  it("treats a broken stream as a failed attempt, never as a finished answer", async () => {
    const midStream = sse([start(), ...textBlock(0, ["Half an ans"]), { type: "error", error: { type: "overloaded_error", message: "Overloaded." } }]);
    expect((await errorOf(call(make([ok(midStream)]).provider))).kind).toBe("upstream");

    const cutOff = sse([start(), ...textBlock(0, ["Half an ans"])]);
    const dropped = await errorOf(call(make([ok(cutOff)]).provider));
    expect([dropped.kind, dropped.message]).toEqual(["transport", "The connection closed before the response was complete."]);

    expect((await errorOf(call(make([new TypeError("fetch failed")]).provider))).kind).toBe("transport");
    expect((await errorOf(call(make([ok("event: message_start\ndata: {not json\n\n")]).provider))).kind).toBe("transport");
  });

  it("gives up on a stream that goes quiet, and stops when the caller cancels", async () => {
    const silent = () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    const quiet = await errorOf(call(make([silent], { idleTimeoutMs: 30 }).provider));
    expect([quiet.kind, quiet.retryable]).toEqual(["timeout", true]);

    const controller = new AbortController();
    const hanging = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    const pending = errorOf(call(new ClaudeProvider({ apiKey: "test-key", fetch: hanging }), request(), controller.signal));
    controller.abort();
    expect((await pending).kind).toBe("aborted");
  });

  it("refuses a model it has no entry for, and prices the ones it knows", () => {
    const { provider } = make([]);
    expect(() => provider.capabilities("made-up-model")).toThrow(/no entry for the model "made-up-model"/);
    expect(provider.capabilities("claude-opus-5-5")).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    // 1000 fresh + 9000 cached + 500 written at $4 / $0.20 / $5 per million, 200 out at $20.
    expect(provider.priceMicroUsd("claude-opus-5-5", { inputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 500, outputTokens: 200 })).toBe(12_300);
    // A long prompt on the small model is charged at its higher rate.
    expect(provider.priceMicroUsd("claude-haiku-5-5", { inputTokens: 200_000, outputTokens: 1000 })).toBe(102_500);
    // An answer from a model that is not in the table is charged at the dearest known rate.
    expect(provider.priceMicroUsd("unknown-fallback", { inputTokens: 1000, outputTokens: 100 })).toBe(15_000);
  });
});

describe("with the agent loop", () => {
  it("completes a run, and every request repeats the one before it byte for byte", async () => {
    const turns = [
      sse([start({ input_tokens: 400, output_tokens: 1 }), { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } }, { type: "content_block_stop", index: 0 }, ...toolBlock(1, "toolu_w", "write_file", ['{"path":"note.txt","content":"hello"}']), ...end("tool_use", 30)]),
      sse([start({ input_tokens: 20, cache_read_input_tokens: 430, output_tokens: 1 }), ...toolBlock(0, "toolu_r", "read_file", ['{"path":"note.txt"}']), ...end("tool_use", 20)]),
      sse([start({ input_tokens: 20, cache_read_input_tokens: 470, output_tokens: 1 }), ...toolBlock(0, "toolu_f", "finish", ['{"summary":"Wrote and read the note."}']), ...end("tool_use", 20)]),
    ];
    const { provider, sent } = make(turns.map((t) => ok(t, 16)));
    const store = new MemoryEventStore();
    const workDir = mkdtempSync(join(tmpdir(), "harness-claude-"));
    const engine = new Engine({ store, provider, workDir: () => workDir, worker: "test" });
    const runId = await createRun(store, { task: "Write a note and read it back.", model: "claude-opus-5-5", system: "You are a test agent." });

    const outcome = await engine.run(runId);
    expect(outcome).toMatchObject({ status: "succeeded", result: { summary: "Wrote and read the note." } });
    expect(readFileSync(join(workDir, "note.txt"), "utf8")).toBe("hello");

    expect(sent).toHaveLength(3);
    for (let i = 1; i < sent.length; i += 1) {
      const earlier = sent[i - 1]!.body;
      const later = sent[i]!.body;
      expect(JSON.stringify(later.system)).toBe(JSON.stringify(earlier.system));
      expect(JSON.stringify(later.tools)).toBe(JSON.stringify(earlier.tools));
      const before = JSON.stringify(earlier.messages).slice(0, -1);
      expect(JSON.stringify(later.messages).startsWith(before)).toBe(true);
    }
    // The thinking block went back untouched, ahead of the tool call it belongs to.
    const replayed = (sent[1]!.body.messages as Array<{ role: string; content: Json[] }>)[1]!;
    expect(replayed.content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig-1" });
  });
});

describe("readSse", () => {
  it("handles comments, carriage returns and data over several lines", async () => {
    const events = [];
    for await (const e of readSse(body(": keep-alive\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: three\n\n", 3))) events.push(e);
    expect(events).toEqual([{ event: "a", data: "one\ntwo" }, { event: "message", data: "three" }]);
  });
});

const ERROR_TYPES: Record<number, string> = { 400: "invalid_request_error", 401: "authentication_error", 429: "rate_limit_error", 500: "api_error", 503: "overloaded_error" };

testModelProvider("Claude", (fetch) => new ClaudeProvider({ apiKey: "test-key", fetch }), {
  model: "claude-opus-5-5",
  text: () => ok(sse([start(), ...textBlock(0, ["Hel", "lo"]), ...end("end_turn")])),
  expectText: "Hello",
  toolCall: () => ok(sse([start(), ...toolBlock(0, "toolu_demo_1", "lookup", ['{"q":', '"x"}']), ...end("tool_use")])),
  maxOutput: () => ok(sse([start(), ...textBlock(0, ["Hel"]), ...end("max_tokens")])),
  // The stream stops in the middle of a block, with no message_stop.
  truncated: () => ok(sse([start(), { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }])),
  status: (code, retryAfter) => fail(code, { type: ERROR_TYPES[code] ?? "api_error", message: "Recorded error." }, retryAfter === undefined ? {} : { "retry-after": String(retryAfter) }),
});
