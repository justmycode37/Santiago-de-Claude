# Plan: recognising the right vehicle in the AR camera

Status: agreed in a planning debate between Claude Fable, GPT Astra and Gemini Neon. Built so far: step 1 on both
clients; from step 2 the profiled, complete `/api/due` with `servesTo`; from step 3 the web's per-track PP-OCR and the
iOS reading gates; the timetable ambiguity audit ([ar-ambiguity-audit.md](ar-ambiguity-audit.md): step 4 deferred) and
the `due` archive; the reading-range bench and the detector swap to YOLOX-nano ([ar-reading-range.md](ar-reading-range.md)). What is built and how it is checked: [ar.md](ar.md); the field sessions: [ar-field-test.md](ar-field-test.md).

Constraint: **no data collection of our own, and only a few short real-life tests.** Instead of statistical field
gates, safety rests on structural rules that hold by construction. Open data and the existing public-video bench
replace field measurement where they can. The short field sessions look for failures; they don't prove error rates.

iOS paths are under `rightside/redesign/apps/ios/RightSide/`.

## Why it fails today

**Wrong vehicle: bookkeeping, not vision.**
- Web (`src/app/ar.ts`):
  - There is no tracker per vehicle.
  - A display read moves to whichever box is biggest for 6 s (`:151-156`).
  - With one service due, every box turns green.
  - "Not yours" can come from timing alone (`:215`).
  - `due` never expires when a poll fails.
  - The rider's run is guessed by `mineDue()` instead of being bound by `tripId`/`serviceDate`
    (`src/app/live-engine.ts:46`).
- `src/arcore.ts:301-303` lacks Swift's `sameDestination` fix (`DepartureDisplayMatcher.swift:168-175`). Because of it,
  "Bern, Bahnhof" and "Bern Wankdorf, Bahnhof" count as one display and a real rival drops out.
- Kante:
  - `/api/due` ignores the learned hop profiles (`liveapi.rs:200,244`).
  - The board is cut at `limit` (`:405`), so a rival can silently fall off at a hub.
- The display matcher groups by line + destination (`src/arcore.ts:250`). An express and a local with the same
  headsign look identical, but only one may stop where the rider is going.

**Only up close: resolution and gates.**
- Web: 300 px COCO-SSD, which has no tram class. Tesseract reads the whole frame, not the display.
- iOS:
  - 0.08 class-margin drop (`TransportSegmenter.swift:65`).
  - The tracker resets on any pan (`LiveCameraGuidance.swift:448-451`).
  - Coupled expiry gates shorter than the throttled cadence (`VehicleEvidence.swift:212,215,443-445`,
    `CameraEvidenceLifecycle.swift:123,130,175`).
  - Text below `minimumTextHeight` 0.025 is never proposed (`TransportSegmenter.swift:247`).
  - PP-OCR (rec only) runs only after Vision accepts a numeral at ≥ 0.7 (`VehicleDisplayRecognition.swift:63`).
  - Display crops already use full sensor pixels (`:234-243`).
- The bench never contained a vehicle under 0.22 of frame height, so range has never been measured.

## Safety rules (from the first release)

- **Green** needs all of:
  - the unchanged zero-wrong display matcher read this vehicle's display;
  - the read was taken from this track's own box at capture time, and the track was not ambiguously reassociated
    since;
  - the Kante board is complete (not truncated, not stale);
  - every plausible run with that display boards here and serves the rider's stop.

  If any part is missing, show the display text neutrally ("Display: 10 Rüti") plus the expected-service banner.
- **Red** needs a text contradiction in two distinct frames, or a short-turn / out-of-service found by
  `/api/identify`. Timing, mode, motion and kerb side never paint red.
- Green and red are **revoked** on a crossing, an ambiguous reassociation, a stale poll, or
  `multiple_matching_vehicles`.
- Timing, direction and position may only rank, withhold, or fill the banner ("10 → Rüti expected in 1 min").
  They never confirm a vehicle.
- No amber "probably yours" on a vehicle: its rider-behaviour risk can't be checked without a study.

## Build order

1. **Ownership and correctness: pure code, unit and replay tests.**
   - Web:
     - a class-agnostic tracker with gyro derotation;
     - OCR stamped at capture and attached to its source box;
     - revocation;
     - trip binding by `tripId`/`serviceDate` + quay;
     - due expiry;
     - delete the one-due green and the timing-only red;
     - load `ort.wasm.min.js` without DINOv2 and pause DINOv2 in AR (`src/stopvision.ts:1163,1236,1819`);
     - ask for motion permission on iOS Safari (`src/app/ar.ts:76-77`).
   - Port the Swift parity fix. First re-run `rightside/tools/display-bench/run-eval.sh`, then update the expected
     counts in `tools/test_arcore.mts`.
   - iOS: the pan reset, margin drop and coupled expiry gates.
   - Scripted event-replay suites through the production decision path, on both clients:
     - crossings and lost tracks;
     - late reads;
     - stale and truncated boards;
     - wrong quays;
     - twin buses;
     - express vs local with the same headsign;
     - short turns.

     Each suite asserts what is shown after every event, including revocation.
