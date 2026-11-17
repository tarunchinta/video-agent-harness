// The runtime every film page loads. No dependencies. Loaded after words.js, which sets window.WORDS.
//
// A film is one HTML page that can draw any moment of itself: Film.define({ duration, draw(t) }) and nothing
// else. The renderer calls draw for every frame, so the same page gives a preview, stills and the final video.
(function () {
  "use strict";

  const WORDS = Array.isArray(window.WORDS) ? window.WORDS : [];
  const norm = (w) => String(w).toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
  const tokens = (text) => String(text).split(/\s+/).map(norm).filter(Boolean);
  const spoken = WORDS.map((w) => norm(w.w));

  function find(phrase, nth) {
    const p = tokens(phrase);
    if (!p.length) throw new Error(`cue is empty: "${phrase}"`);
    const hits = [];
    for (let i = 0; i + p.length <= spoken.length; i++) if (p.every((x, j) => spoken[i + j] === x)) hits.push(i);
    const i = hits[nth ?? 0];
    if (i === undefined) {
      const why = hits.length ? `it is said ${hits.length} time(s), and you asked for number ${(nth ?? 0) + 1}` : "those words are not in the voiceover, in that order";
      throw new Error(`cue not found: "${phrase}" (${why}). Check film/words.json.`);
    }
    return [i, i + p.length - 1];
  }

  /** The time, in seconds, the first word of the phrase starts. `nth` picks a later occurrence (0-based). */
  const cue = (phrase, nth) => WORDS[find(phrase, nth)[0]].s;
  /** The time the last word of the phrase ends. */
  const cueEnd = (phrase, nth) => WORDS[find(phrase, nth)[1]].e;

  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, p) => a + (b - a) * p;
  const E = {
    lin: (x) => x,
    out: (x) => 1 - Math.pow(1 - x, 3),
    in: (x) => x * x * x,
    inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
    back: (x) => { const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); },
  };
  /** Progress from 0 to 1 of something that starts at `start` and takes `dur` seconds, eased. */
  const P = (t, start, dur = 0.5, ease = E.out) => ease(clamp((t - start) / dur));
  /** A seeded random source, so every render of a frame is the same. Never use Math.random in a film. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`there is no element with id "${id}"`);
    return el;
  };
  const css = (el, styles) => { for (const k in styles) el.style[k] = styles[k]; };
  const show = (el, on) => { el.style.display = on ? "block" : "none"; };
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const SVGNS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs, parent) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };

  // Captions: lines written by hand as sense units, checked word for word against the voiceover.
  function buildCaptions(lines) {
    let k = 0;
    return lines.map((line) => {
      const shown = String(line).split(/\s+/).filter((x) => norm(x));
      const words = WORDS.slice(k, k + shown.length);
      const want = shown.map(norm).join(" ");
      const got = words.map((w) => norm(w.w)).join(" ");
      if (want !== got) {
        throw new Error(`caption line does not match the voiceover: "${line}". The voiceover says "${words.map((w) => w.w).join(" ")}" there. Captions must follow film/words.json word for word, in order.`);
      }
      k += shown.length;
      return { shown, words, s: words[0].s, e: words[words.length - 1].e };
    });
  }

  function define(spec) {
    if (!spec || typeof spec.draw !== "function") throw new Error("Film.define needs a draw(t) function");
    const fps = spec.fps ?? 30;
    const duration = Number(spec.duration);
    if (!(duration > 0)) throw new Error("Film.define needs a duration in seconds");
    if (duration > 600) throw new Error("a film can be 10 minutes at most");
    const query = new URLSearchParams(location.search);
    const rendering = query.has("render");
    const mute = query.has("mute");

    const chunks = spec.captions ? buildCaptions(spec.captions.lines ?? spec.captions) : [];
    const captionEl = chunks.length ? $(spec.captions.el ?? "captions") : undefined;
    let lastKey = "";
    function drawCaptions(t) {
      if (!captionEl) return;
      let chunk;
      for (const c of chunks) if (c.s - 0.05 <= t) chunk = c;
      // A line stays up until the next one starts, but not through a long silence.
      if (chunk && t > chunk.e + 0.8) chunk = undefined;
      const on = chunk ? chunk.words.findLastIndex((w) => w.s <= t) : -1;
      const key = chunk ? `${chunks.indexOf(chunk)}:${on}` : "";
      if (key === lastKey) return;
      lastKey = key;
      captionEl.replaceChildren();
      captionEl.style.display = chunk && !mute ? "block" : "none";
      if (!chunk) return;
      chunk.shown.forEach((text, i) => {
        const span = document.createElement("span");
        span.className = i === on ? "w on" : "w";
        span.textContent = text;
        captionEl.appendChild(span);
        captionEl.appendChild(document.createTextNode(" "));
      });
    }

    const draw = (t) => {
      const at = clamp(t, 0, duration);
      spec.draw(at);
      drawCaptions(at);
    };

    document.body.classList.toggle("render", rendering);
    draw(0);
    window.FILM = { ready: true, fps, duration, width: 1080, height: 1920, T: spec.T ?? {}, events: spec.events ?? [], draw };
    if (!rendering) preview(window.FILM);
  }

  // Opening the page in a browser (without ?render) gives play and scrub controls, with the voiceover in sync.
  function preview(film) {
    const stage = document.getElementById("stage");
    const fit = () => {
      if (!stage) return;
      const k = Math.min(innerWidth / film.width, (innerHeight - 52) / film.height);
      stage.style.transform = `scale(${k})`;
      stage.style.left = `${(innerWidth - film.width * k) / 2}px`;
    };
    addEventListener("resize", fit);
    fit();
    const bar = document.createElement("div");
    bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;display:flex;gap:12px;align-items:center;padding:10px 16px;background:rgba(13,13,16,.92);color:#ddd;font:500 14px system-ui;z-index:10";
    const button = document.createElement("button");
    button.textContent = "Play";
    const range = document.createElement("input");
    range.type = "range"; range.min = "0"; range.max = String(film.duration); range.step = "0.01"; range.value = "0"; range.style.flex = "1";
    const label = document.createElement("span");
    bar.append(button, range, label);
    document.body.appendChild(bar);
    const audio = new Audio("vo.m4a");
    let t = 0, playing = false, last = 0;
    const paint = () => { film.draw(t); range.value = String(t); label.textContent = `${t.toFixed(2)} / ${film.duration.toFixed(2)} s`; };
    const tick = (now) => {
      if (!playing) return;
      t = audio.readyState >= 2 && !audio.paused ? audio.currentTime : t + (now - last) / 1000;
      last = now;
      if (t >= film.duration) { t = film.duration; playing = false; button.textContent = "Play"; audio.pause(); }
      paint();
      requestAnimationFrame(tick);
    };
    button.onclick = () => {
      playing = !playing;
      button.textContent = playing ? "Pause" : "Play";
      if (playing) { if (t >= film.duration) t = 0; audio.currentTime = t; audio.play().catch(() => {}); last = performance.now(); requestAnimationFrame(tick); }
      else audio.pause();
    };
    range.oninput = () => { t = Number(range.value); audio.currentTime = t; paint(); };
    paint();
  }

  window.Film = { words: WORDS, define, cue, cueEnd, norm, clamp, lerp, E, P, rng, $, css, show, fmt, svgEl };
})();
