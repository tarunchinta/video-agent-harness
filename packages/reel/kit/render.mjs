// Renders film/index.html, frame by frame, from the same draw(t) the browser preview uses. Runs inside the
// sandbox, from the film folder:
//
//   node kit/render.mjs --stills           one still per named cue in FILM.T, and a contact sheet
//   node kit/render.mjs --stills 0 3 9.5   stills at those seconds
//   node kit/render.mjs --film             the full film -> out/film.mp4, and a contact sheet cut from the file
//
// The last line printed is one JSON object: {"ok": true, ...} or {"ok": false, "error": "..."}.
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = process.cwd();
const OUT = join(HERE, "out");
const args = process.argv.slice(2);
const WORKERS = Number(process.env.RENDER_WORKERS ?? 3);
const MAX_STILLS = 24;

function done(result) {
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
const fail = (error) => done({ ok: false, error: String(error).slice(0, 2000) });

if (!existsSync(join(HERE, "index.html"))) fail("there is no film/index.html yet");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--disable-gpu", "--font-render-hinting=none"] });
const pageErrors = [];

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${pathToFileURL(join(HERE, "index.html")).href}?render`);
  try {
    await page.waitForFunction(() => window.FILM?.ready === true, undefined, { timeout: 20_000 });
  } catch {
    await browser.close();
    fail(pageErrors.length ? `the page failed to load: ${pageErrors.join(" | ")}` : "the page never called Film.define, so there is nothing to draw");
  }
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page;
}

async function drawAt(page, t) {
  await page.evaluate((time) => window.FILM.draw(time), t);
  if (pageErrors.length) {
    await browser.close();
    fail(`drawing the frame at ${t.toFixed(2)} s failed: ${pageErrors.join(" | ")}`);
  }
}

/** One picture holding all the given frames, each with its label, sized to stay readable when shown to a model. */
async function contactSheet(dir, items) {
  const n = items.length;
  const cols = n <= 3 ? n : n <= 8 ? 4 : n <= 15 ? 5 : 6;
  const rows = Math.ceil(n / cols);
  const gap = 8, labelH = 30;
  let w = Math.min(420, Math.floor(1500 / cols) - gap);
  if (rows * (Math.round((w * 16) / 9) + labelH + gap) > 1560) w = Math.floor((((1560 / rows) - labelH - gap) * 9) / 16);
  const h = Math.round((w * 16) / 9);
  const cells = items
    .map((it) => `<figure><img src="${it.file}" width="${w}" height="${h}"><figcaption>${it.label.replace(/[<&]/g, "")}</figcaption></figure>`)
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#111;font:600 15px Inter,system-ui,sans-serif;color:#eee}
    #sheet{display:grid;grid-template-columns:repeat(${cols},${w}px);gap:${gap}px;padding:${gap}px;width:max-content}
    figure{margin:0} img{display:block} figcaption{height:${labelH}px;line-height:${labelH}px;padding:0 4px;white-space:nowrap;overflow:hidden}
  </style><div id="sheet">${cells}</div>`;
  writeFileSync(join(dir, "sheet.html"), html);
  const page = await browser.newPage({ viewport: { width: 1600, height: 1700 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(dir, "sheet.html")).href);
  await page.locator("#sheet").screenshot({ path: join(dir, "sheet.jpg"), type: "jpeg", quality: 82 });
  await page.close();
}

const first = await openPage();
const film = await first.evaluate(() => ({ fps: window.FILM.fps, duration: window.FILM.duration, T: window.FILM.T, events: window.FILM.events }));
if (!(film.duration > 0) || !(film.fps > 0)) { await browser.close(); fail("the film has no duration or frame rate"); }

if (args.includes("--stills")) {
  const asked = args.filter((a) => /^\d+(\.\d+)?$/.test(a)).map(Number);
  let list;
  if (asked.length) list = asked.map((t) => ({ t, name: "" }));
  else {
    const cues = Object.entries(film.T).filter(([, v]) => typeof v === "number").sort((a, b) => a[1] - b[1]);
    // A still just after each cue shows the beat once it has arrived, not the frame before it.
    list = cues.length
      ? cues.map(([name, t]) => ({ t: t + 0.6, name }))
      : Array.from({ length: 12 }, (_, i) => ({ t: ((i + 0.5) * film.duration) / 12, name: "" }));
  }
  if (list.length > MAX_STILLS) {
    const step = list.length / MAX_STILLS;
    list = Array.from({ length: MAX_STILLS }, (_, i) => list[Math.floor(i * step)]);
  }
  const dir = join(OUT, "stills");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const stills = [];
  for (const [i, item] of list.entries()) {
    const t = Math.min(Math.max(item.t, 0), film.duration);
    await drawAt(first, t);
    const file = `${String(i + 1).padStart(2, "0")}_${t.toFixed(2)}.jpg`;
    await first.screenshot({ path: join(dir, file), type: "jpeg", quality: 88 });
    stills.push({ n: i + 1, t: Number(t.toFixed(2)), ...(item.name ? { cue: item.name } : {}), file: `out/stills/${file}`, label: `${i + 1} · ${t.toFixed(2)} s${item.name ? ` · ${item.name}` : ""}` });
  }
  await contactSheet(dir, stills.map((s) => ({ file: s.file.replace("out/stills/", ""), label: s.label })));
  await browser.close();
  done({ ok: true, mode: "stills", duration: film.duration, fps: film.fps, stills: stills.map(({ label, ...rest }) => rest), sheet: "out/stills/sheet.jpg" });
}

if (!args.includes("--film")) { await browser.close(); fail("say --stills or --film"); }

// Full render: each worker takes a run of frames and encodes its own segment.
const TOTAL = Math.round(film.duration * film.fps);
const ranges = Array.from({ length: WORKERS }, (_, w) => [Math.floor((w * TOTAL) / WORKERS), Math.floor(((w + 1) * TOTAL) / WORKERS)]);
const started = Date.now();
try {
  await Promise.all(ranges.map(async ([a, b], w) => {
    const page = w === 0 ? first : await openPage();
    const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(film.fps), "-c:v", "mjpeg", "-i", "-",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(film.fps), join(OUT, `seg${w}.mp4`)], { stdio: ["pipe", "inherit", "inherit"] });
    const closed = new Promise((resolve, reject) => ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg stopped with code ${code}`)))));
    for (let f = a; f < b; f++) {
      await drawAt(page, f / film.fps);
      const frame = await page.screenshot({ type: "jpeg", quality: 94 });
      if (!ff.stdin.write(frame)) await new Promise((r) => ff.stdin.once("drain", r));
      if (w === 0 && f % 150 === 0) console.log(`frame ${f * WORKERS} of ${TOTAL} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
    ff.stdin.end();
    await closed;
  }));
  writeFileSync(join(OUT, "segments.txt"), ranges.map((_, w) => `file 'seg${w}.mp4'`).join("\n"));
  const silent = join(OUT, "film-silent.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(OUT, "segments.txt"), "-c", "copy", silent]);
  for (let w = 0; w < ranges.length; w += 1) rmSync(join(OUT, `seg${w}.mp4`), { force: true });

  // Sound: the voiceover when there is one, and each sound effect on the frame its event names.
  const inputs = [], filters = [], missing = [];
  let n = 0; // input 0 is the silent film, so sound input k is ffmpeg input k + 1
  const vo = join(HERE, "vo.m4a");
  const hasVoice = existsSync(vo);
  if (hasVoice) { inputs.push("-i", vo); filters.push(`[${n + 1}:a]highpass=f=80,aresample=48000,aformat=channel_layouts=stereo[a${n}]`); n++; }
  for (const e of film.events) {
    const file = [".flac", ".wav", ".mp3"].map((x) => join(HERE, "sfx", `${e.sfx}${x}`)).find(existsSync);
    if (!file) { missing.push(e.sfx); continue; }
    inputs.push("-i", file);
    filters.push(`[${n + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${Number(e.gain ?? 0)}dB,adelay=${Math.round(Number(e.t) * 1000)}:all=1[a${n}]`);
    n++;
  }
  const final = join(OUT, "film.mp4");
  const length = film.duration.toFixed(3);
  if (n === 0) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", silent, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", "1:a",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-t", length, "-movflags", "+faststart", final]);
  } else {
    const level = hasVoice ? "loudnorm=I=-14:TP=-1.5:LRA=11," : "";
    filters.push(`${Array.from({ length: n }, (_, i) => `[a${i}]`).join("")}amix=inputs=${n}:normalize=0:duration=longest,apad,atrim=0:${length},${level}alimiter=limit=0.84:level=false[mix]`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", silent, ...inputs, "-filter_complex", filters.join(";"), "-map", "0:v", "-map", "[mix]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", length, "-movflags", "+faststart", final]);
  }
  rmSync(silent, { force: true });

  // The contact sheet is cut from the finished file, so it shows what was encoded, not what the page drew.
  const dir = join(OUT, "review");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = [];
  for (let i = 0; i < 12; i++) {
    const t = ((i + 0.5) * film.duration) / 12;
    const file = `${String(i + 1).padStart(2, "0")}_${t.toFixed(2)}.jpg`;
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", final, "-frames:v", "1", "-q:v", "3", join(dir, file)]);
    frames.push({ file, label: `${i + 1} · ${t.toFixed(2)} s` });
  }
  await contactSheet(dir, frames);
  await browser.close();

  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", final]).toString());
  const video = probe.streams.find((s) => s.codec_type === "video");
  done({
    ok: true, mode: "film", film: "out/film.mp4", sheet: "out/review/sheet.jpg",
    duration: Number(Number(probe.format.duration).toFixed(2)), width: video?.width, height: video?.height, fps: film.fps,
    frames: TOTAL, bytes: statSync(final).size, voice: hasVoice, sound_effects: n - (hasVoice ? 1 : 0), missing_sound_effects: missing,
    render_seconds: Math.round((Date.now() - started) / 1000),
  });
} catch (err) {
  await browser.close().catch(() => {});
  fail(err instanceof Error ? err.message : err);
}