2. **Kante expectation, from open data only.**
   - Profiled `/api/due`, plus quay and prev/next stop coordinates, a sigma per call, and a completeness flag.
   - One station-wide call, grouped by quay on the phone.
   - Validate on Ist-Daten, holding out later days. Start a small server cron now that archives live SIRI-ET /
     `due` snapshots as they arrive (`livemap/measure/log.py`, `forecast_compare.py` pattern). Then compare profiled
     and raw predictions made at the same instant against later `REAL` calls, reporting match coverage. Estimated
     times are a separate stratum.
   - Run the timetable ambiguity audit next to `livemap/measure/identify_sim.py`: how often is the rider's run
     unique given time, quay, direction, line, and same-headsign express/local pairs? Its results order the later
     work.
3. **Display reading range, on the public-video bench.**
   - Web: a per-track native-resolution upper-band crop into PP-OCR det+rec (onnxruntime-web), alternating with
     full-frame sweeps and a road-band crop. Request the highest capture resolution the phone grants.
   - iOS: lower `minimumTextHeight`, relax the numeral gate, and add a CoreML PP-OCR text detector if Vision still
     misses small displays.
   - A/B single-frame contrast selection against multi-frame max compositing.
   - OCR order stays round-robin across tracks (`TransportSegmenter.swift:152-162`); it is never driven by the
     posterior, so a late real bus is not starved of reads.
4. **Fusion for ranking and withholding.**
   - A per-track posterior and Hungarian assignment rank the banner. They also block green when another plausible
     run shares the display or the board is incomplete.
   - Tuned by replaying the bench's real multi-frame OCR sequences against archived boards, plus adversarial ID
     swaps and distractors. Not tuned on independent per-frame draws: real misreads are correlated, e.g. adverts or
     a following bus (`display-bench/README.md`).
5. **Detector swap, only if the bench shows recall is the bottleneck.**
   - Use an off-the-shelf permissively licensed model (Apache/MIT/BSD), no custom training.
   - YOLOE on iOS calls Bern trams "train" about 5× more often than "tram", so the mode term treats tram/train as
     one class until that's fixed.

## What the offline evidence can and can't show

| Source | Use it for | Don't use it for |
| --- | --- | --- |
| `display-bench` public Bern videos, re-extracted at 5–10 fps with a lower `--min-height` | OCR and abstention regressions; reading rate vs **glyph pixel height**; front-end A/B. Labels per pass only; far frames get a label only where a multi-object tracker and a spot check agree on correspondence, else "unknown". | Detector recall (the tracks come from the same detector), metres, door lead time. |
| Downscaled near frames (blur, noise, JPEG) | Relative sensitivity of front ends and capture resolutions to glyph size | Absolute distance; LED scan phase, bloom, focus, exposure |
| Open Images V7 (CC-BY), BDD100K (BSD-3), Cityscapes (non-commercial, evaluation only) | Independent detector recall by class and size, bus vs tram/on-rails. Check per dataset that a tram class actually exists. | Swiss LED displays; the rider's viewpoint |
| Ist-Daten + archived live snapshots | ETA error by source, horizon and operator; timetable ambiguity | Which vehicle the camera saw |
| Phone self-test, live camera running | p95 capture-to-overlay age, sustained fps, dropped frames; iOS `thermalState` | Battery on Safari (no API) |

**Rights:** the YouTube clips are used for local evaluation only. Check each clip before re-extracting; never
redistribute the frames or train shipped weights on them. Videos from other cities become a test set only once
footage, rights and labels exist.

**Offline gate per release:** 0 false green and 0 false red on every available replay pass and adversarial suite.
That is necessary, not sufficient. It finds failures; it doesn't certify a street.

## Real-life testing (the user, about 1 hour in total)

Add a **"save last 10 s" button** in AR debug mode. It saves the track id, crop, timestamps, board age and the
reason for the label shown. Every saved glitch becomes a permanent replay test.

1. **Phone check (~15 min, one stop):**
   - granted capture resolution;
   - real ms per frame and overlay age;
   - 10 min thermal state on iOS;
   - motion permission on iOS Safari;
   - `ARGeoTrackingConfiguration.checkAvailability` in Bern.
2. **Hard cases (~20 min):** a shared quay with two buses crossing or bunching, then a handheld approach to a tram
   with an LED display at dusk or in glare. Watch for a label jumping to another vehicle, revocation, and whether
   what the app shows matches the display.
3. **One real trip end to end (~20 min):** is the banner useful, does the overlay stay steady, is there any scary
   green or red?

Any wrong green, wrong red or inherited label blocks that path until fixed and retested. Clean sessions prove
nothing beyond that.

## Cut under this constraint

- Amber per-vehicle labels.
- Camera-based exact positioning and surveyed kerb packs. Street-photo positions don't show the waiting rider's side.
- Bus make/model.
- Custom-trained detectors.
- National visual positioning.
- Red from anything but text.
- Any claim in metres or a population error rate.

If field data becomes available later, the amber tier and the camera-positioning pilot are the first things to revisit.
