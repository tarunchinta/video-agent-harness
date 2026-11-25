import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRun, decideGate, Engine, foldRun, MemoryEventStore, payloadOf,
  type HarnessEvent, type Limits, type ModelResponse, type ToolResultBlock,
} from "@harness/harness";
import { FakeSandboxes, respond, resultsIn, ScriptedProvider, text, toolCall } from "@harness/harness/testing";
import { checkCut, REEL_SYSTEM, reelPipeline, reelTask, wordsSchema } from "../src/index.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const NARRATION = [
  "A library card costs nothing here,",
  "yet four hundred thousand readers disappeared in May.",
  "Take one of them.",
  "She borrows in March, then stays home for the summer.",
  "The regulars stayed home, and the newcomers took the shelves.",
].join("\n");
const SCRIPT = `# The missing readers\n\nHook: a library card costs nothing.\n\n${"Beat: what is said, what is on screen, and the source that backs it. ".repeat(4)}`;

/** What the critic's measuring script reports for the next cut it is shown. Tests change it. */
let measured: Record<string, unknown> = {};
const MEASURED_OK = {
  ok: true, duration: 21.4, width: 1080, height: 1920, audio: true, black: [], freezes: [], silences: [],
  loudness: { integrated_lufs: -14.2, true_peak_db: -1.6 }, first_word: 0.25, last_word: 20.1,
  frames: [{ n: 1, t: 0.7, words: "A library card" }, { n: 2, t: 2.0, words: "four hundred thousand" }], sheet: "out/critique/sheet.jpg",
};

/** A sandbox that stands in for the kit's scripts: it writes the files they would and prints their last line. */
function sandboxes() {
  return new FakeSandboxes((call, run) => {
    const film = join(run.workDir, "film");
    const [program, script, mode] = call.command;
    if (program === "node" && script === "kit/review.mjs") {
      mkdirSync(join(film, "out", "critique"), { recursive: true });
      writeFileSync(join(film, "out", "critique", "sheet.jpg"), JPEG);
      return { stdout: `${JSON.stringify({ ...MEASURED_OK, ...measured })}\n` };
    }
    if (program === "node" && script === "kit/render.mjs" && mode === "--stills") {
      mkdirSync(join(film, "out", "stills"), { recursive: true });
      writeFileSync(join(film, "out", "stills", "sheet.jpg"), JPEG);
      const times = call.command.slice(3).map(Number);
      const stills = (times.length ? times : [0.85]).map((t, i) => ({ n: i + 1, t, ...(times.length ? {} : { cue: "hook" }), file: `out/stills/0${i + 1}_${t.toFixed(2)}.jpg` }));
      return { stdout: `${JSON.stringify({ ok: true, mode: "stills", duration: 21.4, fps: 30, stills, sheet: "out/stills/sheet.jpg" })}\n` };
    }
    if (program === "node" && script === "kit/render.mjs" && mode === "--film") {
      if (readFileSync(join(film, "index.html"), "utf8").includes("BROKEN")) {
        return { exitCode: 1, stdout: `${JSON.stringify({ ok: false, error: 'the page failed to load: cue not found: "turn purple"' })}\n` };
      }
      mkdirSync(join(film, "out", "review"), { recursive: true });
      writeFileSync(join(film, "out", "film.mp4"), `film made from ${readFileSync(join(film, "index.html"), "utf8").length} bytes of page`);
      writeFileSync(join(film, "out", "review", "sheet.jpg"), JPEG);
      const report = { ok: true, mode: "film", film: "out/film.mp4", sheet: "out/review/sheet.jpg", duration: 21.4, width: 1080, height: 1920, fps: 30, frames: 642, bytes: 4_200_000, voice: existsSync(join(film, "vo.m4a")), sound_effects: 0, missing_sound_effects: [], render_seconds: 80 };
      return { stdout: `frame 0 of 642 (0 s)\n${JSON.stringify(report)}\n` };
    }
    if (program === "python" && script === "kit/align.py") {
      // The recording has two seconds of silence first, and says "votes" where the narration is checked later.
      const said = NARRATION.replace("disappeared", "vanished").split(/\s+/);
      writeFileSync(join(film, "words.raw.json"), JSON.stringify(said.map((w, i) => ({ w, s: 2 + i * 0.4, e: 2.3 + i * 0.4 }))));
      return { stdout: `${JSON.stringify({ ok: true, words: said.length, duration: 20, language: "en" })}\n` };
    }
    if (program === "ffmpeg") {
      writeFileSync(join(film, "vo.m4a"), "audio");
      return {};
    }
    return { exitCode: 127, stderr: "not found" };
  });
}

