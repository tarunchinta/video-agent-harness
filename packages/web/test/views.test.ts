import { describe, expect, it } from "vitest";
import { foldRun, type HarnessEvent } from "@harness/harness";
import { buildChat, buildDeliverables, buildTrajectory, diffLines, meters, parseWords, reelProgress, timeScale, toolTitle, wordAt } from "../src/views/index.ts";

/** A reel's log, written by hand: research, a script sent back once, the voiceover, two cuts, approval. */
function reelLog(): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  let seq = 0;
  let clock = Date.parse("2026-11-01T10:00:00Z");
  const run = "run-span";
  const add = (type: string, payload: Record<string, unknown>, extra: Partial<HarnessEvent> = {}, ms = 1000) => {
    clock += ms;
    seq += 1;
    events.push({
      runId: "demo-run",
      seq,
      eventId: `e${seq}`,
      type,
      schemaVersion: 1,
      occurredAt: new Date(clock).toISOString(),
      actor: "engine",
      agentId: "main",
      spanId: extra.spanId ?? `s${seq}`,
      untrusted: false,
      payload,
      ...extra,
    } as HarnessEvent);
  };
  let call = 0;
  const step = (n: number, tools: [string, Record<string, unknown>, string | { fail: string }][], text = "", attempts = 1) => {
    for (let a = 1; a < attempts; a += 1) {
      add("model.call.started", { provider: "scripted", model: "demo-model", params: {}, purpose: "agent", tools_enabled: true, context_through_seq: seq, request_sha256: "x", attempt: a, step: n }, { spanId: `m${n}-${a}` });
      add("model.call.failed", { error: { kind: "rate_limit", message: "Slow down.", retryable: true }, attempt: a, retry_in_ms: 2000 }, { spanId: `m${n}-${a}` });
    }
    add("model.call.started", { provider: "scripted", model: "demo-model", params: {}, purpose: "agent", tools_enabled: true, context_through_seq: seq, request_sha256: "x", attempt: attempts, step: n }, { spanId: `m${n}` });
    const ids = tools.map(() => `call_${(call += 1)}`);
    add(
      "model.call.completed",
      {
        stop_reason: tools.length ? "tool_use" : "end_turn",
        content: [...(text ? [{ type: "text", text }] : []), ...tools.map(([name, input], i) => ({ type: "tool_call", id: ids[i], name, input }))],
        usage: { input_tokens: 1000, output_tokens: 100 },
        latency_ms: 900,
        first_token_ms: 300,
      },
      { spanId: `m${n}`, tokensIn: 1000, tokensOut: 100, costMicroUsd: 4500 },
    );
    tools.forEach(([name, input, result], i) => {
      add("tool.call.started", { tool: name, plugin: "demo", plugin_version: "0", tool_call_id: ids[i], input, idempotent: false, sandboxed: false }, { spanId: `t${ids[i]}` });
      if (typeof result === "string") {
        if (result === "GATE") return;
        add("tool.call.completed", { tool_call_id: ids[i], output: result, truncated: false, duration_ms: 500, ...(name === "render_film" ? { images: [{ sha256: `sheet${i}${n}`, media_type: "image/jpeg", bytes: 10 }] } : {}) }, { spanId: `t${ids[i]}`, actor: "plugin" });
      } else add("tool.call.failed", { tool_call_id: ids[i], error: { kind: "precondition", message: result.fail } }, { spanId: `t${ids[i]}` });
    });
    return ids;
  };

  add("run.created", { title: "Why tests are underpowered", brief: { task: "Make a reel about power.", project: "demo-project" }, config: { model: "demo-model", system: "sys", max_output_tokens: 1000, pipeline: "reel" }, limits: { max_cost_micro_usd: 100_000, max_re_edits: 2 }, harness_version: "0.1.0" }, { spanId: run, actor: "creator", agentId: undefined });
  add("run.started", { worker: "w", epoch: 1 }, { spanId: run });
  step(1, [["start_stage", { stage: "research" }, "Started the research stage."]], "Starting with research.", 2);
  add("stage.started", { stage: "research", revision: 1, trigger: "plan" }, { spanId: "stage-r" });
  step(2, [["web_fetch", { url: "https://stats.example/power", question: "What is statistical power?" }, "Facts: ..."], ["submit_script", {}, { fail: "This belongs to the script stage, which is not open." }]]);
  add("stage.completed", { stage: "research" }, { spanId: "stage-r" });
  add("stage.started", { stage: "script", revision: 1, trigger: "plan" }, { spanId: "stage-s1" });
  step(3, [["write_file", { path: "script/script.md", content: "# Draft one\nHook\nBeat" }, "Wrote it."], ["write_file", { path: "script/narration.txt", content: "Most tests are too small\nto find what they look for" }, "Wrote it."]]);
  const [gate1] = step(4, [["submit_script", {}, "GATE"]]);
  add("stage.completed", { stage: "script" }, { spanId: "stage-s1" });
  add("gate.opened", { gate: "script", tool_call_id: gate1, files: ["script/script.md", "script/narration.txt"], words: 10, estimated_seconds: 4 }, { spanId: "agent" });
  add("gate.decided", { gate: "script", decision: "changes_requested", notes: [{ text: "Shorter hook." }] }, { spanId: run, actor: "creator" }, 600_000);
  add("tool.call.completed", { tool_call_id: gate1, output: "Changes requested: Shorter hook.", truncated: false, duration_ms: 0 }, { spanId: `t${gate1}`, actor: "creator" });
  add("run.resumed", { worker: "w", epoch: 2, reason: "gate", interrupted_spans: [] }, { spanId: run });
  add("stage.started", { stage: "script", revision: 2, trigger: "creator" }, { spanId: "stage-s2" });
  step(5, [["write_file", { path: "script/script.md", content: "# Draft two\nHook\nBeat" }, "Wrote it."]]);
  const [gate2] = step(6, [["submit_script", {}, "GATE"]]);
  add("stage.completed", { stage: "script" }, { spanId: "stage-s2" });
  add("gate.opened", { gate: "script", tool_call_id: gate2, files: ["script/script.md", "script/narration.txt"], words: 10, estimated_seconds: 4 }, { spanId: "agent" });
  add("gate.decided", { gate: "script", decision: "approved", notes: [{ text: "There is no voiceover recording." }] }, { spanId: run, actor: "creator" }, 300_000);
  add("tool.call.completed", { tool_call_id: gate2, output: "Approved.", truncated: false, duration_ms: 0 }, { spanId: `t${gate2}`, actor: "creator" });
  add("stage.started", { stage: "assets", revision: 1, trigger: "plan" }, { spanId: "stage-a" });
  step(7, [["prepare_voiceover", {}, "Timed 10 words."]]);
  add("stage.completed", { stage: "assets" }, { spanId: "stage-a" });
  add("stage.started", { stage: "edit", revision: 1, trigger: "plan" }, { spanId: "stage-e1" });
  step(8, [["render_film", {}, "Rendered cut 1: 4.2 seconds, 1080 by 1920, 0.6 MB, with no voice (stand-in timing). Saved as cuts/cut-1.mp4."]]);
  add("stage.completed", { stage: "edit" }, { spanId: "stage-e1" });
  add("stage.started", { stage: "edit", revision: 2, trigger: "critique" }, { spanId: "stage-e2" });
  step(9, [["render_film", {}, "Rendered cut 2: 4.4 seconds, 1080 by 1920, 0.7 MB, with no voice (stand-in timing). Saved as cuts/cut-2.mp4."]]);
  add("stage.completed", { stage: "edit" }, { spanId: "stage-e2" });
  const [gate3] = step(10, [["submit_cut", { note: "Tightened the ending." }, "GATE"]]);
  add("gate.opened", { gate: "final_cut", tool_call_id: gate3, files: ["cuts/cut-2.mp4"], revision: 2, bytes: 700_000, sha256: "abc123", note: "Tightened the ending." }, { spanId: "agent" });
  return events;
}

