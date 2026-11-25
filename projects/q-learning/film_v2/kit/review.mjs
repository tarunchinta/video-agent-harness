// Measures a rendered cut for the critic. Runs inside the sandbox, from the film folder:
//
//   node kit/review.mjs ../cuts/cut-2.mp4
//
// It reads the file the way a viewer would get it, not the page that drew it: how long it is, where the picture
// goes black or stops moving, where the sound goes quiet, how loud it is, and a timeline of frames taken from the
// file, each labelled with the words being spoken at that moment (from words.json). The idea of a timeline sheet
// that pairs frames with the words heard over them is borrowed from video-use's timeline view.
//
// The last line printed is one JSON object: {"ok": true, ...} or {"ok": false, "error": "..."}.
import { chromium } from "playwright";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = process.cwd();
const DIR = join(HERE, "out", "critique");
const FRAMES = 16;

function done(result) {
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
const fail = (error) => done({ ok: false, error: String(error).slice(0, 2000) });

const cut = process.argv[2];
if (!cut || !existsSync(cut)) fail(`there is no cut at ${cut}`);
const words = existsSync(join(HERE, "words.json")) ? JSON.parse(readFileSync(join(HERE, "words.json"), "utf8")) : [];

/** Runs ffmpeg with a filter that only reports, and returns what it printed. */
function analyse(filters, { audio = false } = {}) {
  const args = ["-hide_banner", "-nostats", "-i", cut, ...(audio ? ["-vn", "-af", filters] : ["-an", "-vf", filters]), "-f", "null", "-"];
  return spawnSync("ffmpeg", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stderr ?? "";
}

/** Pairs `name_start: x` and `name_end: y` lines into ranges. */
function ranges(text, name) {
  const out = [];
  let open;
  for (const m of text.matchAll(new RegExp(`${name}_(start|end):\\s*(-?[\\d.]+)`, "g"))) {
    const t = Number(m[2]);
    if (m[1] === "start") open = t;
    else if (open !== undefined) {
      out.push({ start: Number(open.toFixed(2)), end: Number(t.toFixed(2)) });
      open = undefined;
    }
  }
  return { out, open };
}

try {
  const probe = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", cut]).toString(),
  );
  const duration = Number(Number(probe.format.duration).toFixed(2));
  const video = probe.streams.find((s) => s.codec_type === "video");
  const hasAudio = probe.streams.some((s) => s.codec_type === "audio");

  const black = ranges(analyse("blackdetect=d=0.3:pix_th=0.08"), "black");
  if (black.open !== undefined) black.out.push({ start: Number(black.open.toFixed(2)), end: duration });

  // freezedetect prints freeze_start, freeze_duration and freeze_end.
  const frozen = analyse("freezedetect=n=0.003:d=2.5");
  const freezes = ranges(frozen.replaceAll("lavfi.freezedetect.", ""), "freeze");
  if (freezes.open !== undefined) freezes.out.push({ start: Number(freezes.open.toFixed(2)), end: duration });

  let silences = [];
  let loudness = null;
  if (hasAudio) {
    const quiet = ranges(analyse("silencedetect=noise=-45dB:d=1.2", { audio: true }), "silence");
    if (quiet.open !== undefined) quiet.out.push({ start: Number(quiet.open.toFixed(2)), end: duration });
    silences = quiet.out;
    const ebu = analyse("ebur128=peak=true", { audio: true });
    const integrated = /I:\s*(-?[\d.]+) LUFS/.exec(ebu.slice(ebu.lastIndexOf("Summary")));
    const peak = /Peak:\s*(-?[\d.]+|-inf) dBFS/.exec(ebu.slice(ebu.lastIndexOf("True peak")));
    loudness = {
      integrated_lufs: integrated ? Number(integrated[1]) : null,
      true_peak_db: peak && peak[1] !== "-inf" ? Number(peak[1]) : null,
    };
  }

  // The timeline: frames spread over the cut, each with what is being said then.
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const spokenAt = (t) => {
    const near = words.filter((w) => w.e >= t - 0.9 && w.s <= t + 0.9).map((w) => w.w);
    return near.join(" ");
  };
  const frames = [];
  for (let i = 0; i < FRAMES; i++) {
    const t = Math.min(duration - 0.05, ((i + 0.5) * duration) / FRAMES);
    const file = `${String(i + 1).padStart(2, "0")}_${t.toFixed(2)}.jpg`;
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", cut, "-frames:v", "1", "-q:v", "3", join(DIR, file)]);
    frames.push({ n: i + 1, t: Number(t.toFixed(2)), words: spokenAt(t), file });
  }

  // One sheet, four by four, each frame labelled with its number, its time and the words over it.
  const w = 300, h = Math.round((w * 16) / 9), labelH = 46, gap = 8;
  const cells = frames
    .map((f) => `<figure><img src="${f.file}" width="${w}" height="${h}"><figcaption><b>${f.n} · ${f.t.toFixed(1)} s</b><br>${f.words.replace(/[<&]/g, "") || "&nbsp;"}</figcaption></figure>`)
    .join("");
  writeFileSync(
    join(DIR, "sheet.html"),
    `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#111;font:500 13px Inter,system-ui,sans-serif;color:#eee}
      #sheet{display:grid;grid-template-columns:repeat(4,${w}px);gap:${gap}px;padding:${gap}px;width:max-content}
      figure{margin:0} img{display:block} figcaption{height:${labelH}px;padding:2px 4px;overflow:hidden;line-height:1.3}
    </style><div id="sheet">${cells}</div>`,
  );
  const browser = await chromium.launch({ args: ["--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 2400 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(DIR, "sheet.html")).href);
  await page.locator("#sheet").screenshot({ path: join(DIR, "sheet.jpg"), type: "jpeg", quality: 80 });
  await browser.close();

  done({
    ok: true,
    duration,
    width: video?.width,
    height: video?.height,
    audio: hasAudio,
    black: black.out,
    freezes: freezes.out,
    silences,
    loudness,
    first_word: words[0]?.s ?? null,
    last_word: words.at(-1)?.e ?? null,
    frames: frames.map(({ n, t, words: said }) => ({ n, t, words: said })),
    sheet: "out/critique/sheet.jpg",
  });
} catch (err) {
  fail(err instanceof Error ? err.message : err);
}
