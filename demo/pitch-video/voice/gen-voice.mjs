// Generate one voice clip per scene with ElevenLabs, plus word timings.
// Usage: EL_KEY_FILE=<path> node gen-voice.mjs <voiceName> [sceneId ...]
import fs from "node:fs";
import path from "node:path";

const key = fs.readFileSync(process.env.EL_KEY_FILE, "utf8").trim();
const script = JSON.parse(fs.readFileSync(new URL(process.env.EL_SCRIPT || "./script.json", import.meta.url), "utf8"));
const voiceName = process.argv[2] || "alice";
const only = process.argv.slice(3);
const voiceId = script.voices[voiceName];
if (!voiceId) throw new Error("unknown voice " + voiceName);
const model = process.env.EL_MODEL || script.model;
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), process.env.EL_OUT || "out", voiceName);
fs.mkdirSync(outDir, { recursive: true });

// Group character timings into words.
function toWords(al) {
  const words = [];
  let cur = null;
  al.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null; } return; }
    if (!cur) cur = { text: "", start: al.character_start_times_seconds[i], end: 0 };
    cur.text += ch;
    cur.end = al.character_end_times_seconds[i];
  });
  if (cur) words.push(cur);
  return words.map((w) => ({ text: w.text, start: +w.start.toFixed(3), end: +w.end.toFixed(3) }));
}

for (const scene of script.scenes) {
  if (only.length && !only.includes(scene.id)) continue;
  const t0 = Date.now();
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_192`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text: scene.text, model_id: model, ...(script.voice_settings || scene.voice_settings ? { voice_settings: { ...script.voice_settings, ...(scene.voice_settings || {}) } } : {}) }), // no voice_settings = the voice's defaults
    },
  );
  if (!res.ok) { console.log(scene.id, "FAILED", res.status, (await res.text()).slice(0, 400)); continue; }
  const j = await res.json();
  fs.writeFileSync(path.join(outDir, scene.id + ".mp3"), Buffer.from(j.audio_base64, "base64"));
  const al = j.alignment || j.normalized_alignment;
  const words = al ? toWords(al) : [];
  fs.writeFileSync(path.join(outDir, scene.id + ".json"), JSON.stringify({ text: scene.text, model, voice: voiceName, words }, null, 1));
  const end = words.length ? words[words.length - 1].end : null;
  console.log(`${scene.id} ok in ${((Date.now() - t0) / 1000).toFixed(1)}s | speech ends ${end}s | ${words.map((w) => `${w.text}@${w.start}`).join(" ")}`);
}