function world(responses: ModelResponse[], limits: Limits = {}, critic = false) {
  const root = mkdtempSync(join(tmpdir(), "reel-pipeline-"));
  const workDir = join(root, "work");
  const store = new MemoryEventStore();
  const provider = new ScriptedProvider(responses);
  const box = sandboxes();
  const engine = new Engine({ store, provider, workDir: () => workDir, artifactsDir: () => join(root, "artifacts"), sandbox: box.factory, sleep: async () => {}, ...reelPipeline({ critic }) });
  const start = () => createRun(store, { task: reelTask({ topic: "Why 400,000 readers stayed home", seconds: 30 }), model: "test-model", system: REEL_SYSTEM, limits });
  /** The result of the nth tool call the model has made so far, as the model was shown it. */
  const shown = (name: string, nth = 0): ToolResultBlock & { name: string } => {
    const request = provider.requests.at(-1)!;
    const result = [...resultsIn(request).entries()].filter(([, r]) => r.name === name)[nth];
    if (!result) throw new Error(`no result for ${name} number ${nth + 1} yet`);
    const block = request.messages.flatMap((m) => m.content).find((b): b is ToolResultBlock => b.type === "tool_result" && b.toolCallId === result[0])!;
    return { ...block, name };
  };
  return { store, provider, engine, box, workDir, start, shown };
}

const write = (path: string, content: string) => toolCall("write_file", { path, content });
const stage = (name: string) => toolCall("start_stage", { stage: name });
const stagesOf = (events: HarnessEvent[]) =>
  events.filter((e) => e.type === "stage.started").map((e) => { const p = payloadOf(e, "stage.started"); return `${p.stage} ${p.revision} ${p.trigger}`; });

const toApproval = [
  respond([stage("research")]),
  respond([write("research/notes.md", "- Turnout fell 45 percent. Source: https://news.example/runoff")]),
  respond([stage("script")]),
  respond([write("script/script.md", SCRIPT), write("script/narration.txt", NARRATION)]),
  respond([toolCall("submit_script", {})]),
];

