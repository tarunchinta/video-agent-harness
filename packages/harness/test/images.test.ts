import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildRequest, decideGate, defineTool, deriveContext, fileTools, payloadOf, requestHash, sniffImage, viewImageTool,
  type ToolDefinition, type ToolResultBlock,
} from "../src/index.ts";
import { respond, toolCall } from "../src/testing/index.ts";
import { expectWellFormed, newRun, ofType, setup } from "./helpers.ts";

/** A one-pixel PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const SHA = createHash("sha256").update(PNG).digest("hex");
const tools = [...fileTools, viewImageTool] as ToolDefinition[];

function world() {
  const root = mkdtempSync(join(tmpdir(), "harness-images-"));
  const workDir = join(root, "work");
  const artifacts = join(root, "artifacts");
  mkdirSync(workDir, { recursive: true });
  return { workDir, artifacts };
}

const resultOf = (request: { messages: { content: unknown[] }[] }, n: number) =>
  request.messages.flatMap((m) => m.content).filter((b): b is ToolResultBlock => (b as { type: string }).type === "tool_result")[n]!;

describe("pictures in tool results", () => {
  it("shows the model a picture, names it by hash in the log and keeps the bytes beside the run", async () => {
    const { workDir, artifacts } = world();
    const script = [
      respond([toolCall("write_file", { path: "note.txt", content: "x" })]),
      respond([toolCall("view_image", { path: "chart.png" })]),
      respond([toolCall("finish", { summary: "Looked at the chart." })]),
    ];
    const { store, engine, provider } = setup(script, { engine: { tools }, workDir });
    const runId = await newRun(store);
    writeFileSync(join(workDir, "chart.png"), PNG);
    expect((await engine.run(runId)).status).toBe("succeeded");

    const events = await store.read(runId);
    expectWellFormed(events, { terminal: true });
    const completed = ofType(events, "tool.call.completed").map((e) => payloadOf(e, "tool.call.completed"));
    expect(completed[1]).toMatchObject({ output: "chart.png (70 bytes)", images: [{ sha256: SHA, media_type: "image/png", bytes: 70 }] });
    expect(JSON.stringify(events)).not.toContain(PNG.toString("base64"));
    expect(readFileSync(join(artifacts, `${SHA}.png`)).equals(PNG)).toBe(true);

    // What the provider was sent carries the bytes.
    expect(resultOf(provider.requests[2]!, 1)).toEqual({
      type: "tool_result",
      toolCallId: expect.any(String),
      content: "chart.png (70 bytes)",
      images: [{ type: "image", mediaType: "image/png", sha256: SHA, data: PNG.toString("base64") }],
    });

    // Every request can still be rebuilt from the log alone, and hashes to what was recorded.
    for (const started of ofType(events, "model.call.started")) {
      const p = payloadOf(started, "model.call.started");
      const rebuilt = buildRequest(deriveContext(events.filter((e) => e.seq <= p.context_through_seq), "main"), 16_000, undefined);
      expect(requestHash(rebuilt)).toBe(p.request_sha256);
    }
  });

  it("says so in words when a picture cannot be shown, and never fails the call over it", async () => {
    const { workDir } = world();
    const script = [
      respond([toolCall("write_file", { path: "not-a-picture.png", content: "just text" })]),
      respond([toolCall("view_image", { path: "not-a-picture.png" })]),
      respond([toolCall("finish", { summary: "Tried." })]),
    ];
    const { store, engine, provider } = setup(script, { engine: { tools }, workDir });
    await engine.run(await newRun(store));
    const shown = resultOf(provider.requests[2]!, 1);
    expect(shown.isError).toBeUndefined();
    expect(shown.images).toBeUndefined();
    expect(shown.content).toBe("not-a-picture.png (9 bytes)\n\n(not-a-picture.png is not shown: it is not a PNG, JPEG, WebP or GIF picture.)");
  });

  it("stops adding pictures once the conversation holds its limit", async () => {
    const { workDir } = world();
    writeFileSync(join(workDir, "a.png"), PNG);
    const script = [
      respond([toolCall("view_image", { path: "a.png" })]),
      respond([toolCall("view_image", { path: "a.png" })]),
      respond([toolCall("finish", { summary: "Looked twice." })]),
    ];
    const { store, engine, provider } = setup(script, { engine: { tools, maxImages: 1 }, workDir });
    await engine.run(await newRun(store));
    expect(resultOf(provider.requests[2]!, 0).images).toHaveLength(1);
    const second = resultOf(provider.requests[2]!, 1);
    expect(second.images).toBeUndefined();
    expect(second.content).toContain("a.png is not shown: this conversation already holds as many pictures as it can.");
  });

  it("tells the model when a picture it was shown earlier has gone missing", async () => {
    const { workDir, artifacts } = world();
    writeFileSync(join(workDir, "a.png"), PNG);
    const gated = [...tools, defineTool({ name: "ask", description: "Ask for a review.", input: z.object({}), execute: (_input, exec) => exec.gate("script") })] as ToolDefinition[];
    const first = setup([respond([toolCall("view_image", { path: "a.png" })]), respond([toolCall("ask", {})])], { engine: { tools: gated }, workDir });
    const runId = await newRun(first.store);
    expect((await first.engine.run(runId)).status).toBe("waiting_gate");
    expect(resultOf(first.provider.requests[1]!, 0).images).toHaveLength(1);

    // The stored copy is lost while the run waits. A new worker picks the run up with nothing in memory.
    rmSync(join(artifacts, `${SHA}.png`));
    await decideGate(first.store, runId, { gate: "script", decision: "approved" });
    const next = setup([respond([toolCall("finish", { summary: "Done." })])], { store: first.store, engine: { tools: gated }, workDir });
    expect((await next.engine.run(runId)).status).toBe("succeeded");
    const shown = resultOf(next.provider.requests[0]!, 0);
    expect(shown.images).toEqual([]);
    expect(shown.content).toBe("a.png (70 bytes)\n\n(A picture shown here earlier can no longer be read.)");
  });

  it("reads the kind of picture from its bytes, not its name", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(Buffer.from("<svg/>"))).toBeUndefined();
  });
});
