// One-off: turns a copy of build3.mjs into build4.mjs (run once, 2026-11-21 16:35). Kept as a record of what changed.
const fs = require("fs");
const path = require("path");
const here = __dirname;
let s = fs.readFileSync(path.join(here, "build3.mjs"), "utf8");
const rep = (a, b) => { if (!s.includes(a)) throw new Error("missing: " + a.slice(0, 70)); s = s.replace(a, b); };
// header
rep(`// Pitch video, version 3: the first video's look`, `// Pitch video, version 4: version 3 with the features part rebuilt on the app as it is at 16:00 (footage from
// capture/capture4.mjs and shots4.mjs: introduction with the 3D walk, language, adaptive walking speed, search,
// choice of journeys, live vehicles, ticket with its fare). Acts 1, 2, 3, 4 and 6 keep version 3's narration.
// Before that, version 3: the first video's look`);
rep(`// Usage: node build3.mjs [--no-media]`, `// Usage: node build4.mjs [--no-media]`);
rep(`const VO = path.join(ROOT, "voice", "out-v4", "jon");`, `const VO = path.join(ROOT, "voice", "out-v4", "jon");
const VO5 = path.join(ROOT, "voice", "out-v5", "jon"); // the features act, re-recorded for version 4
const voDir = (k) => (k === "a5" ? VO5 : VO);
const CAP = path.join(ROOT, "capture", "v4");
const V = (n) => path.join(CAP, n + ".mp4");`);
rep(`const P = path.join(ROOT, "pitch-v3");`, `const P = path.join(ROOT, "pitch-v4");`);
rep(`const WORK = path.join(B, "work3");`, `const WORK = path.join(B, "work4");`);
rep(`JSON.parse(fs.readFileSync(path.join(VO, file + ".json"), "utf8")).words;`, `JSON.parse(fs.readFileSync(path.join(voDir(k), file + ".json"), "utf8")).words;`);
rep(`x.file = path.join(VO, file + ".mp3");`, `x.file = path.join(voDir(k), file + ".mp3");`);
// timeline act 5
const a = s.indexOf(`S("a5", 0, 0.2); S("a5", 1, 0.35);`), b = s.indexOf(`mark.belong = r3(T);`);
if (a < 0 || b < 0) throw new Error("timeline anchors");
s = s.slice(0, a) + `S("a5", 0, 0.2); S("a5", 1, 0.35);   // D  it adapts to you
say1("a5", 2, 4, 0.14, 0.3);            // E  language
say1("a5", 5, 6, 0.14, 0.28);           // F  stairs
say1("a5", 7, 8, 0.16, 0.3);            // G  walking pace
say1("a5", 9, 10, 0.2, 0.25);           // H  search, choice of journeys
S("a5", 11, 0.3);                       // I  live vehicles
say1("a5", 12, 13, 0.16, 0.3);          // J  3D walk
S("a5", 14, 0.22);                      // K  the map fills
say1("a5", 15, 17, 0.18, 0.28);         // L  toilets, water, food
say1("a5", 18, 19, 0.2, 0.3);           // M  the language café
say1("a5", 20, 22, 0.18, 0.5);          // N  the ticket
` + s.slice(b);
rep(`say1("a5", 19, 20, 0.24, 0.6);`, `say1("a5", 23, 24, 0.24, 0.6);`);
rep(`const t5 = { D: 0, E: cut("a5", 2), F: cut("a5", 4), G: cut("a5", 6), H: cut("a5", 8), I: cut("a5", 9), J: cut("a5", 12), K: cut("a5", 14), L: cut("a5", 18), end: mark.belong };`,
    `const t5 = { D: 0, E: cut("a5", 2), F: cut("a5", 5), G: cut("a5", 7), H: cut("a5", 9), I: cut("a5", 11), J: cut("a5", 12), K: cut("a5", 14), L: cut("a5", 15), M: cut("a5", 18), N: cut("a5", 20), end: mark.belong };`);
