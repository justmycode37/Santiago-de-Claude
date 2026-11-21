// Pitch video, version 3: the first video's look (dark, yellow accent, phone and night panel)
// with the second video's pace for the problem part, the voice "Jon", real app footage only,
// a different shot style for every feature, a dark-mode click in the background and an animated logo.
// Usage: node build3.mjs [--no-media]
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import QRCode from "qrcode";

const B = path.dirname(new URL(import.meta.url).pathname.slice(1));
const ROOT = path.dirname(B);
const VO = path.join(ROOT, "voice", "out-v4", "jon");
// The night clip: the CLIP environment variable, else the proxy in footage/ (handoff copy), else the original on the desktop PC.
const PROXY = path.join(ROOT, "footage", "IMG_3466-proxy.mp4");
const CLIP = process.env.CLIP || (fs.existsSync(PROXY) ? PROXY : "G:/My Drive/Upload-Inbox/IMG_3466.mov");
const DEMO = path.join(ROOT, "demo-assets");
const SHOTS = path.join(ROOT, "capture", "shots");
const P = path.join(ROOT, "pitch-v3");
const ASSETS = path.join(P, "assets");
const WORK = path.join(B, "work3");
const NO_MEDIA = process.argv.includes("--no-media");
for (const d of [ASSETS, WORK, path.join(P, "compositions")]) fs.mkdirSync(d, { recursive: true });
const ff = (args) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { cwd: B, stdio: ["ignore", "pipe", "pipe"] });
const r3 = (x) => Math.round(x * 1000) / 1000;
// colours of version 2: the team's palette (demo/palette.png) on a night-navy ground
const C = { ground: "#0f1524", ink: "#fcfcfc", dim: "#8d95a8", accent: "#FFD34B", navy: "#344D77", magenta: "#C55A82", orange: "#FF7241" };

// ------------------------------------------------------------------ narration
const ACTS = { a1: "a1-night", a2: "a2-weight", a3: "a3-turn", a4: "a4-answer", a5: "a5-beyond", a6: "a6-return" };
const sen = {};
for (const [k, file] of Object.entries(ACTS)) {
  const words = JSON.parse(fs.readFileSync(path.join(VO, file + ".json"), "utf8")).words;
  const groups = [];
  let cur = [];
  for (const w of words) { cur.push(w); if (/[.?!]$/.test(w.text)) { groups.push(cur); cur = []; } }
  if (cur.length) groups.push(cur);
  sen[k] = groups.map((ws) => ({ text: ws.map((w) => w.text).join(" "), s: ws[0].start, e: ws.at(-1).end, ws }));
  sen[k].forEach((x, i, all) => {
    x.cs = Math.max(i ? all[i - 1].e + 0.02 : 0, x.s - 0.04);
    x.ce = Math.min(i + 1 < all.length ? all[i + 1].s - 0.02 : x.e + 0.35, x.e + 0.24);
    x.file = path.join(VO, file + ".mp3");
  });
  console.log(k, sen[k].map((x, i) => i + ":" + x.text).join(" | "));
}

// ------------------------------------------------------------------ timeline
let T = 0;
const say = [], quotes = [], a1segs = [], mark = {};
const TEMPO = { a1: 1.08, a2: 1.1, a3: 1.06, a4: 1.1, a5: 1.12, a6: 1.06 };
const S = (act, i, gap) => {
  const x = sen[act][i], k = TEMPO[act];
  const item = { act, i, text: x.text, clipAt: T, start: r3(T + (x.s - x.cs) / k), end: r3(T + (x.e - x.cs) / k), cs: x.cs, dur: x.ce - x.cs, file: x.file, tempo: k };
  say.push(item);
  T = item.end + gap;
  return item;
};
const seg = (src) => a1segs.push({ t: r3(T), src });
const Q = (id, src0, src1, lines) => {
  const q = { id, t: r3(T), src0, src1, dur: src1 - src0, lines };
  quotes.push(q);
  a1segs.push({ t: q.t, src: src0 });
  T = q.t + q.dur + 0.04;
};
const say1 = (act, from, to, gap, lastGap = gap) => { for (let i = from; i <= to; i++) S(act, i, i === to ? lastGap : gap); };

// ACT 1 — the night (pace of version 2)
a1segs.push({ t: 0, src: 2.2 });
T = 0.35;
say1("a1", 0, 2, 0.2, 0.12);
Q("q1", 28.3, 29.75, ["Nobody knows."]);
seg(8.0); say1("a1", 3, 4, 0.16, 0.12);
seg(137.0); S("a1", 5, 0.06);
Q("q2", 32.9, 35.35, ["We're even at the correct spot, according to SBB."]);
seg(175.6); S("a1", 6, 0.06);
Q("q3", 181.05, 182.65, ["There's no indicator where we are."]);
Q("q4", 88.5, 89.85, ["We're pulling out the big guns."]);
seg(89.9); S("a1", 7, 0.08);
Q("q5a", 242.5, 243.45, ["That's the one!"]);
seg(246.0); S("a1", 8, 0);
Q("q5b", 249.25, 250.35, ["No! No way."]);
mark.bus = r3(T); a1segs.push({ t: mark.bus, src: 252.5 }); T += 2.3;
mark.black = r3(T); T += 0.55;
// ACT 2 — the weight
mark.a2 = r3(T); T += 0.1;
S("a2", 0, 0.24);
say1("a2", 1, 3, 0.12, 0.22);
say1("a2", 4, 7, 0.14, 0.26);
say1("a2", 8, 11, 0.14, 0.3);
// ACT 3 — the turn
mark.a3 = r3(T); T += 0.1;
S("a3", 0, 0.25);
const santiago = S("a3", 1, 0.5);
// ACT 4 — the answer
mark.a4 = r3(T);
say1("a4", 0, 2, 0.16, 0.3);
say1("a4", 3, 6, 0.18, 0.3);
S("a4", 7, 0.2); S("a4", 8, 0.45);
// ACT 5 — beyond our problem
mark.a5 = r3(T);
S("a5", 0, 0.2); S("a5", 1, 0.35);
say1("a5", 2, 3, 0.14, 0.28);
say1("a5", 4, 5, 0.16, 0.28);
say1("a5", 6, 7, 0.16, 0.3);
S("a5", 8, 0.25);
say1("a5", 9, 11, 0.2, 0.3);
say1("a5", 12, 13, 0.2, 0.28);
S("a5", 14, 0.22); S("a5", 15, 0.16); S("a5", 16, 0.2); S("a5", 17, 0.3);
S("a5", 18, 0.5); // the ticket
mark.belong = r3(T);
say1("a5", 19, 20, 0.24, 0.6);
// ACT 6 — the return
mark.a6 = r3(T); T += 0.15;
say1("a6", 0, 2, 0.2, 0.25);
say1("a6", 3, 5, 0.2, 0.45);
say1("a6", 6, 7, 0.34, 0);
mark.end = r3(T + 3.8);
const END = mark.end;
const A = (act, i) => say.find((x) => x.act === act && x.i === i);
const cut = (act, i) => r3(A(act, i).start - 0.1);
// when a word inside a sentence is spoken
const wordAt = (act, i, prefix) => { const x = sen[act][i]; const w = x.ws.find((w) => w.text.toLowerCase().startsWith(prefix)); return r3(A(act, i).start + (w.start - x.s) / TEMPO[act]); };

