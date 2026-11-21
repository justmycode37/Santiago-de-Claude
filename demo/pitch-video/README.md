# Pitch video: source and how it was built

Everything behind [`demo/pitch-v4.mp4`](../pitch-v4.mp4): the 1:57 pitch film of team Santiago de Claude
(1920x1080, 30 fps, about -14.5 LUFS), built on Saturday 21 November 2026 between 12:00 and 16:45.

The film was built by an AI coding agent (Claude Code) directed by ktr0a. The agent cannot hear: voice pace,
music level and effect timing were set by measurement only. Listen to it once in full before relying on it.

## 1. How the film is made, in one paragraph

Nothing is generated as video. One Node script, `build/build4.mjs`, reads the narration's word timings, lays out a
timeline, cuts every piece of footage to the frame with ffmpeg, mixes the soundtrack, and writes six HTML scenes
with GSAP animations. HyperFrames (the npm package `hyperframes`: HTML rendered to video in headless
Chrome, Apache 2.0) then renders `pitch-v4/` to an MP4. The narration, music and sound effects come from
ElevenLabs. The app on screen is the real app: the team's iPhone screen recordings, plus footage recorded from the
app's own dev server with Playwright.

```
voice/script-*.json ──gen-voice.mjs──▶ voice/out-*/jon/*.mp3 + word timings (.json)
                                              │
night clip, demo/ScreenRecording_*.mov,       ▼
capture/v4/*.mp4 and *.png  ────────▶ build/build4.mjs ──▶ pitch-v4/assets/   (cut footage, soundtrack.wav)
build/sound/*.mp3  ─────────────────▶                  └─▶ pitch-v4/index.html, compositions/act1..6.html
                                                                  │
                                              npx hyperframes render ──▶ pitch-v4.mp4
```

## 2. What is in this folder

| Path | Contents |
|---|---|
| `build/build4.mjs` | **The generator.** Timeline, footage cuts, soundtrack and all scenes. Edit this, not the generated HTML. |
| `build/build3.mjs`, `patch4.cjs`, `patch4b.cjs`, `act5.part` | How build4 came to be: version 3's generator, and the two one-off scripts that turned it into version 4. Kept as a record; not needed to build. |
| `build/timeline-v4.json` | The timeline the build computed: when every sentence, quote and beat starts. |
| `build/gen-sound.mjs`, `build/sound/` | The ElevenLabs prompts for the sound effects and the two music beds, and the generated files. |
| `voice/gen-voice.mjs` | Generates narration with word timings from a script file. |
| `voice/script-v4.json`, `voice/out-v4/jon/` | Narration text and audio of acts 1, 2, 3, 4 and 6 (from version 3). |
| `voice/script-v5.json`, `voice/out-v5/jon/` | Narration text and audio of act 5, rewritten for version 4. |
| `capture/capture4.mjs` | Records the current app at phone size: five segments, each an MP4 plus a JSON with the times of its taps. |
| `capture/shots4.mjs`, `shots5.mjs` | 3x stills of the journey sheet, the step list and three settings rows. |
| `capture/explore4.mjs`, `explore5.mjs` | The two exploration passes that found the screens and selectors. |
| `capture/check4.cjs` | Pulls frames from the render at every feature beat and tiles them for review. |
| `capture/v4/` | The recorded footage and stills, and `chk/sheet-*.jpg`: the review sheets of the final render. |
| `demo-assets/logo-frame.png` | Source of the logo: a frame from the end of `demo/santiago.mp4`. |
| `pitch-v4/` | The HyperFrames project as generated: `index.html`, `compositions/act1..6.html`, `assets/`. Render from here. |

Not in this folder:

- **The night clip** (`IMG_3466.mov`, 4:32, 550 MB, filmed by the team at Bern station). Only the pieces used in
  the film are here, already cut (`pitch-v4/assets/night-a1.mp4`, `night-a4.mp4`, `night-a6.mp4`). ktr0a has the
  original. It is needed only to re-cut the night footage or its sound.
- **The four screen recordings**: they are one folder up, `demo/ScreenRecording_11-21-2026 13-29-08_1-01..04.mov`.
  The build finds them there. In this text they are called rec1 to rec4.
