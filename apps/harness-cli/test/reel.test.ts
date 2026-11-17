import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeSandboxes } from "@harness/harness/testing";
import { main, type Io } from "../src/main.ts";

/** Streams in the API's documented server-sent event format, written by hand. Nothing here touches the network. */
type Json = Record<string, unknown>;
const sse = (events: Json[]) => events.map((e) => `event: ${e.type as string}\ndata: ${JSON.stringify(e)}\n\n`).join("");
let nextId = 0;
/** One model turn that calls the given tools. */
const calls = (...tools: [name: string, input: Json][]) =>
  sse([
    { type: "message_start", message: { id: "msg_demo", model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 1 } } },
    ...tools.flatMap(([name, input], index): Json[] => [
      { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${(nextId += 1)}`, name, input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 100 } },
    { type: "message_stop" },
  ]);

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const NARRATION = ["Texas might turn blue in November,", "because four hundred thousand Republicans disappeared in May.", "Take one of them.", "He votes in March, then stays home for the runoff.", "The establishment stayed home, and the base took the party."].join("\n");
const SCRIPT = `# The missing votes\n\n${"Beat: what is said, what is on screen, and the source that backs it. ".repeat(4)}`;

function cli(turns: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "harness-reel-"));
  let out = "";
  let err = "";
  let sent = 0;
  const bodies: Json[] = [];
  const box = new FakeSandboxes((call, run) => {
    const film = join(run.workDir, "film");
    if (call.command[1] === "kit/align.py") {
      writeFileSync(join(film, "words.raw.json"), JSON.stringify(NARRATION.split(/\s+/).map((w, i) => ({ w, s: 0.25 + i * 0.4, e: 0.55 + i * 0.4 }))));
      return { stdout: '{"ok":true,"words":38,"duration":15.2,"language":"en"}\n' };
    }
    if (call.command[0] === "ffmpeg") {
      writeFileSync(join(film, "vo.m4a"), "audio");
      return {};
    }
    mkdirSync(join(film, "out", "review"), { recursive: true });
    writeFileSync(join(film, "out", "film.mp4"), "video");
    writeFileSync(join(film, "out", "review", "sheet.jpg"), JPEG);
    const report = { ok: true, film: "out/film.mp4", sheet: "out/review/sheet.jpg", duration: 15.2, width: 1080, height: 1920, bytes: 3_100_000, voice: true, sound_effects: 0, missing_sound_effects: [], render_seconds: 60 };
    return { stdout: `${JSON.stringify(report)}\n` };
  });
  const io: Io = {
    out: (text) => (out += text),
    err: (text) => (err += `${text}\n`),
    env: { ANTHROPIC_API_KEY: "test-key" },
    cwd,
    sandbox: box.factory,
    fetch: (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string) as Json);
      const next = turns[sent];
      sent += 1;
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
  return { run, runId, cwd, box, bodies };
}

describe("harness reel", () => {
  it("takes a topic to a finished film, stopping for the creator twice", async () => {
    const { run, runId, cwd, box, bodies } = cli([
      calls(["start_stage", { stage: "research" }]),
      calls(["start_stage", { stage: "script" }]),
      calls(["write_file", { path: "script/script.md", content: SCRIPT }], ["write_file", { path: "script/narration.txt", content: NARRATION }]),
      calls(["submit_script", {}]),
      calls(["start_stage", { stage: "assets" }]),
      calls(["prepare_voiceover", {}]),
      calls(["start_stage", { stage: "edit" }]),
      calls(["render_film", {}]),
      calls(["submit_cut", { note: "The map is simplified." }]),
      calls(["finish", { summary: "A 15 second reel on the missing votes.", film: "cuts/cut-1.mp4" }]),
    ]);
    mkdirSync(join(cwd, "my-notes"));
    writeFileSync(join(cwd, "my-notes", "hooks.md"), "Open on the number.");
    writeFileSync(join(cwd, "my-notes", "ignored.png"), "not a note");
    writeFileSync(join(cwd, "reading.m4a"), "my voice");

    // --- the topic, up to the script review ---
    const first = await run("reel", "--topic", "Why 400,000 voters stayed home", "--seconds", "30", "--source", "https://news.example/runoff", "--notes", "my-notes");
    expect(first.err).toBe("");
    expect(first.code).toBe(2);
    const id = runId();
    const work = join(cwd, "runs", id, "work");
    expect(first.out.split("\n")).toEqual([
      `Started run ${id}.`,
      "Researching the topic.",
      "  start_stage: Started the research stage.",
      "Writing the script.",
      "  start_stage: Started the script stage.",
      expect.stringContaining("write_file: Wrote"),
      expect.stringContaining("write_file: Wrote"),
      "Waiting for your review of the script.",
      "Waiting for your review of the script.",
      `  ${join(work, "script", "script.md")}`,
      `  ${join(work, "script", "narration.txt")}`,
      `To approve it, record yourself reading the narration, then: harness resume ${id} --approve --voiceover <your recording> It should run about 15 seconds.`,
      "  (or --approve --no-voiceover to render without a voice)",
      `Otherwise: harness resume ${id} --changes "what to fix"   (or --reject)`,
      "",
    ]);
    // The brief the agent got, and the creator's notes in its folder.
    const task = ((bodies[0]!.messages as Json[])[0]!.content as Json[])[0]!.text as string;
    expect(task).toBe(
      [
        "Make a reel about: Why 400,000 voters stayed home",
        "",
        "Length: about 30 seconds.",
        "",
        "Start your research from these sources:",
        "- https://news.example/runoff",
        "",
        "The creator's own notes on how they like reels made are in the notes/ folder. Read them before writing the script.",
        "",
        "Begin with the research stage.",
      ].join("\n"),
    );
    expect(readdirSync(join(work, "notes"))).toEqual(["hooks.md"]);
    expect((bodies[0]!.tools as Json[]).map((t) => t.name)).toEqual([
      "finish", "list_files", "prepare_voiceover", "read_file", "render_film", "render_stills", "run_command", "start_stage", "submit_cut", "submit_script", "view_image", "web_fetch", "write_file",
    ]);

    // --- approving the script takes the recording with it ---
    const bare = await run("resume", id, "--approve");
    expect(bare.code).toBe(1);
    expect(bare.err).toContain("Approving the script needs your recording of the narration: add --voiceover <file>. To render without a voice, add --no-voiceover.");
    expect((await run("resume", id, "--approve", "--voiceover", "reading.txt")).err).toContain(`There is no recording at ${join(cwd, "reading.txt")}.`);
    expect((await run("resume", id, "--changes", "x", "--voiceover", "reading.m4a")).err).toContain("--voiceover and --no-voiceover go with --approve");

    const second = await run("resume", id, "--approve", "--voiceover", "reading.m4a");
    expect(second.err).toBe("");
    expect(second.code).toBe(2);
    expect(readFileSync(join(work, "inputs", "voiceover.m4a"), "utf8")).toBe("my voice");
    expect(second.out.split("\n")[0]).toBe("Picked the run back up after your review.");
    expect(second.out).toContain("Preparing the voiceover.");
    expect(second.out).toContain("  prepare_voiceover: Timed 38 words over 15.3 seconds from the creator's recording. Timings are in film/words.json.");
    expect(second.out).toContain("Building the film.");
    expect(second.out).toContain("  render_film: Rendered cut 1: 15.2 seconds, 1080 by 1920, 3.1 MB, with the voiceover. Saved as cuts/cut-1.mp4.");
    expect(second.out.split("\n").slice(-6)).toEqual([
      "Waiting for your review of the final cut.",
      "Waiting for your review of the final cut.",
      `  ${join(work, "cuts", "cut-1.mp4")}`,
      "Note with it: The map is simplified.",
      `Answer with: harness resume ${id} --approve   (or --changes "what to fix", or --reject)`,
      "",
    ]);
    // The agent was told where the recording is, as the creator's note on the approval.
    const approval = JSON.stringify(bodies[4]!.messages);
    expect(approval).toContain("The voiceover recording is at inputs/voiceover.m4a.");
    expect(box.commands.map((c) => c.command.slice(0, 2).join(" "))).toEqual(["python kit/align.py", "ffmpeg -v", "node kit/render.mjs"]);
    // The picture of the render went to the model with the result.
    expect(JSON.stringify(bodies[8]!.messages)).toContain(`"media_type":"image/jpeg","data":"${JPEG.toString("base64")}"`);

    // --- approving the cut ends the run ---
    const third = await run("resume", id, "--approve");
    expect(third.code).toBe(0);
    expect(third.out.split("\n").slice(-3)).toEqual(["Done. A 15 second reel on the missing votes.", `The film is at ${join(work, "cuts", "cut-1.mp4")}`, ""]);
    expect(existsSync(join(work, "cuts", "cut-1.mp4"))).toBe(true);
    expect([box.started, box.stopped]).toEqual([1, 1]);

    const inspect = await run("inspect", id);
    expect(inspect.out).toMatch(/stage {2}research\s+ok/);
    expect(inspect.out).toMatch(/stage {2}edit\s+ok/);
    expect(inspect.out).toMatch(/tool {3}render_film\s+ok/);

    const replay = await run("replay", id);
    expect(replay.out).toContain("Researching the topic.");
    expect(replay.out).toContain("You approved the final cut.");
  });

  it("gives a plain run a sandbox only when asked", async () => {
    const plain = cli([calls(["finish", { summary: "Nothing to do." }])]);
    await plain.run("run", "--task", "Say hello.");
    expect((plain.bodies[0]!.tools as Json[]).map((t) => t.name)).toEqual(["finish", "list_files", "read_file", "write_file"]);

    const boxed = cli([calls(["run_command", { command: ["node", "kit/render.mjs"] }]), calls(["finish", { summary: "Ran it." }])]);
    const result = await boxed.run("run", "--task", "Run the script.", "--sandbox");
    expect(result.code).toBe(0);
    expect((boxed.bodies[0]!.tools as Json[]).map((t) => t.name)).toEqual(["finish", "list_files", "read_file", "run_command", "view_image", "write_file"]);
    expect([boxed.box.started, boxed.box.stopped]).toEqual([1, 1]);
  });

  it("explains what is missing instead of failing obscurely", async () => {
    const { run } = cli([]);
    expect((await run("reel")).err).toContain('"harness reel" needs --topic "what the reel is about".');
    expect((await run("reel", "--topic", "x", "--seconds", "900")).err).toContain('--seconds is a length between 10 and 180, not "900".');
    expect((await run("reel", "--topic", "x", "--source", "notes.txt")).err).toContain('--source needs a web address, not "notes.txt".');
    expect((await run("reel", "--topic", "x", "--notes", "nowhere")).err).toContain("to use as notes.");
    expect((await run("reel", "--topic", "x", "--network", "lan")).err).toContain('--network is "none" or "public", not "lan".');
  });
});
