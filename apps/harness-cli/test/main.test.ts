import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type Io } from "../src/main.ts";

/** Streams in the API's documented server-sent event format, written by hand. Nothing here touches the network. */
type Json = Record<string, unknown>;
const sse = (events: Json[]) => events.map((e) => `event: ${e.type as string}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const turn = (blocks: Json[][], stop: string, input = 1000, output = 100) =>
  sse([
    { type: "message_start", message: { id: "msg_demo", model: "claude-opus-5-5", usage: { input_tokens: input, output_tokens: 1 } } },
    ...blocks.flat(),
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: output } },
    { type: "message_stop" },
  ]);
const say = (index: number, text: string): Json[] => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index },
];
const use = (index: number, id: string, name: string, input: Json): Json[] => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index },
];

function cli(turns: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cli-"));
  let out = "";
  let err = "";
  let calls = 0;
  const io: Io = {
    out: (text) => (out += text),
    err: (text) => (err += `${text}\n`),
    env: { ANTHROPIC_API_KEY: "test-key" },
    cwd,
    fetch: (async () => {
      const next = turns[calls];
      calls += 1;
      if (next === undefined) throw new Error("No response was scripted for this request.");
      return new Response(next, { status: 200 });
    }) as typeof fetch,
  };
  const run = async (...argv: string[]) => {
    out = "";
    err = "";
    const code = await main(argv, io);
    return { code, out, err };
  };
  const runId = () => readdirSync(join(cwd, "runs"))[0]!;
  return { run, runId, cwd, calls: () => calls };
}

const script = [
  turn([say(0, "Writing the note."), use(1, "toolu_w", "write_file", { path: "note.txt", content: "hello" })], "tool_use"),
  turn([use(0, "toolu_f", "finish", { summary: "Wrote note.txt." })], "tool_use"),
];

describe("harness", () => {
  it("runs a task and says what it did", async () => {
    const { run, runId, cwd } = cli(script);
    const result = await run("run", "--task", "Write a note.");
    expect(result.code).toBe(0);
    const id = runId();
    expect(result.out).toBe(
      [`Started run ${id}.`, "Writing the note.", "  write_file: Wrote 5 bytes to note.txt.", "Done. Wrote note.txt.", ""].join("\n"),
    );
    expect(readFileSync(join(cwd, "runs", id, "work", "note.txt"), "utf8")).toBe("hello");
  });

  it("shows what a finished run cost, and plays it back", async () => {
    const { run, runId } = cli(script);
    await run("run", "--task", "Write a note.");
    const id = runId();

    const inspect = await run("inspect", id);
    expect(inspect.code).toBe(0);
    expect(inspect.out).toContain(`Run ${id}: succeeded`);
    // Two calls of 1,000 tokens in and 100 out, at $4 and $20 per million.
    expect(inspect.out).toContain("2 model calls, 2 tool calls, 2,200 tokens, $0.01,");
    expect(inspect.out).toMatch(/model {2}claude-opus-5-5\s+ok\s+\d+\.\d s {2}1,000 in, 100 out, \$0\.0060/);
    expect(inspect.out).toMatch(/tool {3}write_file\s+ok/);

    const replay = await run("replay", id);
    expect(replay.out).toBe([`Started run ${id}.`, "Writing the note.", "  write_file: Wrote 5 bytes to note.txt.", ""].join("\n"));
  });

  it("pauses at a limit and carries on when it is raised", async () => {
    const { run, runId, calls } = cli(script);
    const first = await run("run", "--task", "Write a note.", "--max-tokens", "1000");
    expect(first.code).toBe(2);
    const id = runId();
    expect(first.out).toContain("Reached the limit: 1,100 tokens of 1,000 tokens.");
    expect(first.out).toContain(`Raise it and carry on with: harness resume ${id} --max-usd <amount>`);
    expect(calls()).toBe(1);

    const second = await run("resume", id, "--max-tokens", "100000");
    expect(second.code).toBe(0);
    expect(second.out).toContain("Picked the run back up after the pause.");
    expect(second.out).toContain("Done. Wrote note.txt.");
  });

  it("sends any other model to the OpenAI-style API named in the environment", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "harness-cli-"));
    const chunk = (delta: Json, finish_reason: string | null = null) => ({ id: "chatcmpl_demo", choices: [{ index: 0, delta, finish_reason }] });
    const finish = [
      chunk({ tool_calls: [{ index: 0, id: "call_f", type: "function", function: { name: "finish", arguments: '{"summary":"Said hello."}' } }] }),
      chunk({}, "tool_calls"),
      { id: "chatcmpl_demo", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
    ];
    const sent: Array<{ url: string; headers: Record<string, string>; model: unknown }> = [];
    let out = "";
    const io: Io = {
      out: (text) => (out += text),
      err: () => {},
      env: { MODEL_API_KEY: "test-key", MODEL_BASE_URL: "https://demo-resource.example/openai/v1", MODEL_NAME: "DeepSeek-V4.1-Flash" },
      cwd,
      fetch: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        sent.push({ url: String(url), headers: init!.headers as Record<string, string>, model: (JSON.parse(init!.body as string) as Json).model });
        return new Response(`${finish.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200 });
      }) as typeof fetch,
    };
    expect(await main(["run", "--task", "Say hello."], io)).toBe(0);
    expect(out).toContain("Done. Said hello.");
    expect(sent).toEqual([
      { url: "https://demo-resource.example/openai/v1/chat/completions", headers: expect.objectContaining({ authorization: "Bearer test-key" }), model: "DeepSeek-V4.1-Flash" },
    ]);

    const missing = { ...io, env: { MODEL_BASE_URL: "https://demo-resource.example/openai/v1" }, err: (text: string) => (out = text) };
    expect(await main(["run", "--task", "Say hello.", "--model", "DeepSeek-V4.1-Flash"], missing)).toBe(1);
    expect(out).toContain("Set MODEL_API_KEY to the API key for DeepSeek-V4.1-Flash first.");
  });

  it("explains what is missing instead of failing obscurely", async () => {
    const { run } = cli([]);
    expect((await run("run")).err).toContain('"harness run" needs --task "what to do".');
    expect((await run("inspect", "no-such-run")).err).toContain("There is no run no-such-run in the runs folder.");
    expect((await run("resume")).err).toContain('"harness resume" needs a run id.');
    expect((await run("run", "--task", "x", "--max-usd", "lots")).err).toContain('--max-usd needs a number, not "lots".');
    expect((await run("dance")).err).toContain('There is no "dance" command.');
    expect((await run()).code).toBe(1);
  });
});