- **API keys.** Narration, music and effects are already generated.

## 3. Render and rebuild

Needs Node 22 or newer, ffmpeg and ffprobe on the PATH, and Google Chrome. Built on Windows 11 with Node 26 and
ffmpeg 8.1. HyperFrames runs through `npx hyperframes@0.9.77`; nothing to install.

```bash
# render what is here (about 1.5 minutes on a free machine)
cd demo/pitch-video/pitch-v4
npx hyperframes@0.9.77 render -o renders/pitch-v4.mp4
npx hyperframes@0.9.77 check          # validates the project

# change something and rebuild
cd demo/pitch-video/build
npm install                            # once: the qrcode package
node build4.mjs --no-media             # scenes only: text, positions, animation timing (2 s)
CLIP=/path/to/IMG_3466.mov node build4.mjs   # everything: footage, soundtrack, scenes (20 s)
ONLY=phE,tk node build4.mjs            # re-cut only those media pieces, then soundtrack and scenes
```

A full build from this folder was run once and reproduced `pitch-v4/` byte for byte. A full build needs the
night clip (`CLIP`); `--no-media` does not.

| To change | Do this |
|---|---|
| A narration line | Edit `voice/script-v5.json` (act 5) or `script-v4.json` (other acts). In `voice/`, with an ElevenLabs key in a text file: `EL_KEY_FILE=<file> EL_SCRIPT=./script-v5.json EL_OUT=out-v5 node gen-voice.mjs jon a5-beyond`. Then rebuild. `A("a5", 18)` in the build means sentence 18 of act 5, so adding or removing a sentence shifts the numbers after it. |
| Pace | The gap after each sentence is the last argument of `S(...)` and `say1(...)` in the timeline block. `TEMPO` speeds each act's voice up without changing pitch. |
| Which moment of a recording is shown | The `clip(...)` and `still(...)` calls in the media block: source time `t0`, speed, crop `[x, y, width, height]` in source pixels. |
| How a feature is shown | The act 4 and act 5 scene blocks. Each beat is a few lines of HTML and animation calls. |
| On-screen words, colours | The scene blocks, and the palette object `C` at the top. |
| Footage of the app | `capture/`: `npm install`, start the app (`npm run dev -- 8160` in the repository root), then `node capture4.mjs [segment,...]`, `node shots4.mjs`, `node shots5.mjs`. |
| Check a render | `node capture/check4.cjs` writes `capture/v4/chk/sheet-a4.jpg`, `sheet-a5a.jpg`, `sheet-a5b.jpg`. |

## 4. Direction for the film

ktr0a's direction, given over the afternoon, which every version had to follow:

- It is a **pitch**: emotional, promotional, told as a hero's arc. No section on limits.
- The story is the team's own: five people missed bus 10 at Bern station on a Friday night after 20 minutes of
  searching. The film opens on that and returns to it at the end.
- **Fast.** Speech moderately rapid, sound effects carry the momentum, no start-stop. The voice never pauses to
  wait for an animation.
- The opening list is **relatable**: no wheelchair and no blindness there.
- **Only what the app really does.** Real recordings; nothing drawn or simulated.
- **A different shot style for every feature**: phone frame, close-up, split screen and so on.
- The **light to dark switch** is shown for 3 to 4 seconds with a click and a small zoom, in the background, not
  as a feature that gets explained.
- The app **adapts to the user** and **connects people to events** (tap an event, see it, get taken there).
- Colours: the team palette from `demo/palette.png` (344D77, C55A82, FFD34B, FF7241) on a night-navy ground
  (0F1524). Logo: the team's, animated at the end with its dots spinning and a sound.
- Voice: ElevenLabs "Jon - Warm & Grounded Storyteller", default settings, sped up to fit.
- No subtitles, only large key words. No swearing from the footage. At most 2:00.

## 5. Narration