// Beat boundaries. Every feature gets its own way of showing the app.
const t4 = { A: mark.a4, A3: cut("a4", 3), B: cut("a4", 4), B5: cut("a4", 5), B6: cut("a4", 6), C0: cut("a4", 7), C: cut("a4", 8), turn: wordAt("a4", 8, "and"), end: 0 };
const t5 = { D: 0, E: cut("a5", 2), F: cut("a5", 4), G: cut("a5", 6), H: cut("a5", 8), I: cut("a5", 9), J: cut("a5", 12), K: cut("a5", 14), L: cut("a5", 18), end: mark.belong };
t4.end = mark.a5; t5.D = mark.a5;
console.log("marks:", JSON.stringify(mark));

// ------------------------------------------------------------------ media
const FPS = 30;
const fr = (t) => Math.round(t * FPS);
const REC = (n) => path.join(DEMO, `rec${n}.mov`);
const X = (x, y, w) => [x, y, w, Math.round((w * 9) / 16)];
// several pieces of one source, cut to the frame, into one clip of a given size
// ONLY=name,name re-renders just those pieces (the full set takes minutes when the PC is busy)
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
function clip(name, src, segs, w, h, crop) {
  if (ONLY && !ONLY.includes(name)) return;
  const args = [], parts = [];
  let acc = 0;
  segs.forEach((s) => {
    const n = fr(acc + s.dur) - fr(acc); acc += s.dur;
    if (n <= 0) return;
    const sp = s.speed || 1;
    args.push("-ss", String(r3(s.t0)), "-t", String(r3(s.dur * sp + 0.6)), "-i", src);
    const k = parts.length, c = crop ? `crop=${crop[2]}:${crop[3]}:${crop[0]}:${crop[1]},` : "";
    parts.push(`[${k}:v]${c}setpts=PTS/${sp},fps=${FPS},scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1,tpad=stop_mode=clone:stop_duration=6,trim=end_frame=${n},setpts=PTS-STARTPTS[v${k}]`);
  });
  const graph = parts.join(";") + ";" + parts.map((_, k) => `[v${k}]`).join("") + `concat=n=${parts.length}:v=1:a=0,format=yuv420p[out]`;
  fs.writeFileSync(path.join(WORK, name + ".graph"), graph);
  ff([...args, "-filter_complex_script", path.join(WORK, name + ".graph"), "-map", "[out]", "-an", "-c:v", "libx264", "-crf", "15", "-g", "15", path.join(ASSETS, name + ".mp4")]);
}
const still = (name, src, t, crop, w, h) => (ONLY && !ONLY.includes(name)) || ff([...(t === null ? [] : ["-ss", String(t)]), "-i", src, "-vf", `crop=${crop[2]}:${crop[3]}:${crop[0]}:${crop[1]},scale=${w}:${h}:flags=lanczos`, "-frames:v", "1", path.join(ASSETS, name + ".png")]);

// The dark-mode moment: the recording switches at 0.84 s; it is slowed so the whole beat lasts as long as the two sentences.
const dD = t5.E - t5.D, spD = 1.6 / dD, flip = r3(t5.D + (0.84 - 0.2) / spD);
const dK = [A("a5", 15).start - 0.08 - t5.K, A("a5", 16).start - A("a5", 15).start, A("a5", 17).start - A("a5", 16).start, t5.L - A("a5", 17).start + 0.08];

if (!NO_MEDIA) {
  // the night
  const night = (name, segs, endT, w, h) => clip(name, CLIP, segs.map((s, i) => ({ t0: s.src, dur: (i + 1 < segs.length ? segs[i + 1].t : endT) - s.t })), w, h);
  night("night-a1", a1segs, mark.black, 540, 960);
  night("night-a4", [{ t: t4.A, src: 27.2 }, { t: t4.A3, src: 137.2 }, { t: t4.C0, src: 249.8 }], t4.C, 394, 700);
  night("night-a6", [{ t: mark.a6, src: 2.2 }], cut("a6", 3), 540, 960);
  // act 4: phone still, three close-ups, phone with the walk
  // the journey still is from the live site (14:39) and already has the Get ticket button
  fs.copyFileSync(path.join(SHOTS, "ticket.png"), path.join(ASSETS, "journey.png"));
  still("tk", path.join(SHOTS, "ticket.png"), null, X(0, 2026, 900), 1920, 1080);
  still("b1", REC(4), 24.2, X(0, 1240, 1206), 1920, 1080);
  still("b2", REC(4), 24.2, X(40, 1300, 800), 1920, 1080);
  still("b3", REC(4), 24.2, X(300, 1390, 870), 1920, 1080);
  clip("phC", REC(2), [{ t0: 2.9, dur: t4.turn - t4.C }, { t0: 6.2, dur: t4.end - t4.turn, speed: 2.2 }], 800, 1620);
  // act 5
  clip("phD", REC(1), [{ t0: 0.2, dur: dD, speed: spD }], 800, 1620);
  clip("mE", REC(1), [{ t0: 5.0, dur: t5.F - t5.E }], 1920, 1080, X(0, 560, 1206));
  clip("phF", REC(1), [{ t0: 9.45, dur: t5.G - t5.F }], 800, 1620);
  clip("gG", REC(1), [{ t0: 27.3, dur: t5.H - t5.G }], 960, 1080, [0, 380, 1206, 1357]);
  clip("mH", REC(4), [{ t0: 11.7, dur: t5.I - t5.H, speed: 1.7 }], 1920, 1080, X(0, 700, 1206));
  still("i1", REC(1), 23.5, [0, 272, 1206, 170], 960, 135);
  still("i2", REC(1), 23.5, [0, 428, 1206, 170], 960, 135);
  still("i3", REC(1), 23.5, [0, 612, 1206, 170], 960, 135);
  still("i4", REC(4), 19.0, [72, 1000, 800, 760], 600, 570);
  clip("mJ", REC(1), [{ t0: 29.9, dur: t5.K - t5.J }], 1920, 1080, X(0, 1090, 1206));
  clip("phK", REC(3), [{ t0: 0.2, dur: dK[0] }, { t0: 2.9, dur: dK[1] }, { t0: 3.9, dur: dK[2] * 0.42 }, { t0: 8.0, dur: dK[2] * 0.58 }, { t0: 14.4, dur: dK[3] }], 800, 1620);
  // logo: white wordmark with transparency, without its dots (they are drawn and animated separately)
  ff(["-i", path.join(DEMO, "logo-frame.png"), "-f", "lavfi", "-i", "color=c=white:s=1300x400:d=1", "-filter_complex",
    "[0:v]crop=1300:400:310:290,drawbox=x=646:y=18:w=126:h=128:color=white:t=fill,format=gray,negate[a];[1:v]format=rgba[c];[c][a]alphamerge[out]", "-map", "[out]", "-frames:v", "1", path.join(ASSETS, "wordmark.png")]);
  console.log("media rendered");
}
// the site moved from Vercel to GitHub Pages at 14:25
const LIVE = "justmycode37.github.io/Santiago-de-Claude";
await QRCode.toFile(path.join(ASSETS, "qr.png"), "https://" + LIVE + "/", { width: 600, margin: 0, color: { dark: C.navy, light: "#ffffff" } });

