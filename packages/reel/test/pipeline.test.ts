import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRun, decideGate, Engine, foldRun, MemoryEventStore, payloadOf,
  type HarnessEvent, type Limits, type ModelResponse, type ToolResultBlock,
} from "@harness/harness";
import { FakeSandboxes, respond, resultsIn, ScriptedProvider, toolCall } from "@harness/harness/testing";
import { REEL_SYSTEM, reelPipeline, reelTask, wordsSchema } from "../src/index.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const NARRATION = [
  "Texas might turn blue in November,",
  "because four hundred thousand Republicans disappeared in May.",
  "Take one of them.",
  "He votes in March, then stays home for the runoff.",
  "The establishment stayed home, and the base took the party.",
].join("\n");
const SCRIPT = `# The missing votes\n\nHook: Texas might turn blue.\n\n${"Beat: what is said, what is on screen, and the source that backs it. ".repeat(4)}`;

/** A sandbox that stands in for the kit's scripts: it writes the files they would and prints their last line. */
function sandboxes() {
  return new FakeSandboxes((call, run) => {
    const film = join(run.workDir, "film");
    const [program, script, mode] = call.command;
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

function world(responses: ModelResponse[], limits: Limits = {}) {
  const root = mkdtempSync(join(tmpdir(), "reel-pipeline-"));
  const workDir = join(root, "work");
  const store = new MemoryEventStore();
  const provider = new ScriptedProvider(responses);
  const box = sandboxes();
  const engine = new Engine({ store, provider, workDir: () => workDir, artifactsDir: () => join(root, "artifacts"), sandbox: box.factory, sleep: async () => {}, ...reelPipeline() });
  const start = () => createRun(store, { task: reelTask({ topic: "Why 400,000 voters stayed home", seconds: 30 }), model: "test-model", system: REEL_SYSTEM, limits });
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
        respond([toolCall("finish", { summary: "A 21 second reel on the missing votes.", film: "cuts/cut-2.mp4" })]),
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
    expect(readFileSync(join(workDir, "film/words.js"), "utf8")).toMatch(/^window\.WORDS = \[\{"w":"Texas"/);
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
    expect(done).toMatchObject({ status: "succeeded", result: { summary: "A 21 second reel on the missing votes.", film: "cuts/cut-2.mp4" } });

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
      [...toApproval, respond([stage("assets")]), respond([toolCall("prepare_voiceover", { vocabulary: ["Paxton", "Cornyn"] })]), respond([stage("edit")]), respond([toolCall("render_film", {})]), respond([toolCall("list_files", {})])],
      { max_steps: 10 },
    );
    const runId = await start();
    await engine.run(runId);
    mkdirSync(join(workDir, "inputs"), { recursive: true });
    writeFileSync(join(workDir, "inputs/voiceover.m4a"), "recording");
    await decideGate(store, runId, { gate: "script", decision: "approved", notes: ["The voiceover recording is at inputs/voiceover.m4a."] });
    expect(await engine.run(runId)).toMatchObject({ status: "paused", reason: "budget:steps" });

    expect(box.commands[0]).toEqual({ command: ["python", "kit/align.py", "/work/inputs/voiceover.m4a", "words.raw.json", "--vocabulary", "Paxton, Cornyn"], cwd: "/work/film" });
    // The first word was at 2.0 s; the audio is cut so it lands a quarter of a second in.
    expect(box.commands[1]!.command.slice(0, 7)).toEqual(["ffmpeg", "-v", "error", "-y", "-ss", "1.750", "-i"]);
    const words = wordsSchema.parse(JSON.parse(readFileSync(join(workDir, "film/words.json"), "utf8")));
    expect(words[0]).toEqual({ w: "Texas", s: 0.25, e: 0.55 });
    expect(existsSync(join(workDir, "film/words.raw.json"))).toBe(false);

    const result = shown("prepare_voiceover").content;
    expect(result).toContain("Timed 38 words over");
    expect(result).toContain('the narration has "thousand Republicans disappeared in May. Take" where the recording says "thousand Republicans vanished in May. Take"');
    expect(result).toContain("What was said:\nTexas might turn blue in November, because four hundred thousand Republicans vanished in May.");
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
