// Frames of the rendered film at the feature beats, tiled into sheets (capture/v4/chk/sheet-*.jpg).
// Usage: node check4.cjs [video]
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const root = path.dirname(__dirname);
const video = process.argv[2] || path.join(root, "pitch-v4", "renders", "pitch-v4.mp4");
const out = path.join(__dirname, "v4", "chk");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const t = JSON.parse(fs.readFileSync(path.join(root, "build", "work4", "timeline.json"), "utf8"));
const k = t.t5, ks = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "end"];
const a5 = [];
for (let i = 0; i < ks.length - 1; i++) { const a = k[ks[i]], b = k[ks[i + 1]]; a5.push([ks[i] + " mid", a + (b - a) * 0.45], [ks[i] + " late", a + (b - a) * 0.9]); }
const k4 = t.t4;
const a4 = [["A", k4.A + 1.5], ["A bay", k4.A + 3.6], ["A3", k4.A3 + 0.9], ["B", k4.B + 0.9], ["B5", k4.B5 + 0.7], ["B6", k4.B6 + 0.9], ["C0", k4.C0 + 0.9], ["C", k4.C + 1], ["turn", k4.turn + 1.3],
  ["belong", t.mark.belong + 2.2], ["a6", t.mark.a6 + 1.5], ["a6 phone", t.mark.a6 + 5.5], ["logo", t.logoAt + 1.0], ["logo end", t.logoAt + 4.5], ["a1", 3], ["a2", 30]];
const sheets = { a5a: a5.slice(0, 12), a5b: a5.slice(12), a4: a4 };
for (const [name, list] of Object.entries(sheets)) {
  list.forEach(([label, time], i) => {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", time.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=640:-1", path.join(out, `${name}-${String(i).padStart(2, "0")}.jpg`)]);
  });
  const rows = Math.ceil(list.length / 3);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", path.join(out, `${name}-%02d.jpg`), "-vf", `tile=3x${rows}:padding=4`, "-frames:v", "1", path.join(out, `sheet-${name}.jpg`)]);
  console.log(name + ":", list.map(([l, x]) => `${l}@${x.toFixed(1)}`).join("  "));
}