Model `eleven_v4`, voice "Jon - Warm & Grounded Storyteller" (`MFZUKuGQUsGJPQjTS4wC`), no voice settings sent, through
`/v1/text-to-speech/<voice>/with-timestamps` so every word comes back with its start and end time. One clip per
act. Eleven v4 ignores the speed setting, so the pace comes from two things in the build: each sentence is cut
out of its clip and placed with a chosen gap (0.06 to 0.6 s), and each act is sped up with ffmpeg `atempo`
(act 1: 1.08, act 2: 1.10, act 3: 1.06, act 4: 1.10, act 5: 1.12, act 6: 1.06).

| Act | Starts | Text |
|---|---|---|
| 1 The night | 0:00 | Friday night. Bern station. Rain. Five of us. One bus. We had the timetable app. We had the map on the wall. We even asked an AI. Twenty minutes later, we watched it leave. |
| 2 The weight | 0:24 | For us, it was just a bus. We speak the language. We can run. We can read the signs. Now arrive in a country you have never seen. In a language you can't read. With two heavy bags. And four minutes to change. Then it's not a bus. It's the job interview. The doctor. The first day of school. |
| 3 The turn | 0:43 | That night, we stopped being angry, and started building. This is Santiago. |
| 4 The answer | 0:49 | Nobody knew where the bus stops. Santiago does. Bay L. The app said: right spot. Santiago shows the exact one. Which bay. Which side of the road. We found out twenty minutes too late. Santiago tells you when to leave, and shows every turn of the walk. |
| 5 Beyond our problem | 1:07 | And it goes further than our problem. It adapts to you. New here? Pick your language. Any of two hundred and forty-nine. Can't take stairs? Switch them off. Walk slower? Santiago learns your pace. Search anywhere. Choose your route. Watch your bus arrive, live. Big station? Walk through it in 3D, before you get there. Then the map fills with what you need. Toilets. Drinking water. Free food. A language café near you. One tap, and Santiago takes you there. And your ticket? One tap. Price included. So you don't just arrive. You belong. |
| 6 The return | 1:43 | Friday night. Bern station. Rain. Bus ten. Bay L. Fifty metres away. Santiago. Know exactly where to stand. |

Between the narrator's lines in act 1 the team's own voices from the night clip are heard, with the quote on
screen: "Nobody knows.", "We're even at the correct spot, according to SBB.", "There's no indicator where we
are.", "We're pulling out the big guns.", "That's the one!", "No! No way."

## 6. Footage

### The night clip (`IMG_3466.mov`, seconds)

| Seconds | What | Used |
|---|---|---|
| 2 to 19 | Walking through the station, wet ground | Opening and the return (from 2.2) |
| 28.3 to 29.75 | "Nobody knows." | Quote 1; act 4 panel from 27.2 |
| 32.9 to 35.35 | "We're even at the correct spot, according to SBB." | Quote 2 |
| 88.5 to 89.85 | "We're pulling out the big guns.", then the chat question | Quote 4 |
| 137 | The red timetable app on the phone | "We had the timetable app"; act 4 panel |
| 175 to 183 | The map on the wall; "There's no indicator where we are." | Quote 3 (181.05 to 182.65) |
| 242.5 to 243.45 | "That's the one!" | Quote 5a |
| 246 to 252 | The sprint; "No! No way." (249.25 to 250.35) | Quote 5b |
| 252.5 to 255 | Bus 10 pulling away | The end of act 1; the sound is sucked out to silence |
| about 20, 64, 150, 262, 269 | Swearing | Kept out |

The bus's rear display reads "10" and the team says "We gotta come to L" in the clip, which is why the film says
bus 10 and Bay L (bus 10 towards Ostermundigen Rüti leaves from Bay L).

### The team's screen recordings (`demo/ScreenRecording_…_1-01..04.mov`, 1206x2442)

| File | Seconds | What | Beat |
|---|---|---|---|
| rec1 | 0.2 to 1.8 | Light mode flips to dark at 0.84 | Act 5 D, slowed to last two sentences |
| rec2 | 2.9 onwards | Journey steps with "Leave by" | Act 4 C, "when to leave" |
| rec2 | 6.2 onwards | The map follows the walking route (2.2 times as fast) | Act 4 C, "every turn of the walk" |
| rec4 | 11.7 onwards | Pins appear on the map (1.7 times as fast) | Act 5 K |
| rec3 | 0.2, then 2.9 | Events map with event cards, a tap on the language café | Act 5 M |
| rec3 | 14.6, then 15.7 | Event page with "Show journey", the route appears at 16.0 | Act 5 M |