describe("the reel pipeline", () => {
  it("takes a topic to an approved cut, in order, with the creator deciding twice", async () => {
    const { store, engine, box, workDir, start, shown, provider } = world(
      [
        // Tries to skip ahead. Code says no.
        respond([toolCall("render_stills", {})]),
        respond([stage("edit")]),
        ...toApproval,
        // The creator asked for changes. The script stage has to be started again before handing in again.
        respond([toolCall("submit_script", {})]),
        respond([stage("script")]),
        respond([toolCall("submit_script", {})]),
        // Approved, with no recording.
        respond([stage("edit")]),
        respond([stage("assets")]),
        respond([toolCall("prepare_voiceover", {})]),
        respond([stage("edit")]),
        respond([write("film/kit/film.js", "tampered"), toolCall("render_stills", { times: [1, 2.5] })]),
        respond([toolCall("render_film", {})]),
        respond([toolCall("render_film", {})]),
        respond([toolCall("finish", { summary: "Done early.", film: "cuts/cut-1.mp4" })]),
        respond([toolCall("submit_cut", { note: "The map is simplified." })]),
        // The creator asked for changes to the cut.
        respond([stage("edit")]),
        respond([write("film/index.html", "<html>second cut, a little longer</html>")]),
        respond([toolCall("render_film", {})]),
        respond([toolCall("submit_cut", {})]),
        respond([toolCall("finish", { summary: "A 21 second reel on the missing readers.", film: "cuts/cut-2.mp4" })]),
      ],
      { max_re_edits: 2 },
    );
    const runId = await start();

    // --- up to the script review ---
    expect(await engine.run(runId)).toMatchObject({ status: "waiting_gate", gate: "script" });
    expect(shown("render_stills")).toMatchObject({ isError: true, content: 'This needs the "script" review to be approved first. Ask for that review, then try again.' });
    expect(shown("start_stage", 0)).toMatchObject({ isError: true, content: "The creator has not approved the script yet. Finish the script and hand it in with submit_script." });
    expect(shown("start_stage", 1).content).toContain("Started the research stage.");
    let events = await store.read(runId);
    expect(payloadOf(events.findLast((e) => e.type === "gate.opened")!, "gate.opened")).toMatchObject({
      gate: "script",
      files: ["script/script.md", "script/narration.txt"],
      words: 38,
      estimated_seconds: 15,
    });
    // The run waits with no stage open: the script revision is finished and in the creator's hands.
    expect(foldRun(events).stage).toBeUndefined();

    await decideGate(store, runId, { gate: "script", decision: "changes_requested", notes: ["Shorten the hook."] });
    expect(await engine.run(runId)).toMatchObject({ status: "waiting_gate", gate: "script" });
    expect(JSON.parse(shown("submit_script", 0).content)).toEqual({ gate: "script", decision: "changes_requested", notes: ["Shorten the hook."] });
    expect(shown("submit_script", 1)).toMatchObject({ isError: true, content: "This belongs to the script stage, which is not open. Start it first." });
    expect(shown("start_stage", 3).content).toContain("Started revision 2 of the script stage.");

    // --- approved; assets and the edit ---
    await decideGate(store, runId, { gate: "script", decision: "approved", notes: ["There is no voiceover recording. Use stand-in timing."] });
    expect(await engine.run(runId)).toMatchObject({ status: "waiting_gate", gate: "final_cut" });
    expect(shown("start_stage", 4)).toMatchObject({
      isError: true,
      content: "There are no word timings yet, so the film has nothing to be timed to. Start the assets stage and call prepare_voiceover first.",
    });
    expect(shown("prepare_voiceover").content).toContain("There is no recording, so the timing is a stand-in made from the narration: 38 words");
    expect(wordsSchema.parse(JSON.parse(readFileSync(join(workDir, "film/words.json"), "utf8")))).toHaveLength(38);
    expect(readFileSync(join(workDir, "film/words.js"), "utf8")).toMatch(/^window\.WORDS = \[\{"w":"A"/);
    expect(shown("start_stage", 6).content).toContain("Read film/kit/README.md first");

    // The kit is put back before every render, whatever the agent did to it.
    expect(readFileSync(join(workDir, "film/kit/film.js"), "utf8")).toContain("window.Film =");
    expect(existsSync(join(workDir, "film/kit/render.mjs"))).toBe(true);
    expect(readFileSync(join(workDir, "film/index.html"), "utf8")).toContain("Film.define(");
    expect(box.commands.map((c) => c.command.join(" "))).toEqual(["node kit/render.mjs --stills 1 2.5", "node kit/render.mjs --film"]);
    expect(box.commands.every((c) => c.cwd === "/work/film")).toBe(true);

    // The agent is shown the frames, not just told about them.
    const stills = shown("render_stills", 1);
    expect(stills.content).toContain("2 frames, shown on the contact sheet in this order:\n1. 1.00 s: film/out/stills/01_1.00.jpg\n2. 2.50 s: film/out/stills/02_2.50.jpg");
    expect(stills.images).toEqual([{ type: "image", mediaType: "image/jpeg", sha256: expect.any(String), data: JPEG.toString("base64") }]);
    const rendered = shown("render_film", 0);
    expect(rendered.content).toContain("Rendered cut 1: 21.4 seconds, 1080 by 1920, 4.2 MB, with no voice (stand-in timing). Saved as cuts/cut-1.mp4.");
    expect(rendered.content).toContain("You may revise it on your own judgement 2 more times.");
    expect(rendered.images).toHaveLength(1);
    // A full render ends the revision; another needs a new one. And the run cannot finish unreviewed.
    expect(shown("render_film", 1)).toMatchObject({ isError: true, content: "This belongs to the edit stage, which is not open. Start it first." });
    expect(shown("finish")).toMatchObject({ isError: true, content: "The creator has not approved the final cut. Hand it in with submit_cut and wait for their answer." });
    events = await store.read(runId);
    expect(payloadOf(events.findLast((e) => e.type === "gate.opened")!, "gate.opened")).toMatchObject({
      gate: "final_cut",
      files: ["cuts/cut-1.mp4"],
      revision: 1,
      note: "The map is simplified.",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    // --- the creator's changes, then approval ---
    await decideGate(store, runId, { gate: "final_cut", decision: "changes_requested", notes: ["Hold the last frame longer."] });
    expect(await engine.run(runId)).toMatchObject({ status: "waiting_gate", gate: "final_cut" });
    await decideGate(store, runId, { gate: "final_cut", decision: "approved" });
    const done = await engine.run(runId);
    expect(done).toMatchObject({ status: "succeeded", result: { summary: "A 21 second reel on the missing readers.", film: "cuts/cut-2.mp4" } });

    events = await store.read(runId);
    expect(stagesOf(events)).toEqual(["research 1 plan", "script 1 plan", "script 2 creator", "assets 1 plan", "edit 1 plan", "edit 2 creator"]);
    // A revision the creator asked for does not use up the agent's own.
    expect(foldRun(events).reEdits).toBe(0);
    expect(readFileSync(join(workDir, "cuts/cut-1.mp4"), "utf8")).not.toBe(readFileSync(join(workDir, "cuts/cut-2.mp4"), "utf8"));
    // One sandbox per stretch of work, each removed when the run stopped to wait.
    expect([box.started, box.stopped]).toEqual([2, 2]);
    expect(provider.requests).toHaveLength(24);
    for (const e of events) if (e.type.endsWith(".started")) expect(events.some((c) => c.spanId === e.spanId && /\.(completed|failed)$/.test(c.type)), `${e.type} at ${e.seq}`).toBe(true);
  });

  it("times the creator's recording, trims its lead-in and says where it left the narration", async () => {
    const { store, engine, box, workDir, start, shown } = world(
      [
        ...toApproval,
        respond([stage("assets")]),
        respond([toolCall("prepare_voiceover", { vocabulary: ["Marlow", "Quillfeather"] })]),
        // The timing tool misheard one word. The agent puts it right; the recording is not timed again.
        respond([toolCall("prepare_voiceover", { corrections: [{ heard: "vanished", write: "disappeared" }, { heard: "Marlo", write: "Marlow" }] })]),
        respond([stage("edit")]),
        respond([toolCall("render_film", {})]),
        respond([toolCall("list_files", {})]),
      ],
      { max_steps: 11 },
    );
    const runId = await start();
    await engine.run(runId);
    mkdirSync(join(workDir, "inputs"), { recursive: true });
    writeFileSync(join(workDir, "inputs/voiceover.m4a"), "recording");
    await decideGate(store, runId, { gate: "script", decision: "approved", notes: ["The voiceover recording is at inputs/voiceover.m4a."] });
    expect(await engine.run(runId)).toMatchObject({ status: "paused", reason: "budget:steps" });

    expect(box.commands[0]).toEqual({ command: ["python", "kit/align.py", "/work/inputs/voiceover.m4a", "words.raw.json", "--vocabulary", "Marlow, Quillfeather"], cwd: "/work/film" });
    // The first word was at 2.0 s; the audio is cut so it lands a quarter of a second in.
    expect(box.commands[1]!.command.slice(0, 7)).toEqual(["ffmpeg", "-v", "error", "-y", "-ss", "1.750", "-i"]);
    const words = wordsSchema.parse(JSON.parse(readFileSync(join(workDir, "film/words.json"), "utf8")));
    expect(words[0]).toEqual({ w: "A", s: 0.25, e: 0.55 });
    expect(existsSync(join(workDir, "film/words.raw.json"))).toBe(false);

    const result = shown("prepare_voiceover", 0).content;
    expect(result).toContain("Timed 38 words over");
    expect(result).toContain('Where what was heard differs from the narration:\n- written: "readers disappeared in"  heard: "readers vanished in"');
    expect(result).toContain("What was heard:\nA library card costs nothing here, yet four hundred thousand readers vanished in May.");

    const corrected = shown("prepare_voiceover", 1).content;
    expect(corrected).toContain('These corrections matched nothing and were not applied: "Marlo".');
    expect(corrected).toContain("What was heard matches the narration word for word.");
    expect(words.map((w) => w.w).join(" ")).toContain("readers disappeared in May.");
    // Only the first call ran anything in the sandbox before the render.
    expect(box.commands.map((c) => c.command[0])).toEqual(["python", "ffmpeg", "node"]);
    expect(shown("render_film").content).toContain("with the voiceover");
  });

  it("passes a render that fails back to the agent with the page's own error, and keeps the revision open", async () => {
    const { store, engine, start, shown } = world(
      [
        ...toApproval,
        respond([stage("assets")]),
        respond([toolCall("prepare_voiceover", {})]),
        respond([stage("edit")]),
        respond([write("film/index.html", "<html>BROKEN cue</html>")]),
        respond([toolCall("render_film", {})]),
        respond([toolCall("submit_cut", {})]),
        respond([write("film/index.html", "<html>fixed</html>")]),
        respond([toolCall("render_film", {})]),
        respond([toolCall("list_files", {})]),
      ],
      { max_steps: 14 },
    );
    const runId = await start();
    await engine.run(runId);
    await decideGate(store, runId, { gate: "script", decision: "approved" });
    await engine.run(runId);

    expect(shown("render_film", 0)).toMatchObject({ isError: true, content: 'Rendering the film failed: the page failed to load: cue not found: "turn purple"' });
    expect(shown("submit_cut")).toMatchObject({ isError: true, content: "A revision of the edit is open and has not been rendered. Call render_film first, so the cut you hand in is the one you last worked on." });
    expect(shown("render_film", 1).content).toContain("Rendered cut 1:");
    expect(stagesOf(await store.read(runId)).filter((s) => s.startsWith("edit"))).toEqual(["edit 1 plan"]);
  });
});

/** The critic's answer: every rubric score as given, with one note. */
const judged = (scores: Partial<Record<"hook" | "pacing" | "sync" | "legibility" | "grounding", number>>) => {
  const all = { hook: 4, pacing: 4, sync: 4, legibility: 4, grounding: 4, ...scores };
  return respond([
    text(
      JSON.stringify({
        scores: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { score: v, why: `${k} is a ${v}.` }])),
        notes: [{ at: 2.0, issue: "The number is too small to read on a phone." }],
        summary: "Make the big number bigger.",
      }),
    ),
  ]);
};

describe("the critic", () => {
  it("watches every cut, sends a failing one back while revisions are left, and goes to the creator with the cut", async () => {
    measured = {};
    const { store, engine, start, shown, provider, workDir } = world(
      [
        ...toApproval,
        respond([stage("assets")]),
        respond([toolCall("prepare_voiceover", {})]),
        respond([stage("edit")]),
        respond([toolCall("render_film", {})]),
        // Tries to hand the cut in before the critic has seen it.
        respond([toolCall("submit_cut", {})]),
        respond([toolCall("review_cut", {})]),
        judged({ legibility: 2 }),
        // The critic did not pass it and a revision is left: code says revise.
        respond([toolCall("submit_cut", {})]),
        respond([stage("edit")]),
        respond([write("film/index.html", "<html>bigger number</html>")]),
        respond([toolCall("render_film", {})]),
        respond([toolCall("review_cut", {})]),
        judged({}),
        respond([toolCall("submit_cut", { note: "Fixed the small number." })]),
      ],
      { max_re_edits: 1 },
      true,
    );
    const runId = await start();
    await engine.run(runId);
    await decideGate(store, runId, { gate: "script", decision: "approved", notes: ["There is no voiceover recording. Use stand-in timing."] });
    expect(await engine.run(runId)).toMatchObject({ status: "waiting_gate", gate: "final_cut" });

    expect(shown("submit_cut", 0)).toMatchObject({ isError: true, content: "The critic has not reviewed cut 1 yet. Call review_cut, then hand the cut in." });
    const first = shown("review_cut", 0);
    expect(first.content).toContain("The critic did not pass cut 1 (average 3.6 of 5). Saved as cuts/review-1.json.");
    expect(first.content).toContain("- legibility: 2 of 5. legibility is a 2.");
    expect(first.content).toContain("- At 2.0 s: The number is too small to read on a phone.");
    expect(first.images).toHaveLength(1);
    expect(shown("submit_cut", 1)).toMatchObject({
      isError: true,
      content: "The critic did not pass cut 1, and you can still revise it on your own judgement. Start the edit stage again and fix what the review found.",
    });
    expect(shown("review_cut", 1).content).toContain("The critic passed cut 2 (average 4.0 of 5).");

    // The critic saw the timeline sheet and the script, in a call with no tools.
    const critic = provider.requests.filter((r) => r.tools.length === 0);
    expect(critic).toHaveLength(2);
    expect(critic[0]!.messages[0]!.content.some((b) => b.type === "image")).toBe(true);
    expect(JSON.stringify(critic[0]!.messages[0]!.content[0])).toContain("A library card costs nothing here");

    const events = await store.read(runId);
    // The revision the critic forced counts against the agent's own.
    expect(stagesOf(events)).toEqual(["research 1 plan", "script 1 plan", "assets 1 plan", "edit 1 plan", "edit 2 critique"]);
    expect(foldRun(events).reEdits).toBe(1);
    // The creator gets the review with the cut.
    expect(payloadOf(events.findLast((e) => e.type === "gate.opened")!, "gate.opened")).toMatchObject({
      gate: "final_cut",
      files: ["cuts/cut-2.mp4"],
      review: { passed: true, mean: 4, scores: { hook: 4, legibility: 4 }, path: "cuts/review-2.json" },
    });
    expect(JSON.parse(readFileSync(join(workDir, "cuts/review-1.json"), "utf8"))).toMatchObject({ revision: 1, passed: false });
  });

  it("lets a failing cut through to the creator once no revisions are left, with the review attached", async () => {
    measured = { freezes: [{ start: 3, end: 8.5 }] };
    const { store, engine, start, shown } = world(
      [
        ...toApproval,
        respond([stage("assets")]),
        respond([toolCall("prepare_voiceover", {})]),
        respond([stage("edit")]),
        respond([toolCall("render_film", {})]),
        respond([toolCall("review_cut", {})]),
        judged({}),
        respond([toolCall("submit_cut", {})]),
      ],
      { max_re_edits: 0 },
      true,
    );
    const runId = await start();
    await engine.run(runId);
    await decideGate(store, runId, { gate: "script", decision: "approved", notes: ["No recording."] });
    expect(await engine.run(runId)).toMatchObject({ status: "waiting_gate", gate: "final_cut" });
    // Good scores, but a check in code fails it: the picture freezes for five and a half seconds.
    const review = shown("review_cut").content;
    expect(review).toContain("The critic did not pass cut 1");
    expect(review).toContain("Nothing on screen moves from 3.0 to 8.5 s (5.5 s).");
    expect(review).toContain("You have no revisions of your own left, so hand it in with submit_cut: the review goes with it.");
    const events = await store.read(runId);
    expect(payloadOf(events.findLast((e) => e.type === "gate.opened")!, "gate.opened")).toMatchObject({ review: { passed: false } });
    measured = {};
  });

  it("fails a cut in code for what can be measured, whatever the scores", () => {
    const base = { ...MEASURED_OK } as unknown as Parameters<typeof checkCut>[0];
    expect(checkCut(base, true)).toEqual([]);
    const fails = (m: Partial<typeof base>, voice = true) => checkCut({ ...base, ...m }, voice).filter((c) => c.severity === "fail").map((c) => c.what);
    expect(fails({ black: [{ start: 4, end: 5.2 }] })).toEqual(["The picture is black from 4.0 to 5.2 s."]);
    // A fade to black at the very end is how films end.
    expect(fails({ black: [{ start: 21, end: 21.4 }] })).toEqual([]);
    expect(fails({ first_word: 1.8 })).toEqual(["The first word is not heard until 1.8 s; the hook has to land in the first second."]);
    expect(fails({ duration: 25 })).toEqual(["The film runs on for 4.9 s after the last word."]);
    expect(fails({ duration: 18 })).toEqual(["The film ends at 18.0 s, before the last word at 20.1 s."]);
    expect(fails({ loudness: { integrated_lufs: -14, true_peak_db: -0.2 } })).toEqual(["The sound peaks at -0.2 dB, so it will clip; keep it under -1 dB."]);
    // With no voice, the sound is not judged.
    expect(fails({ loudness: { integrated_lufs: -14, true_peak_db: -0.2 } }, false)).toEqual([]);
    expect(fails({ width: 1920, height: 1080 })).toEqual(["The frame is 1920 by 1080; a reel is 1080 by 1920."]);
  });
});