describe("chat view", () => {
  const events = reelLog();
  const items = buildChat(events);

  it("starts with your brief and groups tool calls under the step that asked for them", () => {
    expect(items[0]).toMatchObject({ kind: "brief", title: "Why tests are underpowered", project: "demo-project" });
    const groups = items.filter((i) => i.kind === "tools");
    expect(groups.length).toBe(10);
    const second = groups[1]!;
    expect(second.kind === "tools" && second.calls.map((c) => [c.tool, c.status])).toEqual([
      ["web_fetch", "ok"],
      ["submit_script", "failed"],
    ]);
  });

  it("says what each tool did in plain words", () => {
    const fetch = items.flatMap((i) => (i.kind === "tools" ? i.calls : [])).find((c) => c.tool === "web_fetch")!;
    expect(fetch.title).toBe("Read stats.example: What is statistical power?");
    expect(toolTitle("run_command", { command: ["python", "plot.py"] })).toBe("Ran python plot.py");
  });

  it("shows each review with your answer, and marks the call still waiting on you", () => {
    const reviews = items.filter((i) => i.kind === "review");
    expect(reviews.map((r) => r.kind === "review" && [r.gate, r.decision?.decision ?? "open"])).toEqual([
      ["script", "changes_requested"],
      ["script", "approved"],
      ["final_cut", "open"],
    ]);
    const cut = items.flatMap((i) => (i.kind === "tools" ? i.calls : [])).find((c) => c.tool === "submit_cut")!;
    expect(cut.status).toBe("waiting");
    expect(items.some((i) => i.kind === "decision" && i.text === "You asked for changes to the script.")).toBe(true);
  });

  it("notes a retried model call without showing it as the agent's words", () => {
    expect(items.some((i) => i.kind === "note" && i.tone === "warn" && i.text.includes("trying again in 2 s"))).toBe(true);
  });
});

