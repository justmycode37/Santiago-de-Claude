# AR camera on a journey step

The **AR** button sits next to **3D view** on a walk or change step that has a ride to board next
(`src/app/ar.ts`). It opens Scan's live camera (`src/stopvision.ts`) in an AR mode. There is no shutter: it
runs by itself until it is closed. `?ar=0` in the address hides the button (remembered; `?ar=1` shows it again).

| Part | How | Status |
| --- | --- | --- |
| Stop and boarding edge | Scan's sign OCR + GPS + compass. It outlines the sign and says where the next ride leaves from ([scan.md](scan.md)). | Live |
| Vehicle outline | YOLOX-nano (Megvii, Apache-2.0, `src/yolox.ts`, served from `models/yolox/`) in onnxruntime-web finds buses, trams and trains about 3× a second, from a 1080p camera (`?arres=max`: 4K). It replaced COCO-SSD, which missed most vehicles whose displays were already readable ([ar-reading-range.md](ar-reading-range.md)). | Live; speed on phones not measured |
| Display reading | PP-OCRv5 (mobile detector + latin recogniser, `src/ppocr.ts`, onnxruntime-web) reads one vehicle's display band at a time at full camera resolution, round robin, and a band across the road every third turn. Scan's Tesseract sweeps the whole picture. The models come from Hugging Face at fixed revisions, SHA-256 checked. | Live; reads rendered LED displays near and far (`tools/check_ppocr.mts`); real displays and phone speed not measured |
| Which vehicle | Every detected vehicle is a track (`src/artrack.ts`). Every read, stamped with the moment its picture was taken, goes to the track whose box held it then, through `ARCORE.read` → `ARCORE.decide` (`src/arcore.ts`, RightSide's display matcher) against the ride and the Kante `/api/due` board. Green, red or the display text only, by the rules below. | Live |
| Banner | Your run, found on the board by its `tripId` and `serviceDate`: when it comes, and the boarding point when it changed. Times go stale 40 s after the last good poll. | Live |
| The way | A direction arrow toward the boarding edge plus the distance. Drawn only with a fresh compass heading and GPS accuracy of 30 m or better. | Live; a direction only, not anchored to the floor |

## The labels

The rules come from [ar-recognition-plan.md](ar-recognition-plan.md) and hold by construction:

- **Green** ("Your bus 10 → Rüti"): the display matcher accepts this vehicle's own reads; the board is fresh and
  complete (`/api/due`'s `complete`); every run on the board with that display (also one timed as departed) can be
  boarded here (`pickup`) and lets you off at your stop (`servesTo`; your own trip counts when the engine does not
  say). Two vehicles that would both be green are both shown neutral.
- **Red** ("Not yours: 9 → Wabern", "Not in service"): text only, in two distinct frames, on a fresh board, and
  only when it names something: another departure on the board, a stop of your route before yours (a short turn),
  or out of service. A contradiction that names nothing listed ("7 Detrina" for "7 Ostring") is how correlated
  misreads of the right display look on the bench, so it gets no label. Reads of pictures taken within 0.12 s
  (Tesseract and PP-OCR on the same picture) are one frame.
- Otherwise the display text alone ("Display: 10 → Rüti"), or nothing. Timing never labels a vehicle.
- A crossing, an ambiguous match between two detections or a fast pan drops the vehicle's reads and label. A
  vehicle missing from one detection is gone: seen again, it is a new vehicle without a label (another vehicle may
  have taken its place). A label lapses 8 s after the read that made it.

`tools/test_artrack.mts` replays scripted events through this code (crossings, late reads, stale and truncated
boards, wrong quays, twin buses, express and local with the same display, short turns) and checks what is shown
after each one. `?ardebug=1` adds "Save last 10 s" for field tests ([ar-field-test.md](ar-field-test.md)); a saved
capture goes into `tools/ar-replays/` and is replayed there too.

## The decision logic

`src/arcore.ts` is DOM-free and shared with Node (`tools/test_arcore.mts`, part of `npm test`). It reproduces the
Swift display bench (`rightside/tools/display-bench`) exactly. Dev set: 72/111 right vehicles accepted. Held-out
set: 26/35. No wrong vehicle accepted in either. Those numbers come from PP-OCR text on recorded video, not from the
web's Tesseract on a phone.

## Not done yet

- Floor-anchored arrows. iOS Safari has no WebXR, so they belong to the native app (ARKit, `rightside/`), which can
  reuse this logic.
- Fusing what the camera sees into the position (sign as a position anchor, compass bias). The planning reviews found
  that a close sign cannot correct the compass, and that a vehicle read says little about where you are.
- `/api/identify` as a consistency check. Its `bearing` is the vehicle's travel direction, not the camera heading.
- From [the plan](ar-recognition-plan.md): the `due` archive runs once enabled on the server
  (`deploy/units/kante-due-archive.service`); its comparison with Ist-Daten (`livemap/measure/due_compare.py`) needs
  a few days of it. The per-track posterior (step 4) is deferred ([ar-ambiguity-audit.md](ar-ambiguity-audit.md)).
  The held-out bench set has not been re-extracted at 5 frames/s (kept for one final run).
- **Only a real phone at a real stop can tell:** detector and PP-OCR speed, LED display reading, the gyro shift's
  axes, compass bias near trams, the iOS permission flow, battery and heat ([ar-field-test.md](ar-field-test.md)).