// ------------------------------------------------------------------ sound
const SND = (n) => path.join(B, "sound", n + ".mp3");
const sfx = [];
const fx = (name, t, gain = 1) => sfx.push({ file: SND(name), at: Math.max(0, t), gain });
[5, 6, 7].forEach((i) => fx("hit", A("a1", i).start - 0.05, 0.55));
quotes.forEach((q) => fx("whoosh", q.t - 0.22, 0.35));
fx("suck", mark.black - 2.15, 0.8);
[4, 5, 6, 7].forEach((i) => fx("thump", A("a2", i).start - 0.05, 0.6));
[9, 10, 11].forEach((i) => fx("thump", A("a2", i).start - 0.05, 1.0));
fx("riser", santiago.start - 2.45, 0.7);
fx("hit", santiago.start - 0.03, 1.0);
[t4.B, t4.B5, t4.B6, t4.C0, t4.C, t5.D, t5.E, t5.F, t5.G, t5.H, t5.I, t5.J, t5.K, t5.L].forEach((t) => fx("whoosh", t - 0.1, 0.5));
fx("tick", A("a5", 18).start + 0.85, 1.0); // the tap on Get ticket
fx("chime", A("a4", 2).start - 0.02, 0.7);
[["a4", 1], ["a5", 3], ["a5", 5], ["a5", 7], ["a5", 9], ["a5", 10], ["a5", 11], ["a5", 13], ["a5", 15], ["a5", 16], ["a5", 17]].forEach(([a, i]) => fx("tick", A(a, i).start - 0.03, 0.8));
fx("tick", flip - 0.12, 1.0); // the click on the dark-mode button
fx("hit", A("a5", 20).start - 0.03, 0.9);
[3, 4, 5].forEach((i) => fx("tick", A("a6", i).start - 0.03, 0.8));
const logoAt = r3(A("a6", 6).start - 0.1);
fx("spin", logoAt, 0.9);
fx("chime", logoAt + 1.25, 0.8);

function stem(name, items) {
  const args = [];
  const parts = items.map((it, k) => {
    if (it.ss !== undefined) args.push("-ss", String(r3(it.ss)));
    if (it.t !== undefined) args.push("-t", String(r3(it.t)));
    args.push("-i", it.file);
    const f = [`aresample=48000`, `aformat=sample_fmts=fltp:channel_layouts=stereo`];
    if (it.gain !== undefined && it.gain !== 1) f.push(`volume=${it.gain}`);
    if (it.fin) f.push(`afade=t=in:st=0:d=${it.fin}`);
    if (it.fout && it.t) f.push(`afade=t=out:st=${r3(it.t - it.fout)}:d=${it.fout}`);
    if (it.tempo && it.tempo !== 1) f.push(`atempo=${it.tempo}`);
    f.push(`adelay=${Math.round(it.at * 1000)}:all=1`);
    return `[${k}:a]${f.join(",")}[x${k}]`;
  });
  const graph = parts.join(";") + ";" + items.map((_, k) => `[x${k}]`).join("") + `amix=inputs=${items.length}:normalize=0:dropout_transition=0,apad,atrim=0:${END}[out]`;
  fs.writeFileSync(path.join(WORK, name + ".graph"), graph);
  ff([...args, "-filter_complex_script", path.join(WORK, name + ".graph"), "-map", "[out]", "-ar", "48000", "-ac", "2", path.join(WORK, name + ".wav")]);
}
function measure(name) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", path.join(WORK, name + ".wav"), "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { cwd: B, encoding: "utf8" });
  const m = [...String(r.stderr).matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1);
  return m ? +m[1] : null;
}
if (!NO_MEDIA) {
  const clipWav = path.join(B, "work", "clip.wav");
  if (!fs.existsSync(clipWav)) { fs.mkdirSync(path.dirname(clipWav), { recursive: true }); ff(["-i", CLIP, "-map", "0:a:0", "-ac", "2", "-ar", "48000", clipWav]); }
  stem("vo", say.map((x) => ({ file: x.file, ss: x.cs, t: x.dur, at: x.clipAt, fout: 0.06, tempo: x.tempo })));
  stem("quotes", [
    ...quotes.map((q) => ({ file: clipWav, ss: q.src0, t: q.dur, at: q.t, fin: 0.04, fout: 0.06 })),
    { file: clipWav, ss: 252.5, t: mark.black - mark.bus, at: mark.bus, fin: 0.05, fout: 0.45 },
  ]);
  const amb = [];
  a1segs.forEach((s, i) => {
    if (quotes.some((q) => q.t === s.t) || s.t === mark.bus) return;
    const end = i + 1 < a1segs.length ? a1segs[i + 1].t : mark.black;
    amb.push({ file: clipWav, ss: s.src, t: end - s.t, at: s.t, fin: 0.12, fout: 0.12 });
  });
  amb.push({ file: clipWav, ss: 2.2, t: cut("a6", 3) - mark.a6, at: mark.a6, fin: 0.3, fout: 0.4 });
  stem("amb", amb);
  stem("sfx", sfx.map((x) => ({ file: x.file, at: x.at, gain: x.gain })));
  const driveLen = 66.06, driveAt = santiago.start - 0.05, driveSs = Math.max(0, driveLen - (END - 0.6 - driveAt));
  stem("music", [
    { file: SND("music-dark"), ss: 0, t: Math.min(58, santiago.start + 0.3), at: 0, fin: 1.0, fout: 2.2 },
    { file: SND("music-drive"), ss: driveSs, t: driveLen - driveSs, at: driveAt, fin: 0.12, fout: 0.3 },
  ]);
  const target = { vo: -16, quotes: -17, amb: -33, music: -20 };
  const gain = {};
  for (const k of Object.keys(target)) {
    const l = measure(k);
    gain[k] = l === null ? 1 : Math.pow(10, (target[k] - l) / 20);
    console.log("stem", k, "measured", l, "LUFS, gain", gain[k].toFixed(2));
  }
  const g = [
    `[0:a]volume=${gain.vo.toFixed(3)}[vo]`, `[1:a]volume=${gain.quotes.toFixed(3)}[q]`,
    `[2:a]volume=${gain.amb.toFixed(3)}[amb]`, `[3:a]volume=0.55[fx]`, `[4:a]volume=${gain.music.toFixed(3)}[mu]`,
    `[vo][q]amix=inputs=2:normalize=0[speech]`, `[speech]asplit=2[sp1][key]`,
    `[mu][key]sidechaincompress=threshold=0.02:ratio=5:attack=15:release=450[mduck]`,
    `[sp1][mduck][amb][fx]amix=inputs=4:normalize=0,alimiter=limit=0.9,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[out]`,
  ].join(";");
  fs.writeFileSync(path.join(WORK, "final.graph"), g);
  ff(["-i", path.join(WORK, "vo.wav"), "-i", path.join(WORK, "quotes.wav"), "-i", path.join(WORK, "amb.wav"), "-i", path.join(WORK, "sfx.wav"), "-i", path.join(WORK, "music.wav"),
    "-filter_complex_script", path.join(WORK, "final.graph"), "-map", "[out]", "-ar", "48000", "-ac", "2", path.join(ASSETS, "soundtrack.wav")]);
  console.log("soundtrack ok");
}
fs.writeFileSync(path.join(WORK, "timeline.json"), JSON.stringify({ mark, t4, t5, flip, logoAt, say, quotes }, null, 1));

