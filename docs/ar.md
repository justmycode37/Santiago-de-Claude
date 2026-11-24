# AR camera on a journey step

The **AR** button sits next to **3D view** on a walk or change step that has a ride to board next
(`src/app/ar.ts`). It opens Scan's live camera (`src/stopvision.ts`) in an AR mode. There is no shutter: it
runs by itself until it is closed. `?ar=0` in the address hides the button (remembered; `?ar=1` shows it again).

| Part | How | Status |
| --- | --- | --- |
| Stop and boarding edge | Scan's sign OCR + GPS + compass. It outlines the sign and says where the next ride leaves from ([scan.md](scan.md)). | Live |
| Vehicle outline | COCO-SSD (TensorFlow.js `lite_mobilenet_v2`, from jsDelivr) finds buses, trams and trains about 3× a second, from a 1080p camera (`?arres=max`: 4K). | Live; recall and speed on phones not measured |
| Display reading | PP-OCRv5 (mobile detector + latin recogniser, `src/ppocr.ts`, onnxruntime-web) reads one vehicle's display band at a time at full camera resolution, round robin, and a band across the road every third turn. Scan's Tesseract sweeps the whole picture. The models come from Hugging Face at fixed revisions, SHA-256 checked. | Live; reads rendered LED displays near and far (`tools/check_ppocr.mts`); real displays and phone speed not measured |
| Which vehicle | Every detected vehicle is a track (`src/artrack.ts`). Every read, stamped with the moment its picture was taken, goes to the track whose box held it then, through `ARCORE.read` → `ARCORE.decide` (`src/arcore.ts`, RightSide's display matcher) against the ride and the Kante `/api/due` board. Green, red or the display text only, by the rules below. | Live |
| Banner | Your run, found on the board by its `tripId` and `serviceDate`: when it comes, and the boarding point when it changed. Times go stale 40 s after the last good poll. | Live |
| The way | A direction arrow toward the boarding edge plus the distance. Drawn only with a fresh compass heading and GPS accuracy of 30 m or better. | Live; a direction only, not anchored to the floor |

## The labels

The rules come from [ar-recognition-plan.md](ar-recognition-plan.md) and hold by construction:

- **Green** ("Your bus 10 → Rüti"): the display matcher accepts this vehicle's own reads; the board is fresh and
  complete (`/api/due`'s `complete`); every run due here with that display departs here and calls at your stop
  (`servesTo`, or it is your trip).
- **Red** ("Not yours: 9 → Wabern", "Not in service"): text only, in two distinct frames, on a fresh board.
- Otherwise the display text alone ("Display: 10 → Rüti"), or nothing. Timing never labels a vehicle.
- A crossing, an ambiguous match between two detections, a fast pan or a lost track drops the vehicle's reads and
  label; a vehicle seen again starts without one. A label lapses 8 s after the read that made it.

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
- From [the plan](ar-recognition-plan.md): the archive of live `due` snapshots and the profiled-vs-raw comparison,
  the timetable ambiguity audit, the bench re-extracted at 5–10 fps for reading range, single-frame vs multi-frame
  compositing, the per-track posterior, and a detector swap (only if the bench shows recall is the bottleneck).
- **Only a real phone at a real stop can tell:** detector and PP-OCR speed, LED display reading, the gyro shift's
  axes, compass bias near trams, the iOS permission flow, battery and heat ([ar-field-test.md](ar-field-test.md)).
