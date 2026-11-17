import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRun, Engine, MemoryEventStore, ModelError, type ModelRequest, type ModelResponse } from "@harness/harness";
import { OpenAICompatibleProvider, type OpenAICompatibleProviderOptions } from "../src/index.ts";

/**
 * The streams below are written to the chat completions streaming format. They were not recorded from a live
 * API: there is no network in tests, and no key was used to make them.
 */
type Json = Record<string, unknown>;

const MODEL = "DeepSeek-V4.1-Flash";
const BASE_URL = "https://demo-resource.example/openai/v1";

const sse = (chunks: Json[]) => `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;

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
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", ...headers } });

const chunk = (delta: Json, finish_reason: string | null = null): Json => ({ id: "chatcmpl_demo", model: MODEL, choices: [{ index: 0, delta, finish_reason }] });
const usage = (prompt_tokens: number, completion_tokens: number, cached?: number): Json => ({
  id: "chatcmpl_demo",
  choices: [],
  usage: { prompt_tokens, completion_tokens, ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}) },
});
const callTool = (index: number, id: string, name: string, fragments: string[]): Json[] =>
  fragments.map((args, i) => chunk({ tool_calls: [{ index, ...(i === 0 ? { id, type: "function" } : {}), function: { ...(i === 0 ? { name } : {}), arguments: args } }] }));

type Sent = { url: string; headers: Record<string, string>; body: Json };

function make(responses: Array<Response | Error>, options: Partial<OpenAICompatibleProviderOptions> = {}) {
  const sent: Sent[] = [];
  const fake = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) as Json });
    const next = responses[sent.length - 1];
    if (next === undefined) throw new Error("No response was scripted for this request.");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { sent, provider: new OpenAICompatibleProvider({ apiKey: "test-key", baseUrl: `${BASE_URL}/`, fetch: fake, ...options }) };
}

const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model: MODEL,
  system: "You are a test agent.",
  tools: [{ name: "write_file", description: "Write a file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
  messages: [{ role: "user", content: [{ type: "text", text: "Write a note." }] }],
  maxOutputTokens: 64_000,
  ...extra,
});

async function call(provider: OpenAICompatibleProvider, req = request()) {
  const deltas: string[] = [];
  let response: ModelResponse | undefined;
  for await (const event of provider.stream(req, new AbortController().signal)) {
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
  it("is a single streaming POST to the chat completions path, capped at the model's output limit", async () => {
    const { provider, sent } = make([ok(sse([chunk({ content: "Hi" }, "stop"), usage(10, 1)]))]);
    await call(provider);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${BASE_URL}/chat/completions`);
    expect(sent[0]!.headers).toEqual({ "content-type": "application/json", authorization: "Bearer test-key" });
    expect(sent[0]!.body).toEqual({
      model: MODEL,
      max_tokens: 32_000,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "You are a test agent." },
        { role: "user", content: "Write a note." },
      ],
      tools: [{ type: "function", function: { name: "write_file", description: "Write a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
    });
  });

  it("sends tool calls and their results back as chat messages", async () => {
    const { provider, sent } = make([ok(sse([chunk({ content: "x" }, "stop")]))]);
    await call(
      provider,
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "Write a note." }] },
          { role: "assistant", content: [{ type: "tool_call", id: "call_1", name: "write_file", input: { path: "a.txt" } }] },
          { role: "user", content: [{ type: "tool_result", toolCallId: "call_1", content: "No such folder.", isError: true }] },
        ],
      }),
    );
    expect((sent[0]!.body.messages as Json[]).slice(1)).toEqual([
      { role: "user", content: "Write a note." },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "Error: No such folder." },
    ]);
  });
});