// ------------------------------------------------------------------ scenes
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const CHIP = { navy: [C.navy, "#ffffff"], magenta: [C.magenta, "#ffffff"], yellow: [C.accent, "#1d2a44"], orange: [C.orange, "#ffffff"] };
const base = (p) => `
    #root { position: absolute; inset: 0; }
    .${p}-t { position: absolute; font-family: Inter, sans-serif; font-weight: 700; letter-spacing: -0.035em; line-height: 1.04; color: ${C.ink}; }
    .${p}-ph { position: absolute; width: 418px; height: 884px; padding: 9px; border-radius: 54px; background: #1b1c21; box-shadow: 0 0 0 1px rgba(255,255,255,0.12), 0 40px 120px rgba(0,0,0,0.6); }
    .${p}-scr { position: relative; width: 400px; height: 866px; border-radius: 45px; overflow: hidden; background: #e9e9ea; }
    .${p}-scr img { position: absolute; left: 0; top: 0; width: 400px; height: 866px; display: block; }
    .${p}-iph { position: absolute; width: 418px; height: 828px; padding: 9px; border-radius: 54px; background: #1b1c21; box-shadow: 0 0 0 1px rgba(255,255,255,0.12), 0 40px 120px rgba(0,0,0,0.6); }
    .${p}-iph video { display: block; width: 400px; height: 810px; border-radius: 45px; }
    .${p}-full { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }
    .${p}-full video, .${p}-full img { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; display: block; }
    .${p}-chip { position: absolute; left: 96px; top: 800px; padding: 22px 44px 26px; border-radius: 30px; font-family: Inter, sans-serif; font-weight: 900; font-size: 104px; letter-spacing: -0.04em; line-height: 1; white-space: nowrap; box-shadow: 0 18px 60px rgba(0,0,0,0.45); }`;
function scene(id, start, end, css, html, js) {
  fs.writeFileSync(path.join(P, "compositions", id + ".html"), `<template>
  <style>${base(id)}${css}
  </style>
  <div id="root" data-composition-id="${id}" data-width="1920" data-height="1080">${html}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    const up = (sel, t, y = 44, d = 0.42) => tl.fromTo(sel, { opacity: 0, y }, { opacity: 1, y: 0, duration: d, ease: "expo.out" }, Math.max(0, t));
    const out = (sel, t, d = 0.16) => tl.to(sel, { opacity: 0, y: -22, duration: d, ease: "power2.in" }, Math.max(0, t));
    const dim = (sel, t, o = 0.3) => tl.to(sel, { opacity: o, duration: 0.3, ease: "power2.out" }, Math.max(0, t));
    const hide = (sel, t) => tl.set(sel, { opacity: 0 }, Math.max(0, t));
${js}
    window.__timelines["${id}"] = tl;
  </script>
</template>
`);
  return `      <div id="${id}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${r3(start)}" data-duration="${r3(end - start)}" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"></div>`;
}
const hosts = [];
const L = (t, s0) => r3(t - s0);
const media = (id, file, t0, d) => file.endsWith(".mp4")
  ? `<video id="${id}" class="clip" data-start="${r3(t0)}" data-duration="${r3(d)}" data-track-index="1" src="assets/${file}" muted playsinline></video>`
  : `<img id="${id}" class="clip" data-start="${r3(t0)}" data-duration="${r3(d)}" data-track-index="1" src="assets/${file}" alt="" />`;
// a full-frame close-up that punches in on the cut and keeps pushing, with word chips
function closeup(p, k, file, t0, t1, chips, origin = "50% 50%", push = 1.1, chipTop = 800) {
  let html = `\n    <div id="${p}-w${k}" class="${p}-full" data-layout-allow-overflow>${media(`${p}-m${k}`, file, t0, t1 - t0)}</div>`;
  let js = `    tl.fromTo("#${p}-w${k}", { scale: 1.16, transformOrigin: "${origin}" }, { scale: 1.04, duration: 0.38, ease: "expo.out" }, ${r3(t0)});
    tl.to("#${p}-w${k}", { scale: ${push}, duration: ${r3(Math.max(0.2, t1 - t0 - 0.38))}, ease: "sine.inOut" }, ${r3(t0 + 0.38)});\n`;
  chips.forEach(([c0, text, col], n) => {
    const a = Math.max(t0 + 0.02, c0 - 0.06), b = n + 1 < chips.length ? chips[n + 1][0] - 0.14 : t1 - 0.1;
    html += `\n    <div id="${p}-c${k}${n}" class="${p}-chip" style="top: ${chipTop}px; background: ${CHIP[col][0]}; color: ${CHIP[col][1]}" data-layout-allow-overflow data-layout-allow-occlusion>${text}</div>`;
    js += `    tl.fromTo("#${p}-c${k}${n}", { opacity: 0, y: 46, scale: 0.94, transformOrigin: "0% 100%" }, { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: "expo.out" }, ${r3(a)});
    tl.to("#${p}-c${k}${n}", { opacity: 0, duration: 0.08 }, ${r3(b)});\n`;
  });
  return { html, js };
}

// ---- ACT 1
{
  const s0 = 0, id = "act1";
  let html = `
    <div id="act1-panel" class="act1-panel"><video id="act1-vid" class="clip" data-start="0" data-duration="${r3(mark.black)}" data-track-index="1" src="assets/night-a1.mp4" muted playsinline></video></div>`;
  let js = `    tl.fromTo("#act1-panel", { opacity: 0.4, scale: 1.05 }, { opacity: 1, scale: 1, duration: 0.7, ease: "power2.out" }, 0);\n`;
  const groups = [[0, 1, 2], [3, 4], [5], [6], [7], [8]];
  const events = [...groups.map((g) => ({ t: A("a1", g[0]).start, g })), ...quotes.map((q) => ({ t: q.t, q })), { t: mark.bus }].sort((a, b) => a.t - b.t);
  events.forEach((ev, n) => {
    const next = n + 1 < events.length ? events[n + 1].t : mark.black;
    if (ev.g) {
      const big = ev.g.length > 1;
      ev.g.forEach((i, k) => {
        const x = A("a1", i);
        const top = big ? 540 - (ev.g.length * 124) / 2 + k * 124 : 430;
        html += `\n    <div id="act1-n${i}" class="act1-t" style="left: 800px; top: ${top}px; width: 980px; font-size: ${big ? 108 : 92}px">${esc(x.text)}</div>`;
        js += `    up("#act1-n${i}", ${L(x.start, s0) - 0.06}, 44, 0.35);\n    out("#act1-n${i}", ${L(next, s0) - 0.16}, 0.13);\n`;
      });
    } else if (ev.q) {
      const q = ev.q;
      html += `\n    <div id="act1-${q.id}" class="act1-t act1-q" style="left: 800px; top: 400px; width: 960px"><div class="act1-ql">That night</div>${q.lines.map((l) => `<div>“${esc(l)}”</div>`).join("")}</div>`;
      js += `    up("#act1-${q.id}", ${L(q.t, s0) + 0.02}, 30, 0.28);\n    out("#act1-${q.id}", ${L(next, s0) - 0.14}, 0.12);\n`;
    }
  });
  js += `    hide("#act1-panel", ${L(mark.black, s0)});\n`;
  hosts.push(scene(id, 0, mark.a2, `
    .act1-panel { position: absolute; left: 150px; top: 60px; width: 540px; height: 960px; border-radius: 28px; box-shadow: 0 0 0 1px rgba(255,255,255,0.08); }
    #act1-vid { display: block; width: 540px; height: 960px; border-radius: 28px; }
    .act1-q { font-size: 76px; color: ${C.accent}; }
    .act1-ql { font-size: 28px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.orange}; margin-bottom: 18px; }`, html, js));
}