### Footage recorded from the app (`capture/v4/`)

Recorded on 21 November between 16:20 and 16:45 from `origin/main` as of 16:02, served by `npm run dev -- 8160`.
Playwright (`playwright-core`) drives the installed Google Chrome, headless, with a phone viewport of 390x844 at
device scale factor 2, touch enabled, locale `en-GB`, and the position fixed at Bern station, Bay C
(46.94758, 7.44007). `?intro=0` skips the first-visit introduction; an empty profile shows it. A small grey tap
ring is drawn in the page before each tap so it is part of the footage. The times below are in each segment's
`.json`.

| Segment | How it is recorded | What happens, with seconds |
|---|---|---|
| `intro.mp4` (390x844) | CDP screencast | Welcome page; "Yes, show me" at 1.6; the first-person 3D walk across Hirschengraben, tram stop B to C, until 24.4 |
| `questions.mp4` (780x1688) | Screenshot loop | "Not now" at 0.4; question 1: "Relaxed" at 2.24, "Adjust to how I walk" at 3.70; question 2: "I can't take stairs or escalators" at 7.70; "Open the map" at 10.05 |
| `lang.mp4` (780x1688) | Screenshot loop | Menu 0.4, Settings 1.3, App language 3.0; the list glides down 4.2 to 7.1; Ukrainian tapped at 8.0; settings in Ukrainian from about 9.0 |
| `journey.mp4` (780x1688) | Screenshot loop | Search tapped 0.4, "Wankdorf" typed, results from 2.0; journey to Ostermundigen, Rüti called at 3.8; list of journeys 4.05; second journey tapped at 7.44; its sheet with Start, Ticket and the fare |
| `live.mp4` (780x1688) | Screenshot loop | The map at Bern station, zoom 15.9 to 16.5, live vehicle dots moving, 12.2 to 28.1 |