// media
rep(`const dK = [A("a5", 15).start - 0.08 - t5.K, A("a5", 16).start - A("a5", 15).start, A("a5", 17).start - A("a5", 16).start, t5.L - A("a5", 17).start + 0.08];`, ``);
rep(`  fs.copyFileSync(path.join(SHOTS, "ticket.png"), path.join(ASSETS, "journey.png"));
  still("tk", path.join(SHOTS, "ticket.png"), null, X(0, 2026, 900), 1920, 1080);
  still("b1", REC(4), 24.2, X(0, 1240, 1206), 1920, 1080);
  still("b2", REC(4), 24.2, X(40, 1300, 800), 1920, 1080);
  still("b3", REC(4), 24.2, X(300, 1390, 870), 1920, 1080);`, `  // the journey sheet and its step list as the app shows them now (shots4.mjs, 1170x2532)
  fs.copyFileSync(path.join(CAP, "journey4.png"), path.join(ASSETS, "journey.png"));
  still("tk", path.join(CAP, "journey4.png"), null, X(0, 1872, 1170), 1920, 1080);
  still("b1", path.join(CAP, "steps4.png"), null, X(0, 1560, 1170), 1920, 1080);
  still("b2", path.join(CAP, "steps4.png"), null, X(180, 1635, 750), 1920, 1080);
  still("b3", path.join(CAP, "steps4.png"), null, X(450, 1680, 720), 1920, 1080);`);