// ---- ACT 2
{
  const s0 = mark.a2, id = "act2";
  const a = (i) => A("a2", i);
  let html = `
    <div id="act2-n0" class="act2-t" style="left: 240px; top: 470px; font-size: 112px">For us, it was just a bus.</div>`;
  let js = `    up("#act2-n0", ${L(a(0).start, s0) - 0.06});\n    out("#act2-n0", ${L(a(1).start, s0) - 0.2});\n`;
  ["We speak the language.", "We can run.", "We can read the signs."].forEach((txt, k) => {
    html += `\n    <div id="act2-n${k + 1}" class="act2-t" style="left: 240px; top: ${350 + k * 122}px; font-size: 104px">${txt}</div>`;
    js += `    up("#act2-n${k + 1}", ${L(a(k + 1).start, s0) - 0.06}, 44, 0.35);\n    out("#act2-n${k + 1}", ${L(a(4).start, s0) - 0.22 + k * 0.02});\n`;
  });
  ["A country you have never seen.", "A language you can’t read.", "Two heavy bags.", "Four minutes to change."].forEach((txt, k) => {
    const i = k + 4;
    html += `\n    <div id="act2-n${i}" class="act2-t" style="left: 240px; top: ${310 + k * 112}px; font-size: 92px">${txt}</div>`;
    js += `    up("#act2-n${i}", ${L(a(i).start, s0) - 0.06}, 44, 0.35);\n`;
    if (i < 7) js += `    dim("#act2-n${i}", ${L(a(i + 1).start, s0) - 0.04});\n`;
  });
  js += `    out(["#act2-n4", "#act2-n5", "#act2-n6", "#act2-n7"], ${L(a(8).start, s0) - 0.2}, 0.14);\n`;
  html += `\n    <div id="act2-n8" class="act2-t" style="left: 240px; top: 330px; font-size: 64px; color: ${C.dim}">Then it’s not a bus.</div>`;
  js += `    up("#act2-n8", ${L(a(8).start, s0) + 0.02}, 24, 0.3);\n`;
  ["The job interview.", "The doctor.", "The first day of school."].forEach((txt, k) => {
    const i = k + 9, col = [C.accent, C.orange, C.magenta][k];
    html += `\n    <div id="act2-n${i}" class="act2-t" style="left: 240px; top: 440px; font-size: 128px; font-weight: 900; color: ${col}">${txt}</div>`;
    js += `    up("#act2-n${i}", ${L(a(i).start, s0) - 0.05}, 60, 0.32);\n    out("#act2-n${i}", ${L(i < 11 ? a(i + 1).start : mark.a3, s0) - 0.17}, 0.12);\n`;
  });
  js += `    out("#act2-n8", ${L(mark.a3, s0) - 0.2});\n`;
  hosts.push(scene(id, mark.a2, mark.a3, "", html, js));
}

// ---- ACT 3
{
  const s0 = mark.a3, id = "act3";
  const a = (i) => A("a3", i);
  const tS = L(a(1).start, s0);
  const html = `
    <div id="act3-n0" class="act3-t" style="left: 240px; top: 400px; font-size: 88px">That night, we stopped being angry,<br />and started building.</div>
    <div id="act3-dot" class="act3-dot" data-layout-allow-overflow data-layout-allow-occlusion></div>
    <div id="act3-name" class="act3-t" style="left: 0; right: 0; top: 440px; text-align: center; font-size: 176px; font-weight: 900; color: ${C.ground}">This is Santiago.</div>`;
  const js = `    up("#act3-n0", ${L(a(0).start, s0) - 0.06});
    out("#act3-n0", ${r3(tS - 0.5)});
    tl.fromTo("#act3-dot", { scale: 0 }, { scale: 1, duration: 0.5, ease: "power3.in" }, ${r3(tS - 0.52)});
    up("#act3-name", ${r3(tS - 0.04)}, 50, 0.45);\n`;
  hosts.push(scene(id, mark.a3, mark.a4, `
    .act3-dot { position: absolute; left: -340px; top: -760px; width: 2600px; height: 2600px; border-radius: 50%; background: ${C.accent}; }`, html, js));
}

// ---- ACT 4: phone beside the night (A), full-frame close-ups (B), a big phone playing the walk (C)
{
  const s0 = mark.a4, id = "act4", a = (i) => A("a4", i), l = (t) => L(t, s0);
  let html = `
    <div id="act4-panel" class="act4-panel"><video id="act4-vid" class="clip" data-start="0" data-duration="${l(t4.C)}" data-track-index="1" src="assets/night-a4.mp4" muted playsinline></video></div>
    <div id="act4-ph" class="act4-ph" style="left: 1330px; top: 98px" data-layout-allow-overflow><div class="act4-scr"><img id="act4-j" src="assets/journey.png" alt="" /></div></div>`;
  let js = `    tl.fromTo("#act4-flash", { opacity: 1 }, { opacity: 0, duration: 0.45, ease: "power2.out" }, 0);
    tl.fromTo("#act4-ph", { opacity: 0, y: 90 }, { opacity: 1, y: 0, duration: 0.7, ease: "expo.out" }, 0.1);
    tl.fromTo("#act4-panel", { opacity: 0, x: -40 }, { opacity: 0.92, x: 0, duration: 0.6, ease: "expo.out" }, 0.1);
    tl.fromTo("#act4-j", { scale: 1, transformOrigin: "0% 91%" }, { scale: 1.5, duration: 1.3, ease: "power3.inOut" }, ${r3(l(a(1).start) - 0.1)});
    hide("#act4-ph", ${l(t4.B)});
    hide("#act4-panel", ${l(t4.C)});\n`;
  // captions under the night panel, and the words in the middle
  [["Nobody knew.", t4.A, t4.A3], ["“Right spot.”", t4.A3, t4.B], ["Twenty minutes too late.", t4.C0, t4.C]].forEach(([txt, a0, a1], k) => {
    html += `\n    <div id="act4-cap${k}" class="act4-t" style="left: 150px; top: 915px; font-size: 32px; letter-spacing: -0.01em; color: ${C.dim}">${txt}</div>`;
    js += `    up("#act4-cap${k}", ${r3(l(a0) + 0.05)}, 14, 0.3);\n    hide("#act4-cap${k}", ${r3(l(a1) - 0.02)});\n`;
  });
  [[a(1).start, t4.A3, "Santiago does.", 60, C.ink, 380], [a(2).start, t4.A3, "Bay L.", 150, C.accent, 468], [a(3).start, t4.B, "The app said:<br />“right spot.”", 76, C.ink, 420], [a(7).start, t4.C, "We found out<br />too late.", 84, C.ink, 420]].forEach(([c0, c1, txt, size, col, top], k) => {
    html += `\n    <div id="act4-k${k}" class="act4-t" style="left: 620px; top: ${top}px; width: 680px; font-size: ${size}px; font-weight: ${size >= 100 ? 900 : 700}; color: ${col}">${txt}</div>`;
    js += `    up("#act4-k${k}", ${r3(l(c0) - 0.05)}, 50, 0.38);\n    hide("#act4-k${k}", ${r3(l(c1) - 0.02)});\n`;
  });
  // B: three close-ups
  const B1 = closeup(id, 1, "b1.png", l(t4.B), l(t4.B5), [[l(a(4).start), "The exact one.", "yellow"]], "35% 55%", 1.12);
  const B2 = closeup(id, 2, "b2.png", l(t4.B5), l(t4.B6), [[l(a(5).start), "Which bay.", "magenta"]], "30% 45%", 1.14);
  const B3 = closeup(id, 3, "b3.png", l(t4.B6), l(t4.C0), [[l(a(6).start), "Which side of the road.", "yellow"]], "60% 40%", 1.14);
  html += B1.html + B2.html + B3.html; js += B1.js + B2.js + B3.js;
  // C: the phone in the middle, playing the recording, words on both sides
  html += `
    <div id="act4-phc" class="act4-iph" style="left: 751px; top: 126px" data-layout-allow-overflow>${media("act4-vc", "phC.mp4", l(t4.C), t4.end - t4.C)}</div>
    <div id="act4-x0" class="act4-t" style="left: 70px; top: 440px; width: 590px; text-align: right; font-size: 86px; font-weight: 900; color: ${C.accent}">When<br />to leave.</div>
    <div id="act4-x1" class="act4-t" style="left: 1260px; top: 440px; width: 620px; font-size: 86px; font-weight: 900">Every turn<br />of the walk.</div>
    <div id="act4-flash" class="act4-flash" data-layout-allow-occlusion></div>`;
  js += `    tl.fromTo("#act4-phc", { opacity: 0, y: 120, scale: 1.0, transformOrigin: "50% 50%" }, { opacity: 1, y: 0, scale: 1.14, duration: 0.6, ease: "expo.out" }, ${l(t4.C)});
    up("#act4-x0", ${r3(l(a(8).start) + 0.25)}, 50, 0.4);
    up("#act4-x1", ${r3(l(t4.turn) + 0.15)}, 50, 0.4);
    out(["#act4-x0", "#act4-x1"], ${r3(l(t4.end) - 0.18)}, 0.14);
    tl.to("#act4-phc", { opacity: 0, y: -60, duration: 0.16, ease: "power2.in" }, ${r3(l(t4.end) - 0.18)});\n`;
  hosts.push(scene(id, mark.a4, mark.a5, `
    .act4-panel { position: absolute; left: 150px; top: 190px; width: 394px; height: 700px; border-radius: 24px; box-shadow: 0 0 0 1px rgba(255,255,255,0.08); }
    #act4-vid { display: block; width: 394px; height: 700px; border-radius: 24px; }
    .act4-flash { position: absolute; inset: 0; background: ${C.accent}; }`, html, js));
}

