# Vehicle display benchmark (recorded video, runs on a PC)

Measures how well RightSide tells which bus or tram is in front of the camera, from its destination display,
using real footage of Bern trams and buses. The decision code under test is the app's own Swift
(`VehicleTextRules`, `VehicleServiceMatcher`, `DepartureDisplayMatcher`), compiled for Linux; only the camera
front end is replaced.

## What is in `data/`

| File | Content |
| --- | --- |
| `bern-video-ocr.json` | Per-frame detections and OCR text (boxes normalised, top-left origin) for 2,177 frames of four public videos, 1 frame/s. |
| `bern-video-events.json` | Frames grouped into vehicle passes (largest vehicle followed through consecutive frames). |
| `bern-video-labels.json` | 111 passes labelled with the line and destination shown, read from the pixels on sheets that showed no OCR output. Video URLs are listed in the file. |
| `../data-holdout/` | The held-out set in the same format: 3,243 frames at 2 frames/s from four other videos, 36 labelled passes (one is a special "Extrawagen" tram without a service). |
| `bern-board.json` | 39 bus/tram line–destination pairs from transport.opendata.ch stationboards at ten Bern stops (21 Nov 2026), the closed set the matcher chooses from. |

The videos themselves are not stored here. `ocr_frames.py` and `make_events.py` rebuild the OCR and event
files from any folder of frames.

## The stand-in front end, and what it does not measure

`ocr_frames.py` runs YOLOE‑11s‑seg (the same checkpoint and text prompts the app converted to Core ML) to find
vehicles, then PP‑OCRv5 (mobile text detector + the latin recogniser whose weights the app bundles) on the
vehicle and on its upper 55 %, like the app's second display pass. On the phone, Apple Vision is the primary
reader and PP‑OCR only a fallback, the detector is the converted Core ML model, and frames arrive every 0.4 s
instead of 1 s. So:

- absolute rates here are **not** on-device accuracy;
- the comparison between strategies is fair, because all three see exactly the same OCR evidence;
- passes are replayed with 0.5 s between frames so the app's 2 s / 3-frame temporal rule applies as it would live.

## Results

Two sets. The **dev set** (111 passes, 1 frame/s) was used to find and fix failure modes, so its numbers are
optimistic. The **held-out set** (36 passes from four other videos, 2 frames/s, `data-holdout/`) was labelled
only after the code was frozen and was run once; the one change made afterwards (legacy contradiction rule,
below) is reported with both before and after numbers.

"Right vehicle" trials: the rider's selected ride is the service shown. "Wrong vehicle" trials: the rider
expects another service of the board (including the same line to another destination and another line to the
same destination). A decision is taken frame by frame over each pass, as the camera would.

| Strategy | Set | Right vehicle accepted | Right vehicle flagged wrong | Wrong vehicle accepted | Wrong vehicle flagged |
| --- | --- | --- | --- | --- | --- |
| Original snapshot rules (`run-baseline.sh`) | dev | 0 % | 25.2 % | 0 % | 26.6 % |
| Board matching (this change) | dev | 41.4 % | 0 % | 0 % | 57.3 %, service named 200/200 |
| Original snapshot rules | held-out | 0 % | **48.6 %** | 0 % | 50.4 % |
| Board matching, as frozen | held-out | 65.7 % | 8.6 % | 0 % | 80.5 %, named 74/74 |
| Board matching, final | held-out | **65.7 %** | **0 %** | **0 %** | 68.1 %, named 74/74 |

The held-out run showed that the remaining false alarms all came from the snapshot's exact-spelling rule firing
on a single frame of junk: an advert parsed as line "e" ("AARE DACH AG"), a van's phone number, or the right
display in short form ("10 Schliern" for "Schliern, Bus-Endstation"). That rule now needs a credible
contradiction in two distinct frames. It removed every false alarm at the cost of some correct warnings that
the old rule had produced by chance (80.5 % → 68.1 %). No strategy ever accepted a wrong vehicle.

