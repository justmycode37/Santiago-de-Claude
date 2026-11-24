# AR camera: short field tests

About an hour in total, in three sessions ([the plan](ar-recognition-plan.md), "Real-life testing"). They look for
failures; a clean session proves nothing beyond that. Any wrong green, wrong red or label that jumps to another
vehicle blocks that path until it is fixed and tested again.

## Before you go

- Web: open the site with `?ardebug=1` once (remembered; `?ardebug=0` removes it). The AR camera then shows a debug
  line (capture size, detector ms, Tesseract and PP-OCR timing, each vehicle's label and why) and a
  **Save last 10 s** button. `?arres=max` asks for 4K instead of 1080p (remembered; `?arres=0` goes back).
- The engine must be the one from this branch: `/api/due` with `complete`, `servesTo` and `profiled`. With an older
  engine the camera never shows green (the board is never complete). That is safe, but nothing gets tested.
- iOS: a build of this branch. The camera's diagnostics line shows pipeline ms, track count and whether processing
  is reduced (hot phone or Low Power Mode).
- Plan a journey whose next step is a bus or tram, so the AR button appears on the walk or change step.

**Save last 10 s** right after anything odd. It saves a JSON file (shared or downloaded) with the ride, the board,
every detection, every display read (with its capture time), every label decision and revocation, and small crops of
each vehicle's display band. Note the time and what you saw.

## 1. Phone check (~15 min, one stop)

| Check | Where | Write down |
| --- | --- | --- |
| Capture size granted | debug line `video W×H`; once more with `?arres=max` | both sizes, and whether 4K changes detect/PP-OCR ms |
| Speed | debug line: `detect … ms`, `PP-OCR … ms`, `Tesseract age … s` | typical values after a minute |
| Overlay steadiness | boxes while panning slowly, then quickly | do boxes keep their label on a slow pan? A fast jerk should clear labels |
| Motion permission (iOS Safari) | first open of AR: a prompt; debug line `motion granted` | if `denied` or `unknown`, the gyro shift is off |
| Gyro shift | debug line says `(gyro shift off)` until the shift has matched boxes better than unshifted ones | pan slowly for a minute: does it turn on? If not, note the phone model (its axes or signs may differ) |
| Heat, 10 min (iOS app) | diagnostics line `reduced processing`, `thermalState` | when it throttles, and whether labels still appear |
| Geo AR coverage (iOS app) | status line on opening the camera | "No geographic AR coverage here" or the scan prompt |

## 2. Hard cases (~20 min)

1. **Shared stop, two buses crossing or bunching.** Hold the camera on both. Expected: each vehicle has its own
   label or none; when they overlap or cross, both labels disappear and come back only after new reads. Save at once
   if a label moves to the other vehicle.
2. **Handheld approach to a tram with an LED display, at dusk or in glare.** Start far and walk closer. Note the
   distance at which the display text first appears ("Display: …"), then green. Save a capture when it first reads
   and when a read is wrong.

What the app may show on a vehicle:

| Label | Meaning |
| --- | --- |
| none (outline only) | nothing read yet, or the label lapsed/was revoked |
| `Display: 10 → Rüti` (white) | the display was read, but green or red is not allowed: board stale or incomplete, a run with the same display skips your stop, or only one frame |
| `Your bus 10 → Rüti` (green) | your display, this vehicle's own reads, every run with that display serves your stop |
| `Not yours: 9 → Wabern` / `Not in service` (red) | text in two distinct frames |

The banner at the top gives your run's time and boarding point from the live board. It never labels a vehicle.

## 3. One real trip (~20 min)

Use AR from the walk to the stop until boarding. Is the banner useful? Does the overlay stay steady? Is there any
green or red that worries you? Save a capture for anything surprising.

## After the session

Each saved capture becomes a permanent replay test:

1. Put the JSON file in `tools/ar-replays/` (create the folder the first time). Crops stay in the file; they are
   small and only for looking at.
2. Add what must never happen again, e.g. `"expect": { "never": ["green"], "during": [1764000012.5, 1764000015] }`
   (seconds, the capture's own clock; `during` is optional).
3. `node tools/test_artrack.mts` replays it through the AR camera's own decision code. Fix until it passes. Keep the
   file.

Captures hold camera crops of the street: before committing one, check that no faces or number plates are readable
in its `crops`, or delete that field. The replay does not need it.