// ---- ACT 5: dark-mode click in a phone (D), close-up (E), phone on the left (F), split screen (G),
//      map close-up (H), collage (I), close-up (J), phone with a list of steps (K), then the type
{
  const s0 = mark.a5, id = "act5", a = (i) => A("a5", i), l = (t) => L(t, s0);
  let html = "", js = "";
  // D — the click that turns the app dark, while the voice carries on
  const fl = l(flip);
  html += `
    <div id="act5-n0" class="act5-t" style="left: 200px; top: 400px; font-size: 96px">And it goes further<br />than our problem.</div>
    <div id="act5-n1" class="act5-t" style="left: 200px; top: 400px; font-size: 150px; font-weight: 900; color: ${C.accent}">It adapts<br />to you.</div>
    <div id="act5-phd" class="act5-iph" style="left: 1330px; top: 126px" data-layout-allow-overflow>${media("act5-vd", "phD.mp4", 0, dD)}
      <div id="act5-ring" class="act5-ring"></div>
      <svg id="act5-cur" class="act5-cur" viewBox="0 0 24 24"><path d="M4 2 L4 20 L9 15.5 L12.2 22.5 L15 21.2 L11.8 14.4 L18.5 14.2 Z" fill="#ffffff" stroke="#0b0c0f" stroke-width="1.6" stroke-linejoin="round" /></svg>
    </div>`;
  js += `    tl.fromTo("#act5-phd", { opacity: 0, y: 90, scale: 1, transformOrigin: "52% 14%" }, { opacity: 1, y: 0, duration: 0.6, ease: "expo.out" }, 0.05);
    up("#act5-n0", ${r3(l(a(0).start) - 0.06)});
    out("#act5-n0", ${r3(l(a(1).start) - 0.22)});
    up("#act5-n1", ${r3(l(a(1).start) - 0.05)}, 60, 0.4);
    tl.fromTo("#act5-cur", { opacity: 0, x: 300, y: 560 }, { opacity: 1, duration: 0.2 }, 0.25);
    tl.to("#act5-cur", { x: 205, y: 100, duration: ${r3(Math.max(0.5, fl - 0.5))}, ease: "power2.inOut" }, 0.35);
    tl.to("#act5-phd", { scale: 1.12, duration: 0.7, ease: "power2.inOut" }, ${r3(fl - 0.75)});
    tl.to("#act5-cur", { scale: 0.78, duration: 0.08, ease: "power2.in" }, ${r3(fl - 0.13)});
    tl.to("#act5-cur", { scale: 1, duration: 0.18, ease: "power2.out" }, ${r3(fl - 0.03)});
    tl.fromTo("#act5-ring", { opacity: 0.95, scale: 0.35 }, { opacity: 0, scale: 2.1, duration: 0.55, ease: "power2.out", immediateRender: false }, ${r3(fl - 0.1)});
    tl.to("#act5-cur", { opacity: 0, x: 250, y: 190, duration: 0.5, ease: "power2.inOut" }, ${r3(fl + 0.35)});
    hide(["#act5-phd", "#act5-n1"], ${l(t5.E)});\n`;
  // E — close-up of the switches
  const E = closeup(id, "E", "mE.mp4", l(t5.E), l(t5.F), [[l(a(2).start), "Can’t take stairs?", "navy"], [l(a(3).start), "Switch them off.", "yellow"]], "78% 50%", 1.22);
  html += E.html; js += E.js;
  // F — phone on the left, the slider in it, words on the right
  html += `
    <div id="act5-phf" class="act5-iph" style="left: 190px; top: 126px" data-layout-allow-overflow>${media("act5-vf", "phF.mp4", l(t5.F), t5.G - t5.F)}</div>
    <div id="act5-f0" class="act5-t" style="left: 760px; top: 330px; font-size: 92px">Need more time?</div>
    <div id="act5-f1" class="act5-t" style="left: 760px; top: 460px; font-size: 150px; font-weight: 900; color: ${C.accent}">Slow the pace.</div>`;
  js += `    tl.fromTo("#act5-phf", { opacity: 0, x: -80, scale: 1.08, transformOrigin: "50% 45%" }, { opacity: 1, x: 0, duration: 0.5, ease: "expo.out" }, ${l(t5.F)});
    tl.to("#act5-phf", { scale: 1.18, duration: ${r3(t5.G - t5.F - 0.5)}, ease: "sine.inOut" }, ${r3(l(t5.F) + 0.5)});
    up("#act5-f0", ${r3(l(a(4).start) - 0.05)});
    up("#act5-f1", ${r3(l(a(5).start) - 0.05)}, 60, 0.4);
    hide(["#act5-phf", "#act5-f0", "#act5-f1"], ${l(t5.G)});\n`;
  // G — split screen: the recording fills the left half
  html += `
    <div id="act5-g" class="act5-half" data-layout-allow-overflow>${media("act5-vg", "gG.mp4", l(t5.G), t5.H - t5.G)}</div>
    <div id="act5-g0" class="act5-t" style="left: 1050px; top: 340px; font-size: 120px">New here?</div>
    <div id="act5-g1" class="act5-t" style="left: 1050px; top: 480px; font-size: 132px; font-weight: 900; color: ${C.accent}">Tell it once.</div>`;
  js += `    tl.fromTo("#act5-g", { x: -960 }, { x: 0, duration: 0.45, ease: "expo.out" }, ${l(t5.G)});
    up("#act5-g0", ${r3(l(a(6).start) - 0.05)});
    up("#act5-g1", ${r3(l(a(7).start) - 0.05)}, 60, 0.4);
    hide(["#act5-g0", "#act5-g1"], ${l(t5.H)});\n`;
  // H — the map fills up, full frame
  const H = closeup(id, "H", "mH.mp4", l(t5.H), l(t5.I), [[l(a(8).start), "Everything you need.", "navy"]], "50% 50%", 1.1);
  html += H.html; js += H.js;
  // I — collage: rows of the app slide in, then the place card
  html += `
    <div id="act5-i0" class="act5-t" style="left: 150px; top: 196px; font-size: 34px; letter-spacing: 0.12em; text-transform: uppercase; color: ${C.dim}">On your map</div>`;
  [["i1", 9], ["i2", 10], ["i3", 11]].forEach(([f, i], k) => {
    html += `\n    <img id="act5-${f}" class="act5-row" style="top: ${270 + k * 165}px" src="assets/${f}.png" alt="" />`;
    js += `    tl.fromTo("#act5-${f}", { opacity: 0, x: -120 }, { opacity: 1, x: 0, duration: 0.4, ease: "expo.out" }, ${r3(l(a(i).start) - 0.06)});\n`;
  });
  html += `\n    <img id="act5-i4" class="act5-card" src="assets/i4.png" alt="" />`;
  js += `    up("#act5-i0", ${r3(l(t5.I) + 0.05)}, 20, 0.3);
    tl.fromTo("#act5-i4", { opacity: 0, y: 120, rotation: 4, scale: 0.92 }, { opacity: 1, y: 0, rotation: -2, scale: 1, duration: 0.5, ease: "expo.out" }, ${r3(l(a(11).start) - 0.05)});
    hide(["#act5-i0", "#act5-i1", "#act5-i2", "#act5-i3", "#act5-i4"], ${l(t5.J)});\n`;
  // J — close-up of the event filters
  const J = closeup(id, "J", "mJ.mp4", l(t5.J), l(t5.K), [[l(a(12).start), "Free food.", "orange"], [l(a(13).start), "Women’s groups.", "magenta"]], "78% 50%", 1.22);
  html += J.html; js += J.js;
  // K — the event walkthrough in a phone, with the steps listed beside it
  html += `
    <div id="act5-phk" class="act5-iph" style="left: 1180px; top: 126px" data-layout-allow-overflow>${media("act5-vk", "phK.mp4", l(t5.K), t5.L - t5.K)}</div>`;
  js += `    tl.fromTo("#act5-phk", { opacity: 0, y: 110, scale: 1.1, transformOrigin: "50% 50%" }, { opacity: 1, y: 0, duration: 0.55, ease: "expo.out" }, ${l(t5.K)});\n`;
  [["A language café<br />near you.", 14, 250, C.ink], ["Tap it.", 15, 450, C.ink], ["See what it is,<br />and who runs it.", 16, 550, C.ink], ["It takes you there.", 17, 750, C.accent]].forEach(([txt, i, top, col], k, all) => {
    html += `\n    <div id="act5-s${k}" class="act5-t" style="left: 190px; top: ${top}px; font-size: 76px; color: ${col}">${txt}</div>`;
    js += `    up("#act5-s${k}", ${r3(l(a(i).start) - 0.05)}, 40, 0.36);\n`;
    if (k + 1 < all.length) js += `    dim("#act5-s${k}", ${r3(l(a(all[k + 1][1]).start) - 0.04)}, 0.32);\n`;
  });
  js += `    hide(["#act5-phk", "#act5-s0", "#act5-s1", "#act5-s2", "#act5-s3"], ${l(t5.L)});\n`;
  // L — the ticket button, close up, with a tap on it
  const Lc = closeup(id, "L", "tk.png", l(t5.L), l(t5.end), [[l(a(18).start), "Your ticket. One tap.", "yellow"]], "59% 82%", 1.22, 110);
  const tap = r3(l(a(18).start) + 0.9);
  html += Lc.html + `\n    <div id="act5-tap" class="act5-tap"></div>`;
  // immediateRender: false keeps the ring invisible until its moment (otherwise it sits on screen for the whole act)
  js += Lc.js + `    tl.fromTo("#act5-tap", { opacity: 0.95, scale: 0.35 }, { opacity: 0, scale: 2.2, duration: 0.6, ease: "power2.out", immediateRender: false }, ${tap});\n`;
  // the line that closes the act
  const t18 = l(a(19).start), t19 = l(a(20).start);
  html += `
    <div id="act5-n18" class="act5-t" style="left: 0; right: 0; top: 330px; text-align: center; font-size: 84px">So you don’t just arrive.</div>
    <div id="act5-n19" class="act5-t" style="left: 0; right: 0; top: 460px; text-align: center; font-size: 230px; font-weight: 900; color: ${C.accent}">You belong.</div>`;
  js += `    up("#act5-n18", ${r3(t18 - 0.05)});
    up("#act5-n19", ${r3(t19 - 0.05)}, 80, 0.45);
    out(["#act5-n18", "#act5-n19"], ${r3(l(mark.a6) - 0.2)});\n`;
  hosts.push(scene(id, mark.a5, mark.a6, `
    .act5-ring { position: absolute; left: ${9 + 205 - 34}px; top: ${9 + 98 - 34}px; width: 68px; height: 68px; border-radius: 50%; border: 5px solid ${C.accent}; opacity: 0; }
    .act5-cur { position: absolute; left: 9px; top: 9px; width: 46px; height: 46px; overflow: visible; opacity: 0; }
    .act5-tap { position: absolute; left: 1053px; top: 807px; width: 160px; height: 160px; border-radius: 50%; border: 10px solid ${C.accent}; opacity: 0; }
    .act5-half { position: absolute; left: 0; top: 0; width: 960px; height: 1080px; overflow: hidden; }
    .act5-half video { position: absolute; left: 0; top: 0; width: 960px; height: 1080px; display: block; }
    .act5-row { position: absolute; left: 150px; width: 960px; height: 135px; border-radius: 26px; box-shadow: 0 16px 50px rgba(0,0,0,0.5); opacity: 0; }
    .act5-card { position: absolute; left: 1180px; top: 250px; width: 600px; height: 570px; border-radius: 34px; box-shadow: 0 30px 90px rgba(0,0,0,0.6); opacity: 0; }`, html, js));
}

