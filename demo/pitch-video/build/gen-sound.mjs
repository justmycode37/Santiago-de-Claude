// Generate the sound effects and the two music beds with ElevenLabs.
// Usage: EL_KEY_FILE=<path> node gen-sound.mjs [name ...]
import fs from "node:fs";
import path from "node:path";

const key = fs.readFileSync(process.env.EL_KEY_FILE, "utf8").trim();
const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
const out = path.join(here, "sound");
fs.mkdirSync(out, { recursive: true });
const only = process.argv.slice(2);

const sfx = {
  hit: ["Deep cinematic impact hit, short low boom with a soft tail", 1.6],
  whoosh: ["Fast airy whoosh transition, short and clean", 0.9],
  suck: ["Reverse cymbal swell that rises and cuts off into sudden silence", 2.2],
  thump: ["Single soft low heartbeat thump", 0.8],
  tick: ["Subtle soft UI tap click", 0.5],
  riser: ["Rising synth riser building tension, ending in a clean release", 2.6],
  shutter: ["Single camera shutter click", 0.5],
  chime: ["Short bright positive UI chime, single note", 0.8],
};
const music = {
  "music-dark": ["Dark, tense cinematic underscore for a rainy night in a city. Low sustained drone, distant sub pulses, a few sparse felt piano notes, slowly growing unease. No drums, no vocals. Instrumental only.", 58000],
  "music-drive": ["Driving, hopeful cinematic electronic track for a product reveal. Starts at once with a steady pulsing synth at 120 bpm, builds quickly with claps and bright plucks, confident and warm, a big lift in the last 20 seconds and a clean final hit to end. No vocals. Instrumental only.", 66000],
};

const post = async (url, body) => {
  const res = await fetch(url, { method: "POST", headers: { "xi-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(res.status + " " + (await res.text()).slice(0, 300));
  return Buffer.from(await res.arrayBuffer());
};

const jobs = [];
for (const [name, [text, dur]] of Object.entries(sfx)) {
  if (only.length && !only.includes(name)) continue;
  jobs.push(post("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", { text, duration_seconds: dur, prompt_influence: 0.5 })
    .then((b) => { fs.writeFileSync(path.join(out, name + ".mp3"), b); console.log("sfx", name, b.length); }, (e) => console.log("sfx", name, "FAILED", e.message)));
}
for (const [name, [prompt, ms]] of Object.entries(music)) {
  if (only.length && !only.includes(name)) continue;
  jobs.push(post("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", { prompt, music_length_ms: ms })
    .then((b) => { fs.writeFileSync(path.join(out, name + ".mp3"), b); console.log("music", name, b.length); }, (e) => console.log("music", name, "FAILED", e.message)));
}
await Promise.all(jobs);
