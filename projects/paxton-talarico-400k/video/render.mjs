// Render index.html to MP4, frame by frame, from the same draw(t) the browser preview uses.
//   node render.mjs                 full film -> out/film.mp4 (SFX mix, plus vo.m4a when present)
//   node render.mjs --stills 0 3 9  stills at those seconds -> out/stills/*.png + out/stills/sheet.png
//   node render.mjs --stills        one still per cue in FILM.T -> board
//   node render.mjs --mix           redo only the sound on out/film-silent.mp4
//   node render.mjs --mute          no captions, no sound (for the mute test)
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const SFX = join(HERE, "sfx");
const CHROME = process.env.CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const args = process.argv.slice(2);
const mute = args.includes("--mute");
const WORKERS = Number(process.env.WORKERS ?? 3);
mkdirSync(OUT, { recursive: true });

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { console.error("page error:", e.message); process.exit(1); });
  await page.goto(pathToFileURL(join(HERE, "index.html")).href + "?render");
  await page.waitForFunction(() => window.FILM?.ready);
  if (mute) await page.addStyleTag({ content: "#captions{display:none!important}" });
  return page;
}

const browser = await chromium.launch({ executablePath: CHROME, args: ["--disable-gpu", "--font-render-hinting=none"] });
const first = await openPage(browser);
const film = await first.evaluate(() => ({ fps: FILM.fps, duration: FILM.duration, T: FILM.T, events: FILM.events }));
const TOTAL = Math.round(film.duration * film.fps);

if (args.includes("--mix")) { await browser.close(); mix(); process.exit(0); }

if (args.includes("--stills")) {
  const times = args.filter((a) => /^[\d.]+$/.test(a)).map(Number);
  const list = times.length ? times : Object.entries(film.T).filter(([k]) => k !== "end").map(([, v]) => v + 0.6).sort((a, b) => a - b);
  const dir = join(OUT, "stills"); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  let i = 0;
  for (const t of list) {
    await first.evaluate((t) => FILM.draw(t), t);
    await first.screenshot({ path: join(dir, `${String(i++).padStart(3, "0")}_${t.toFixed(2)}.png`) });
  }
  const cols = Math.min(8, list.length), rows = Math.ceil(list.length / cols);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-pattern_type", "glob", "-i", join(dir, "*.png"),
    "-vf", `scale=270:-1,drawtext=text='%{eif\\:n\\:d}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6,tile=${cols}x${rows}:padding=6`, "-frames:v", "1", join(dir, "sheet.png")]);
  console.log(`${list.length} stills -> ${dir}/sheet.png`);
  await browser.close(); process.exit(0);
}

// Full render: workers each take a contiguous range of frames and encode their own segment.
const ranges = Array.from({ length: WORKERS }, (_, w) => [Math.floor((w * TOTAL) / WORKERS), Math.floor(((w + 1) * TOTAL) / WORKERS)]);
const t0 = Date.now();
await Promise.all(ranges.map(async ([a, b], w) => {
  const page = w === 0 ? first : await openPage(browser);
  const seg = join(OUT, `seg${w}.mp4`);
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(film.fps), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(film.fps), seg], { stdio: ["pipe", "inherit", "inherit"] });
  for (let f = a; f < b; f++) {
    await page.evaluate((t) => FILM.draw(t), f / film.fps);
    const buf = await page.screenshot({ type: "jpeg", quality: 94 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (w === 0 && f % 60 === 0) console.log(`frame ${f}/${b} of worker 0  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on("close", (c) => (c === 0 ? r() : j(new Error("ffmpeg " + c)))));
}));
await browser.close();
writeFileSync(join(OUT, "segments.txt"), ranges.map((_, w) => `file 'seg${w}.mp4'`).join("\n"));
const silent = join(OUT, mute ? "film-mute.mp4" : "film-silent.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(OUT, "segments.txt"), "-c", "copy", silent]);
ranges.forEach((_, w) => rmSync(join(OUT, `seg${w}.mp4`)));
if (mute) { console.log(`-> ${silent}`); process.exit(0); }
mix();
console.log(`(${TOTAL} frames, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);

// Sound: each event's effect lands on the frame the thing happens; the VO goes under it when it exists.
function mix() {
const silent = join(OUT, "film-silent.mp4");
writeFileSync(join(OUT, "events.json"), JSON.stringify(film.events, null, 1));
const inputs = [], filters = [];
const vo = join(HERE, "vo.m4a");
let n = 0;   // input 0 is the silent film, so audio input k is ffmpeg input k + 1
if (existsSync(vo)) { inputs.push("-i", vo); filters.push(`[${n + 1}:a]highpass=f=80,aresample=48000,aformat=channel_layouts=stereo[a0]`); n++; }
for (const e of film.events) {
  const file = [".flac", ".wav"].map((x) => join(SFX, e.sfx + x)).find(existsSync);
  if (!file) { console.warn("missing sfx", e.sfx); continue; }
  inputs.push("-i", file);
  filters.push(`[${n + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${e.gain}dB,adelay=${Math.round(e.t * 1000)}:all=1[a${n}]`);
  n++;
}
filters.push(`${Array.from({ length: n }, (_, i) => `[a${i}]`).join("")}amix=inputs=${n}:normalize=0:duration=longest,apad,atrim=0:${film.duration.toFixed(3)},alimiter=limit=0.84[mix]`);
const final = join(OUT, "film.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", silent, ...inputs, "-filter_complex", filters.join(";"), "-map", "0:v", "-map", "[mix]",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", final]);
console.log(`-> ${final}`);
}
