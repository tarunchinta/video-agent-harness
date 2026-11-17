import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRun, decideGate, Engine, MemoryEventStore, payloadOf, type ToolResultBlock } from "@harness/harness";
import { respond, resultsIn, ScriptedProvider, toolCall } from "@harness/harness/testing";
import { DockerSandbox } from "@harness/sandbox-docker";
import { REEL_SYSTEM, reelPipeline, reelTask } from "../src/index.ts";

// The real kit in a real container: the page is drawn by Chromium and encoded by ffmpeg. Off by default,
// because it needs Docker and the built image (docker build -t harness-sandbox:local packages/sandbox-docker/image).
//
//   HARNESS_SANDBOX_IT=1 pnpm test
//   HARNESS_SANDBOX_IT_KEEP=1   also leave the run folder in place and print where it is, to look at the result
const enabled = process.env.HARNESS_SANDBOX_IT === "1";

const NARRATION = ["Texas might turn blue in November,", "because four hundred thousand Republicans", "disappeared in May.", "Take one of them:", "he votes in March, then stays home."];
const SCRIPT = `# The missing votes\n\n${"Beat: what is said, what is on screen, and the source that backs it. ".repeat(4)}`;

/** A small film written against the kit's contract: two scenes on cues, captions, and a seeded scatter of dots. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root { --paper: #ece5d3; --ink: #17161a; --accent: #f5a800; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: #0d0d10; overflow: hidden; font-family: Inter, sans-serif; }
#stage { position: absolute; left: 0; top: 0; width: 1080px; height: 1920px; overflow: hidden; background: var(--paper); transform-origin: 0 0; }
.scene { position: absolute; inset: 0; display: none; }
#captions { position: absolute; left: 100px; width: 880px; top: 1392px; text-align: center; font: 800 50px/1.18 Inter, sans-serif; }
#captions .on { background: var(--accent); }
</style></head><body>
<div id="stage">
  <div class="scene" id="s1"><div id="num" style="position:absolute; left:0; width:1080px; top:600px; text-align:center; font:900 220px/1 Inter;">400,000</div></div>
  <div class="scene" id="s2"><svg id="dots" width="1080" height="1920"></svg></div>
  <div id="captions"></div>
</div>
<script src="words.js"></script>
<script src="kit/film.js"></script>
<script>
const { cue, cueEnd, P, E, lerp, rng, $, css, show, svgEl } = Film;
const T = { hook: cue("Texas might"), number: cue("four hundred thousand"), take: cue("Take one") };
T.end = cueEnd("stays home");
const random = rng(7);
const dots = Array.from({ length: 60 }, () => svgEl("circle", { cx: 80 + random() * 920, cy: 300 + random() * 900, r: 14, fill: "#17161a" }, $("dots")));
Film.define({
  duration: T.end + 1,
  T,
  captions: { lines: ${JSON.stringify(NARRATION)} },
  draw(t) {
    show($("s1"), t < T.take);
    show($("s2"), t >= T.take);
    css($("num"), { opacity: P(t, T.number, 0.3), transform: "scale(" + lerp(0.8, 1, P(t, T.number, 0.4, E.back)) + ")" });
    dots.forEach((dot, i) => dot.setAttribute("opacity", P(t, T.take + i * 0.02, 0.2)));
  },
});
</script></body></html>`;

describe.skipIf(!enabled)("the film kit in a real sandbox", () => {
  it("draws stills, renders the film and shows the agent what it made", async () => {
    const root = mkdtempSync(join(tmpdir(), "reel-kit-it-"));
    const workDir = join(root, "work");
    mkdirSync(workDir, { recursive: true });
    const write = (path: string, content: string) => toolCall("write_file", { path, content });
    const stage = (name: string) => toolCall("start_stage", { stage: name });
    const provider = new ScriptedProvider([
      respond([stage("script")]),
      respond([write("script/script.md", SCRIPT), write("script/narration.txt", NARRATION.join("\n"))]),
      respond([toolCall("submit_script", {})]),
      respond([stage("assets")]),
      respond([toolCall("prepare_voiceover", {})]),
      respond([stage("edit")]),
      // A cue that is not in the voiceover: the render must say so, in words the agent can act on.
      respond([write("film/index.html", PAGE.replace('cue("Take one")', 'cue("Take two")'))]),
      respond([toolCall("render_stills", {})]),
      respond([write("film/index.html", PAGE)]),
      respond([toolCall("render_stills", {})]),
      respond([toolCall("render_film", {})]),
      respond([toolCall("submit_cut", {})]),
      respond([toolCall("finish", { summary: "Rendered.", film: "cuts/cut-1.mp4" })]),
    ]);
    const store = new MemoryEventStore();
    const runId = await createRun(store, { runId: `kit-it-${Date.now().toString(36)}`, task: reelTask({ topic: "A test film" }), model: "test-model", system: REEL_SYSTEM });
    const engine = new Engine({
      store,
      provider,
      workDir: () => workDir,
      artifactsDir: () => join(root, "artifacts"),
      sandbox: async (run) => {
        mkdirSync(run.artifactsDir, { recursive: true });
        return DockerSandbox.start({ runId: run.runId, workDir: run.workDir, artifactsDir: run.artifactsDir });
      },
      ...reelPipeline(),
    });
    const shown = (name: string, nth = 0): ToolResultBlock => {
      const request = provider.requests.at(-1)!;
      const id = [...resultsIn(request).entries()].filter(([, r]) => r.name === name)[nth]![0];
      return request.messages.flatMap((m) => m.content).find((b): b is ToolResultBlock => b.type === "tool_result" && b.toolCallId === id)!;
    };

    try {
      expect((await engine.run(runId)).status).toBe("waiting_gate");
      await decideGate(store, runId, { gate: "script", decision: "approved" });
      expect(await engine.run(runId)).toMatchObject({ status: "waiting_gate", gate: "final_cut" });

      const broken = shown("render_stills", 0);
      expect(broken.isError).toBe(true);
      expect(broken.content).toContain('cue not found: "Take two"');

      const stills = shown("render_stills", 1);
      expect(stills.isError).toBeUndefined();
      expect(stills.content).toContain("4 frames, shown on the contact sheet in this order:");
      expect(stills.content).toContain("(hook)");
      expect(stills.images).toHaveLength(1);
      expect(stills.images![0]!.mediaType).toBe("image/jpeg");
      expect(Buffer.from(stills.images![0]!.data!, "base64").length).toBeGreaterThan(5_000);

      const film = shown("render_film");
      expect(film.isError).toBeUndefined();
      expect(film.content).toMatch(/Rendered cut 1: \d+\.\d seconds, 1080 by 1920, \d+\.\d MB, with no voice/);
      expect(film.images).toHaveLength(1);
      const cut = join(workDir, "cuts", "cut-1.mp4");
      expect(statSync(cut).size).toBeGreaterThan(50_000);
      // An MP4 starts with a box whose type is `ftyp`.
      expect(readFileSync(cut).subarray(4, 8).toString("latin1")).toBe("ftyp");

      await decideGate(store, runId, { gate: "final_cut", decision: "approved" });
      expect((await engine.run(runId)).status).toBe("succeeded");
      const events = await store.read(runId);
      expect(events.filter((e) => e.type === "sandbox.completed").map((e) => payloadOf(e, "sandbox.completed").exit_reason)).toEqual(["gate"]);
    } finally {
      if (process.env.HARNESS_SANDBOX_IT_KEEP === "1") console.log(`kept ${root}`);
      else rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
});