// ---- ACT 6: the return, then the logo with its dots spinning into place
{
  const s0 = mark.a6, id = "act6", a = (i) => A("a6", i), l = (t) => L(t, s0);
  const t3 = l(cut("a6", 3)), t6 = l(logoAt), t7 = l(a(7).start);
  // logo geometry: the wordmark is shown at 1100 px wide (0.846 of the source); the ring of dots sits above the "i"
  const LX = 180, LY = 300, K = 1100 / 1300, RX = r3(LX + 707 * K), RY = r3(LY + 88 * K), RR = r3(42 * K);
  const dots = [[-150, C.navy], [-90, C.magenta], [-30, C.navy], [30, C.accent], [90, C.orange], [150, C.magenta]];
  let html = `
    <div id="act6-panel" class="act6-panel"><video id="act6-vid" class="clip" data-start="0" data-duration="${r3(t3)}" data-track-index="1" src="assets/night-a6.mp4" muted playsinline></video></div>
    <div id="act6-todo" class="act6-todo"><div class="act6-todo1">Shot to film</div><div class="act6-todo2">Bay L · bus 10 arriving<br />phone in hand</div></div>`;
  let js = `    tl.fromTo("#act6-panel", { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "power2.out" }, 0);
    hide("#act6-panel", ${r3(t3)});
    tl.fromTo("#act6-todo", { opacity: 0 }, { opacity: 1, duration: 0.3 }, ${r3(t3)});
    tl.to("#act6-todo", { opacity: 0, duration: 0.2 }, ${r3(t6 - 0.2)});\n`;
  ["Friday night.", "Bern station.", "Rain."].forEach((txt, k) => {
    html += `\n    <div id="act6-n${k}" class="act6-t" style="left: 800px; top: ${354 + k * 124}px; font-size: 108px">${txt}</div>`;
    js += `    up("#act6-n${k}", ${l(a(k).start) - 0.06}, 44, 0.35);\n    out("#act6-n${k}", ${r3(t3 - 0.2 + k * 0.02)}, 0.13);\n`;
  });
  html += `
    <div id="act6-ph" class="act6-ph" style="left: 1330px; top: 98px" data-layout-allow-overflow><div class="act6-scr"><img id="act6-j" src="assets/journey.png" alt="" /></div></div>`;
  js += `    tl.fromTo("#act6-ph", { opacity: 0, y: 90 }, { opacity: 1, y: 0, duration: 0.6, ease: "expo.out" }, ${r3(t3 - 0.05)});
    tl.fromTo("#act6-j", { scale: 1, transformOrigin: "0% 91%" }, { scale: 1.5, duration: 1.2, ease: "power3.inOut" }, ${r3(t3 + 0.15)});
    tl.to("#act6-ph", { opacity: 0, y: 60, duration: 0.2, ease: "power2.in" }, ${r3(t6 - 0.22)});\n`;
  [["Bus 10.", C.ink, 112], ["Bay L.", C.accent, 112], ["Fifty metres<br />away.", C.ink, 84]].forEach(([txt, col, size], k) => {
    html += `\n    <div id="act6-k${k}" class="act6-t" style="left: 760px; top: ${300 + k * 140}px; font-size: ${size}px; font-weight: 900; color: ${col}">${txt}</div>`;
    js += `    up("#act6-k${k}", ${l(a(3 + k).start) - 0.05}, 50, 0.38);\n    out("#act6-k${k}", ${r3(t6 - 0.24 + k * 0.02)}, 0.14);\n`;
  });
  html += `
    <img id="act6-word" class="act6-word" src="assets/wordmark.png" alt="Santiago" />
    <div id="act6-ring" class="act6-ring">${dots.map(([ang, col], k) => `<div class="act6-arm" style="transform: rotate(${ang}deg)"><i id="act6-d${k}" style="background: ${col}"></i></div>`).join("")}</div>
    <div id="act6-line" class="act6-t" style="left: 196px; top: 660px; font-size: 64px; color: ${C.accent}">Know exactly where to stand.</div>
    <div id="act6-team" class="act6-t" style="left: 198px; top: 770px; font-size: 30px; font-weight: 400; letter-spacing: -0.01em; color: ${C.dim}">Team Santiago de Claude · AI for Access Hackathon 2026</div>
    <div id="act6-qr" class="act6-qr"><img src="assets/qr.png" alt="" /><div>${LIVE}</div></div>`;
  // the dots fly in on a wide orbit, spin twice while the orbit closes, land with a pop, then keep turning slowly
  js += `    tl.fromTo("#act6-word", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.6, ease: "expo.out" }, ${r3(t6 + 0.08)});
    tl.fromTo("#act6-ring", { rotation: -760 }, { rotation: 0, duration: 1.35, ease: "power3.out" }, ${r3(t6)});
    tl.to("#act6-ring", { rotation: 360, duration: ${r3(Math.max(1, l(END) - t6 - 1.35))}, ease: "sine.inOut" }, ${r3(t6 + 1.35)});
    ${JSON.stringify(dots.map((_, k) => k))}.forEach((k) => {
      tl.fromTo("#act6-d" + k, { opacity: 0, x: 620 + k * 60, scale: 2.4 }, { opacity: 1, x: ${RR}, scale: 1, duration: 1.3, ease: "expo.out" }, ${r3(t6)} + k * 0.03);
      tl.fromTo("#act6-d" + k, { scale: 1 }, { scale: 1.7, duration: 0.12, ease: "power2.out" }, ${r3(t6 + 1.33)} + k * 0.02);
      tl.to("#act6-d" + k, { scale: 1, duration: 0.35, ease: "back.out(3)" }, ${r3(t6 + 1.45)} + k * 0.02);
    });
    up("#act6-line", ${r3(Math.max(t7 - 0.05, t6 + 0.5))}, 30, 0.5);
    up("#act6-team", ${r3(t7 + 1.2)}, 16, 0.6);
    tl.fromTo("#act6-qr", { opacity: 0, scale: 0.92 }, { opacity: 1, scale: 1, duration: 0.6, ease: "expo.out" }, ${r3(t7 + 0.4)});\n`;
  hosts.push(scene(id, mark.a6, END, `
    .act6-panel { position: absolute; left: 150px; top: 60px; width: 540px; height: 960px; border-radius: 28px; }
    #act6-vid { display: block; width: 540px; height: 960px; border-radius: 28px; }
    .act6-todo { position: absolute; left: 150px; top: 60px; width: 540px; height: 960px; border-radius: 28px; border: 3px dashed #4a4c53; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: Inter, sans-serif; text-align: center; }
    .act6-todo1 { font-size: 26px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.accent}; }
    .act6-todo2 { font-size: 34px; font-weight: 700; color: ${C.dim}; margin-top: 18px; line-height: 1.25; }
    .act6-word { position: absolute; left: ${LX}px; top: ${LY}px; width: 1100px; height: ${r3(400 * K)}px; opacity: 0; }
    .act6-ring { position: absolute; left: ${RX}px; top: ${RY}px; width: 0; height: 0; }
    .act6-arm { position: absolute; left: 0; top: 0; width: 0; height: 0; }
    .act6-arm i { position: absolute; left: -10px; top: -10px; width: 20px; height: 20px; border-radius: 50%; display: block; opacity: 0; }
    .act6-qr { position: absolute; left: 1420px; top: 330px; width: 340px; padding: 24px 24px 18px; border-radius: 32px; background: #fff; font-family: Inter, sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0; color: ${C.navy}; text-align: center; opacity: 0; }
    .act6-qr img { display: block; width: 292px; height: 292px; margin-bottom: 12px; }`, html, js));
}

fs.writeFileSync(path.join(P, "index.html"), `<!doctype html>
<html lang="en" data-resolution="landscape">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: ${C.ground}; }
      #root { position: relative; width: 1920px; height: 1080px; font-family: Inter, sans-serif; color: ${C.ink}; }
      #ground { position: absolute; inset: 0; background: ${C.ground}; }
    </style>
  </head>
  <body>
    <!-- Generated by build/build3.mjs from the narration timings. Edit the script, not this file. -->
    <div id="root" data-composition-id="main" data-start="0" data-duration="${END}" data-width="1920" data-height="1080">
      <div id="ground"></div>
${hosts.join("\n")}
      <audio id="soundtrack" class="clip" data-start="0" data-duration="${END}" data-track-index="2" data-volume="1" src="assets/soundtrack.wav"></audio>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`);
console.log("scenes written. total", END, "s; dark-mode flip at", flip, "; logo at", logoAt);