Stills at device scale factor 3 (1170x2532): `routes4.png` (list of journeys), `journey4.png` (one journey:
"50 m to Bay L", Start, Ticket, "CHF 5.20 · Full fare · 2nd class"), `steps4.png` (step list: "Bay L", "Where to
stand: On Bubenbergplatz, south side of the road", the 3D view button), and `row-toilets.png`, `row-water.png`,
`row-food.png` (settings rows, Free food switched on for the shot).

Two things are not done through the visible interface, both for reliability:

- The journey to Ostermundigen, Rüti is started through the app's own `showDestinationJourney(...)`, because the
  search for that stop did not put it first. The typed search in the film ("Wankdorf") is real.
- The menu, settings and introduction buttons are clicked through the DOM (`el.click()`), because mouse clicks stop
  landing on them once the device metrics are overridden for 2x capture.

## 7. The film, shot by shot

Times are from `build/timeline-v4.json`.

| Time | Beat | Voice | Picture | Source |
|---|---|---|---|---|
| 0:00 | Act 1 | The night, with the team's quotes | Night clip in a panel on the left (540x960), narrator lines and quotes as large type on the right; bus leaves; black | Night clip |
| 0:24 | Act 2 | The weight | Type only on navy; the last three lines in yellow, orange and magenta | none |
| 0:43 | Act 3 | The turn | A yellow dot grows to fill the frame: "This is Santiago." | none |
| 0:49 | 4 A | "Nobody knew… Santiago does. Bay L. The app said: right spot." | Night panel left, a phone right with the journey sheet, zooming on "50 m to Bay L" | Night clip, `journey4.png` |
| 0:55 | 4 B | "The exact one. Which bay. Which side of the road." | Three full-frame close-ups with word chips | `steps4.png`, crops `[0,1560,1170]`, `[180,1635,750]`, `[281,1690,889]` (16:9) |
| 1:00 | 4 C0 | "We found out twenty minutes too late." | Night panel, the sprint | Night clip from 249.8 |
| 1:03 | 4 C | "…when to leave, and shows every turn of the walk." | A large phone in the middle, words on both sides | rec2 |
| 1:07 | 5 D | "And it goes further… It adapts to you." | Phone right; a cursor clicks the theme button and the app flips to dark | rec1 |
| 1:10 | 5 E | "New here? Pick your language. Any of two hundred and forty-nine." | Phone left: the language list, Ukrainian picked, settings in Ukrainian; "249 languages" | `lang.mp4` 4.3 to 6.9 sped up, then from 7.75 |
| 1:14 | 5 F | "Can't take stairs? Switch them off." | Full-frame close-up of the access switches; the switch goes on with "Switch them off." | `questions.mp4`, crop `[0,510,780,439]` |
| 1:16 | 5 G | "Walk slower? Santiago learns your pace." | Split screen: the speed question on the left half | `questions.mp4` from 1.95 and 3.45, crop `[0,500,780,878]` |
| 1:19 | 5 H | "Search anywhere. Choose your route." | A large phone in the middle: search results, then the list of journeys and a tap | `journey.mp4` 0.9 to 3.4 sped up, then from 6.3 |
| 1:22 | 5 I | "Watch your bus arrive, live." | Full-frame map, vehicle dots moving | `live.mp4` from 13, four times as fast, crop `[0,660,780,439]` |
| 1:24 | 5 J | "Big station? Walk through it in 3D…" | Phone right: the first-person walk; the five stations with 3D models named below | `intro.mp4` from 3, 3.5 times as fast |
| 1:28 | 5 K | "Then the map fills with what you need." | Full-frame map filling with pins | rec4 |
| 1:30 | 5 L | "Toilets. Drinking water. Free food." | Three rows slide in, one per word | `row-*.png` |
| 1:32 | 5 M | "A language café near you. One tap, and Santiago takes you there." | Phone right, the steps listed on the left | rec3 |
| 1:37 | 5 N | "And your ticket? One tap. Price included." | The bar with Start and Ticket as a wide card under the words; a tap ring on Ticket; the fare outlined | `journey4.png`, crop `[0,2238,1170,294]` |
| 1:40 | 5 end | "So you don't just arrive. You belong." | Type only | none |
| 1:43 | Act 6 | The return | The first shot again; "Bus 10. Bay L. Fifty metres away." beside the phone | Night clip, `journey4.png` |
| 1:50 | Logo | "Santiago. Know exactly where to stand." | The wordmark rises, its six dots fly in on a wide orbit, spin and land above the "i"; tagline, team line, QR code to the live site | `demo-assets/logo-frame.png` |

Speed-ups are stated because they change what the viewer sees: the live vehicles (4x), the 3D walk (3.5x), the
language list and the search (about 2x), the walking route (2.2x) and the map pins (1.7x) are faster than real.

Left out, and why: the camera stop scan (needs a real camera), dragging the start and destination pins (they are
visible in the search bar but not dragged), the welcome page of the introduction, fare suggestions from trip
history and the Half Fare price, and the 3D views of the four other stations (named, not shown).

## 8. Sound

All of it is in `build/sound/`, generated with ElevenLabs by `build/gen-sound.mjs`, which holds the exact prompts.

- **Effects** (`/v1/sound-generation`, prompt influence 0.5): `hit`, `whoosh`, `suck`, `thump`, `tick`, `riser`,
  `chime`, and `shutter` (unused). `spin` (the logo) was generated the same way later; its prompt was not kept
  in the script.
- **Music** (`/v1/music`): `music-dark` (58 s, dark and tense, no drums) under acts 1 to 3, and `music-drive`
  (66 s, 120 bpm, hopeful) from "This is Santiago" to the end. In version 4 the second half is 69.3 s long, so
  `music-drive` is slowed to 0.953 of its speed to end with the film.
- **Where effects sit**: a hit on each of "We had…", "We had…", "We even asked…"; a whoosh into every quote and
  every feature beat; the reverse swell into the silence after the bus; a thump on each line of the list in act 2
  (louder on the last three); a riser and a hit into "This is Santiago"; a chime on "Bay L"; ticks on the punch
  lines and on the two taps; a hit on "You belong"; the spin and a chime on the logo.
- **Mix** (ffmpeg, in the build): five stems. Each is measured (EBU R128) and brought to a target: narration
  -16 LUFS, the team's quotes -17, ambience of the night clip -33, music -20, effects at a fixed 0.55. The music is
  ducked under speech by a sidechain compressor (threshold 0.02, ratio 5, attack 15 ms, release 450 ms). The sum is
  limited and normalised to -14 LUFS, true peak -1.5 dB. The render measures -14.5 LUFS.

## 9. Scenes and render

`pitch-v4/index.html` is the root composition (1920x1080, 116.62 s) with six sub-compositions, one per act, and the
soundtrack as one audio clip. Each scene is plain HTML and CSS with a paused GSAP 3.15 timeline that HyperFrames
seeks frame by frame. Type is Inter. The build writes every position and time as a literal number, so the scenes
are readable but should not be edited by hand: the next build overwrites them.

Three kinds of shot recur: a phone frame with a video or a still inside (`-iph` for the iPhone recordings,
`-cph` for the 390x844 captures, `-ph` for stills), a full-frame close-up that punches in on the cut and keeps
pushing with a coloured word chip (`closeup(...)`), and plain type.

`npx hyperframes@0.9.77 check` reports no errors and nine warnings (text shown briefly, and the small address
under the QR code). The render took 1 minute 25 seconds for 3,499 frames with six workers.

## 10. What was checked

- Frames of the final render at every feature beat, tiled in `capture/v4/chk/sheet-a4.jpg`, `sheet-a5a.jpg` and
  `sheet-a5b.jpg`: each beat shows the feature its line names, no leftover placeholder, no stray overlay.
- Length 1:56.6, loudness -14.5 LUFS.
- **Not checked: the sound by ear.** Voice pace after the speed-up, music against voice, the slowed music track
  and the effect timing are for a person to judge.

## 11. Versions

| Version | Time | What |
|---|---|---|
| 1 | 13:08 | First full cut. Voice Liam, black and yellow, phone beside text. Contained drawn features (scan result, read aloud, language list). ktr0a: the layout is the basis, the problem part is too slow. |
| 2 | 14:01 | Voice Jon, team palette, only full-frame close-ups of the recordings. ktr0a: "a mess", but the pace of the problem part and the voice were right. |
| 3 | 15:12 | Version 1's layout, version 2's pace, voice and colours, a different shot style per feature, dark-mode click, animated logo, Get ticket. 1:49. |
| 4 | 16:44 | This one. Acts 4 and 5 rebuilt on the app as of 16:00: language, access needs, adaptive walking speed, search, choice of journeys, live vehicles, the 3D walk, ticket with its fare. New narration for act 5. The placeholder shot is gone. 1:57. |

## 12. Things that cost time

- **Eleven v4 ignores the speed setting.** Pace comes from cutting gaps and from `TEMPO`.
- **HyperFrames:** a `<video>` is not clipped by its parent's rounded corners in the render; the radius goes on the
  video itself. A `fromTo` shows its start state from the first frame unless `immediateRender: false` is set; that
  is how a stray ring once sat on screen for half an act. Element ids must be unique within a scene.
- **Recording the 3D view** with a screenshot loop gives under one frame per second. `Page.startScreencast` gives
  70, at 1x, which is enough inside a phone frame.
- **2x capture** needs `Emulation.setDeviceMetricsOverride` on the same CDP session; after it, touch taps and some
  mouse clicks stop landing, so those buttons are clicked through the DOM.
- **The search result list renders twice** (local, then online). A tap during the swap closes it; wait until its
  text has been stable for about half a second.
- **Windows PowerShell 5.1** reads UTF-8 files without a byte-order mark as ANSI. Rewriting the narration JSON
  through it turned "café" into "cafÃ©", which the voice then read. Edit JSON in an editor or with Node.
- **The app changes under you.** Retake the footage and stills close to the final render.
- **Other heavy jobs on the same machine** turned a 90-second render into 7 minutes.