describe("the response", () => {
  const full = sse([
    chunk({ role: "assistant", reasoning_content: "Write it." }),
    chunk({ content: "Writing the note, " }),
    chunk({ content: "café ☕." }),
    ...callTool(0, "call_a", "write_file", ['{"path": "no', 'te.txt", "content": "hello"}']),
    chunk({}, "tool_calls"),
    usage(1000, 77, 900),
  ]);

  it("is assembled from the stream, however the network cuts it up", async () => {
    for (const chunkBytes of [0, 1, 7, 64]) {
      const { deltas, response } = await call(make([ok(full, chunkBytes)]).provider);
      expect(deltas).toEqual(["Writing the note, ", "café ☕."]);
      expect(response).toEqual({
        responseId: "chatcmpl_demo",
        model: MODEL,
        stopReason: "tool_use",
        content: [
          { type: "opaque", provider: "openai-compatible", data: { reasoning_content: "Write it." } },
          { type: "text", text: "Writing the note, café ☕." },
          { type: "tool_call", id: "call_a", name: "write_file", input: { path: "note.txt", content: "hello" } },
        ],
        usage: { inputTokens: 100, outputTokens: 77, cacheReadTokens: 900 },
      });
    }
  });

  it("treats a stream that ends early as a failed attempt", async () => {
    const cut = `data: ${JSON.stringify(chunk({ content: "Half an ans" }))}\n\n`;
    const error = await errorOf(call(make([ok(cut)]).provider));
    expect([error.kind, error.message]).toEqual(["transport", "The connection closed before the response was complete."]);
  });
});

describe("failures", () => {
  it("maps HTTP errors to what the loop can retry and what it cannot", async () => {
    const cases: Array<[Response | Error, string, boolean, number | undefined]> = [
      [fail(429, { code: "429", message: "Slow down." }, { "retry-after": "7" }), "rate_limited", true, 7000],
      [fail(500, { code: "server_error", message: "Internal error." }), "upstream", true, undefined],
      [fail(401, { code: "401", message: "Access denied due to invalid subscription key." }), "auth", false, undefined],
      [fail(400, { code: "context_length_exceeded", message: "Too long." }), "context_overflow", false, undefined],
      [fail(400, { code: "invalid_request", message: "messages: field required" }), "invalid_request", false, undefined],
      [new TypeError("fetch failed"), "transport", true, undefined],
    ];
    for (const [response, kind, retryable, retryAfterMs] of cases) {
      const error = await errorOf(call(make([response]).provider));
      expect([error.kind, error.retryable, error.retryAfterMs]).toEqual([kind, retryable, retryAfterMs]);
    }
  });

  it("needs a key and an address, and refuses a model it has no entry for", () => {
    expect(() => new OpenAICompatibleProvider({ apiKey: "", baseUrl: BASE_URL })).toThrow(/API key/);
    expect(() => new OpenAICompatibleProvider({ apiKey: "test-key", baseUrl: "" })).toThrow(/base URL/);
    expect(() => make([]).provider.capabilities("made-up-model")).toThrow(/no entry for the model "made-up-model"/);
    // 1000 in at $1 and 100 out at $4 per million.
    expect(make([]).provider.priceMicroUsd(MODEL, { inputTokens: 1000, outputTokens: 100 })).toBe(1400);
  });
});

describe("with the agent loop", () => {
  it("completes a run", async () => {
    const turns = [
      sse([...callTool(0, "call_w", "write_file", ['{"path":"note.txt","content":"hello"}']), chunk({}, "tool_calls"), usage(400, 30)]),
      sse([...callTool(0, "call_f", "finish", ['{"summary":"Wrote the note."}']), chunk({}, "tool_calls"), usage(450, 20)]),
    ];
    const { provider, sent } = make(turns.map((t) => ok(t, 16)));
    const store = new MemoryEventStore();
    const workDir = mkdtempSync(join(tmpdir(), "harness-openai-"));
    const engine = new Engine({ store, provider, workDir: () => workDir, worker: "test" });
    const runId = await createRun(store, { task: "Write a note.", model: MODEL, system: "You are a test agent." });

    expect(await engine.run(runId)).toMatchObject({ status: "succeeded", result: { summary: "Wrote the note." } });
    expect(readFileSync(join(workDir, "note.txt"), "utf8")).toBe("hello");
    expect(sent).toHaveLength(2);
  });
});