**Confidence ranking** (frames ranked by confidence, top three; consensus of two, else the single most
confident frame if ≥ 0.6): dev 41.4 % → 68.5 % right vehicles accepted, held-out 65.7 % → 77.1 %, wrong
vehicles flagged 57 % → 69 % / 68 % → 72 %; still 0 % false alarms and 0 % wrong vehicles accepted. The
thresholds were fixed before the run. `--positions` / `--positions-degraded` add simulated GPS, compass and
Kante vehicle positions (the videos have none); held-out wrong vehicles flagged 72 % → 79 % / 75 %, no wrong
vehicle accepted. The basis of every decision is printed at the end of each run.

**After the review fixes (fix/rightside-review):** two destinations that only share a generic word ("Bern, Bahnhof"
and "Bern Wankdorf, Bahnhof") are no longer treated as the same display. That removed an advantage the earlier
numbers got from a bug: a real competing service had been dropped from the comparison. Now: dev 64.9 % right
vehicles accepted, 64.5 % wrong vehicles flagged (225/225 named correctly); held-out 74.3 % accepted, 68.1 %
flagged (77/77); still 0 % false alarms and 0 % wrong vehicles accepted.

**Rect containment (found while porting the matcher to TypeScript, `src/arcore.ts`):** on Linux, swift-corelibs'
`CGRect.contains(rect)` compares `union(rect) == self` exactly, so most float boxes failed (dev: 4,710 of 8,725
truly contained text boxes). The text-to-vehicle association in `read()` therefore rarely passed, and the numbers
above mostly measured the board path. The app now uses an explicit containment (`CGRect.encloses`, 1e-9 tolerance)
on every platform, and `run-baseline.sh` applies true containment to the original rules too (`EXACT_CONTAINS=1`
for the old behaviour). With true containment: dev 63.1 % right vehicles accepted (70/111), 63.9 % wrong vehicles
flagged (219/219 named); held-out 68.6 % (24/35) and 66.4 % (71/71); 0 % false alarms and 0 % wrong vehicles
accepted with the board. Without a board, one held-out pass (#120, where a second vehicle fills the later frames)
is now flagged wrong (2.9 %). Original rules with true containment: right vehicles flagged wrong 43.2 % dev,
60.0 % held-out.

Per frame on the held-out set, the board matcher names the display correctly in 24 % of frames and wrongly in
0.9 % (all 8 wrong frames are one pass where a second bus, "19 Blinzern", follows the labelled one). Most other
frames are honestly unresolved: LED displays blanked by the camera's rolling shutter, side views, adverts.

Matcher cost: about 2 ms per frame for the busiest frames (42 text fragments, 39 candidate services) on one PC
core (`--bench`); an iPhone core is in the same range, but that is not measured here.

## Running

```sh
# Linux or WSL with a Swift toolchain (swift.org tarball), or macOS command-line tools
rightside/tools/display-bench/run-eval.sh [path/to/swiftc]            # summary
rightside/tools/display-bench/run-eval.sh swiftc --why                # per-frame evidence for passes not accepted
rightside/tools/display-bench/run-eval.sh swiftc --wrong              # frames identified as the wrong service
rightside/tools/display-bench/run-eval.sh swiftc --bench              # matcher cost per frame
DATA=data-holdout rightside/tools/display-bench/run-eval.sh swiftc    # held-out set
rightside/tools/display-bench/run-eval.sh swiftc --positions-degraded  # with simulated GPS/compass/Kante positions
rightside/tools/display-bench/run-baseline.sh swiftc                  # the original snapshot's rules on the same trials
```

Rebuilding the OCR from frames (Python 3.12+, `onnxruntime`, `opencv-python-headless`, `pyclipper`,
`ultralytics` with its CLIP dependency; models from the PaddlePaddle Hugging Face repos and the Ultralytics
v8.3.0 release, SHA-256 as in the app's manifests):

```sh
ffmpeg -i video.mp4 -vf fps=1 -q:v 3 frames/<video-id>/%05d.jpg
python -I ocr_frames.py --models MODELS --images frames --recursive --min-height 0.22 --skip-scene --out ocr.json
python -I make_events.py ocr.json --frames frames --out label     # events.json + labelling sheets
```