describe("loop view", () => {
  const trace = buildTrajectory(reelLog());

  it("counts steps, retries, refused tools and revisions of each stage", () => {
    expect(trace.totals).toMatchObject({ steps: 10, modelCalls: 11, retries: 1, toolCalls: 12, failedTools: 1, costMicroUsd: 45_000 });
    expect(trace.steps[0]!.attempts.length).toBe(2);
    expect(trace.steps[1]!.stage).toBe("research");
    expect(trace.stages.map((s) => s.label)).toContain("Revising the cut (revision 2, on the agent's own judgement)");
  });

  it("spans each review from the hand-in to your answer", () => {
    expect(trace.reviews.map((r) => r.outcome)).toEqual(["ok", "ok", "open"]);
    expect(trace.reviews[0]!.end! - trace.reviews[0]!.start).toBe(600_000);
  });

  it("squeezes long waits so the work stays readable", () => {
    const scale = timeScale(
      [
        { start: 0, end: 10_000 },
        { start: 3_610_000, end: 3_620_000 },
      ],
      0,
      3_620_000,
    );
    expect(scale.breaks.length).toBe(1);
    // An hour's wait takes no more room than 30 s of work would.
    expect(scale.at(10_000)).toBeCloseTo(10 / 50, 2);
    expect(scale.at(3_620_000)).toBe(1);
  });
});

describe("what the run made", () => {
  const made = buildDeliverables(reelLog());

  it("keeps every script revision's text from the log, with your answer", () => {
    expect(made.scripts.map((s) => [s.n, s.script?.split("\n")[0], s.review?.decision])).toEqual([
      [1, "# Draft one", "changes_requested"],
      [2, "# Draft two", "approved"],
    ]);
    expect(made.scripts[1]!.narration).toBe("Most tests are too small\nto find what they look for");
    expect(made.scripts[0]!.review?.notes).toEqual(["Shorter hook."]);
  });

  it("lists each rendered cut and ties the hand-in to the right one", () => {
    expect(made.cuts.map((c) => [c.revision, c.durationSeconds, c.voice, c.trigger, Boolean(c.submitted)])).toEqual([
      [1, 4.2, false, "plan", false],
      [2, 4.4, false, "critique", true],
    ]);
    expect(made.cuts[1]!.submitted).toMatchObject({ sha256: "abc123", note: "Tightened the ending." });
    expect(made.cuts[1]!.sheet?.sha256).toBe("sheet09");
  });

  it("shows the critic's scores, from the hand-in or from its own report", () => {
    const events = reelLog();
    const gate = events.at(-1)!;
    const withReview = [...events.slice(0, -1), { ...gate, payload: { ...gate.payload, review: { passed: true, mean: 4.2, scores: { hook: 4, pacing: 5 }, path: "cuts/review-2.json", summary: "Holds up." } } }];
    expect(buildDeliverables(withReview).cuts[1]!.critique).toEqual({ passed: true, mean: 4.2, scores: { hook: 4, pacing: 5 }, path: "cuts/review-2.json", summary: "Holds up." });

    const base = { runId: "demo-run", schemaVersion: 1, actor: "plugin", agentId: "main", untrusted: false, occurredAt: gate.occurredAt } as const;
    const reported = [
      ...events.slice(0, -1),
      { ...base, seq: 900, eventId: "c1", type: "tool.call.started", spanId: "critic", payload: { tool: "review_cut", plugin: "reel", plugin_version: "0", tool_call_id: "call_critic", input: {}, idempotent: true, sandboxed: true } },
      { ...base, seq: 901, eventId: "c2", type: "tool.call.completed", spanId: "critic", payload: { tool_call_id: "call_critic", output: "The critic did not pass cut 2 (average 2.8 of 5). Saved as cuts/review-2.json.\n\nPacing drags.", truncated: false, duration_ms: 10 } },
    ] as HarnessEvent[];
    expect(buildDeliverables(reported).cuts[1]!.critique).toEqual({ passed: false, mean: 2.8, scores: {}, path: "cuts/review-2.json" });
    expect(toolTitle("review_cut", {})).toBe("Had the critic watch the cut");
  });

  it("shows where a reel is in its stages and how much of each limit it used", () => {
    const events = reelLog();
    const state = foldRun(events);
    expect(reelProgress(events, state).map((p) => [p.id, p.state, p.revisions])).toEqual([
      ["research", "done", 1],
      ["script", "done", 2],
      ["gate:script", "done", 2],
      ["assets", "done", 1],
      ["edit", "done", 2],
      ["gate:final_cut", "waiting", 1],
    ]);
    const m = meters(state, events, Date.now());
    expect(m.find((x) => x.id === "cost")).toMatchObject({ used: 45_000, limit: 100_000, text: "$0.04 of $0.10" });
    expect(m.find((x) => x.id === "re_edits")).toMatchObject({ used: 1, limit: 2 });
  });
});

describe("helpers", () => {
  it("diffs script lines", () => {
    expect(diffLines("a\nb\nc", "a\nc\nd")).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "same", text: "c" },
      { op: "add", text: "d" },
    ]);
  });

  it("finds the word being spoken", () => {
    const words = parseWords([{ w: "one", s: 0.2, e: 0.5 }, { w: "two", s: 0.6, e: 0.9 }, { nope: true }]);
    expect(words.length).toBe(2);
    expect([wordAt(words, 0.1), wordAt(words, 0.3), wordAt(words, 0.7), wordAt(words, 9)]).toEqual([-1, 0, 1, 1]);
  });
});