const m0 = s.indexOf(`  clip("mE", REC(1)`), m1 = s.indexOf(`  // logo: white wordmark`);
if (m0 < 0 || m1 < 0) throw new Error("media anchors");
s = s.slice(0, m0) + `  // E language (lang.mp4: list glides 4.3-6.9, tap on Ukrainian 8.0, translated settings from 9.0)
  const dE = t5.F - t5.E, eScroll = dE * 0.4;
  clip("phE", V("lang"), [{ t0: 4.3, dur: eScroll, speed: 2.6 / eScroll }, { t0: 7.75, dur: dE - eScroll }], 780, 1688);
  // F access switch (questions.mp4: the tap on the stairs switch is at 7.70)
  clip("mF", V("questions"), [{ t0: Math.max(6.35, 7.7 - (A("a5", 6).start - t5.F) - 0.05), dur: t5.G - t5.F }], 1920, 1080, X(0, 510, 780));
  // G walking speed (questions.mp4: tap on Relaxed 2.24, on "Adjust to how I walk" 3.70)
  clip("gG", V("questions"), [{ t0: 1.95, dur: A("a5", 8).start - t5.G }, { t0: 3.45, dur: t5.H - A("a5", 8).start }], 960, 1080, [0, 500, 780, 878]);
  // H search and the list of journeys (journey.mp4: typing 0.4-2.0, results until 3.8, journeys 4.05, tap on one 7.44)
  const h1 = A("a5", 10).start - t5.H;
  clip("phH", V("journey"), [{ t0: 0.9, dur: h1, speed: 2.5 / h1 }, { t0: 6.3, dur: t5.I - A("a5", 10).start, speed: 1.4 }], 780, 1688);
  // I live vehicles around Bern station, four times as fast so the dots are seen moving
  clip("mI", V("live"), [{ t0: 13, dur: t5.J - t5.I, speed: 4 }], 1920, 1080, X(0, 660, 780));
  // J the introduction's first-person 3D walk across Hirschengraben (intro.mp4: the walk runs 1.6-24.4)
  clip("phJ", V("intro"), [{ t0: 3, dur: t5.K - t5.J, speed: 3.5 }], 780, 1688);
  clip("mK", REC(4), [{ t0: 11.7, dur: t5.L - t5.K, speed: 1.7 }], 1920, 1080, X(0, 700, 1206));
  still("i1", REC(1), 23.5, [0, 272, 1206, 170], 960, 135);
  still("i2", REC(1), 23.5, [0, 428, 1206, 170], 960, 135);
  clip("i3v", REC(1), [{ t0: 30.2, dur: t5.M - A("a5", 17).start + 0.15 }], 960, 135, [0, 1211, 1206, 170]);
  // M the event walkthrough: the map with event cards, a tap on the language café, then its journey
  const m0d = A("a5", 19).start - t5.M;
  clip("phM", REC(3), [{ t0: 0.2, dur: m0d * 0.55 }, { t0: 2.9, dur: m0d * 0.45 }, { t0: 13.6, dur: t5.N - A("a5", 19).start }], 800, 1620);
` + s.slice(m1);
// sound
rep(`[t4.B, t4.B5, t4.B6, t4.C0, t4.C, t5.D, t5.E, t5.F, t5.G, t5.H, t5.I, t5.J, t5.K, t5.L].forEach`, `[t4.B, t4.B5, t4.B6, t4.C0, t4.C, t5.D, t5.E, t5.F, t5.G, t5.H, t5.I, t5.J, t5.K, t5.L, t5.M, t5.N].forEach`);
rep(`fx("tick", A("a5", 18).start + 0.85, 1.0); // the tap on Get ticket`, `fx("tick", A("a5", 21).start + 0.1, 1.0); // the tap on Ticket`);
rep(`[["a4", 1], ["a5", 3], ["a5", 5], ["a5", 7], ["a5", 9], ["a5", 10], ["a5", 11], ["a5", 13], ["a5", 15], ["a5", 16], ["a5", 17]]`, `[["a4", 1], ["a5", 3], ["a5", 4], ["a5", 6], ["a5", 8], ["a5", 10], ["a5", 13], ["a5", 15], ["a5", 16], ["a5", 17], ["a5", 19], ["a5", 22]]`);
rep(`fx("hit", A("a5", 20).start - 0.03, 0.9);`, `fx("hit", A("a5", 24).start - 0.03, 0.9);`);
// phone frame for the 390x844 captures
rep("    .${p}-full { position: absolute;", "    .${p}-cph { position: absolute; width: 418px; height: 884px; padding: 9px; border-radius: 54px; background: #1b1c21; box-shadow: 0 0 0 1px rgba(255,255,255,0.12), 0 40px 120px rgba(0,0,0,0.6); }\n    .${p}-cph video { display: block; width: 400px; height: 866px; border-radius: 45px; }\n    .${p}-full { position: absolute;");
// act 5 scenes
const s5 = s.indexOf(`// ---- ACT 5:`), s6 = s.indexOf(`// ---- ACT 6:`);
if (s5 < 0 || s6 < 0) throw new Error("scene anchors");
s = s.slice(0, s5) + fs.readFileSync(path.join(here, "act5.part"), "utf8") + s.slice(s6);
// act 4 close-ups: the new crops are centred on their subject
rep(`"yellow"]], "35% 55%", 1.12);`, `"yellow"]], "50% 45%", 1.1);`);
rep(`"magenta"]], "30% 45%", 1.14);`, `"magenta"]], "45% 40%", 1.14);`);
rep(`"yellow"]], "60% 40%", 1.14);`, `"yellow"]], "55% 40%", 1.12);`);
// act 6: no placeholder box; the words move to the left
rep(`
    <div id="act6-todo" class="act6-todo"><div class="act6-todo1">Shot to film</div><div class="act6-todo2">Bay L · bus 10 arriving<br />phone in hand</div></div>`, ``);
rep("    tl.fromTo(\"#act6-todo\", { opacity: 0 }, { opacity: 1, duration: 0.3 }, ${r3(t3)});\n    tl.to(\"#act6-todo\", { opacity: 0, duration: 0.2 }, ${r3(t6 - 0.2)});\\n`;", "\\n`;");
rep("class=\"act6-t\" style=\"left: 760px; top: ${300 + k * 140}px; font-size: ${size}px;", "class=\"act6-t\" style=\"left: 240px; top: ${290 + k * 160}px; font-size: ${Math.round(size * 1.2)}px;");
rep(`Generated by build/build3.mjs`, `Generated by build/build4.mjs`);
fs.writeFileSync(path.join(here, "build4.mjs"), s);
console.log("build4.mjs written");
