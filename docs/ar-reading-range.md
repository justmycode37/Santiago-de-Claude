# AR camera: how far away a display is read

Step 3 of [the plan](ar-recognition-plan.md): re-extract the public Bern videos of the display bench
(`rightside/tools/display-bench`) at 5 frames/s, keep far vehicles, and measure the reading rate by the display's glyph
height in pixels, for the bench's front end and the web's, with single frames and with 3-frame compositing. Then step
5's question: is the detector the bottleneck? Run 24 November 2026 on a PC; nothing here is a phone measurement.

## Method

- **Frames.** The bench's videos (1080p) at 5 frames/s, local evaluation only: neither videos nor frames are stored
  in the repository. YOLOE (`range_detect.py`, the bench's own settings) boxes every frame, with no minimum height.
- **Which vehicle is which** (`range_crops.py`). An IoU tracker follows boxes frame to frame and splits a track when
  the box height jumps by more than 35 %. A labelled pass of the bench is tied to a track only if every labelled frame
  of it that has a vehicle lands on that one track, and no other labelled pass lands on it too; otherwise it is left
  out ("unknown"). The track's other frames (the far approach) inherit the label through the tracker only, so crops
  were spot-checked: two ties proved wrong (below).
- **Glyph height**, independent of reading that frame: per pass, the median over the track's frames of a whole vehicle
  (box not touching the picture's edge) of the height of the line its bench read names as the display, as a share of
  the box height (0.06–0.12), times the box height in every frame. Missed frames stay in the denominator. A pass with
  fewer than three such reads has no size: it is left out of the per-view curve but stays in the per-pass trials.
- **Front ends**, on the same crop of each frame (the vehicle's upper 55 %, 4 % wider, full resolution): the bench's
  (`ocr_frames.py`: PP-OCRv5 det + latin rec, the crop enlarged to 1600 px, at most twice) and the web's (`src/ppocr.ts`
  in onnxruntime-web, `tools/range_eval.mts`), also with a 960 px detector input and on two aligned 3-frame composites:
  the sharpest of the three, and their pixel-wise maximum.
- **Judged by** the display matcher (`src/arcore.ts`) against the bench's 39-service board: per view (right display,
  wrong display, neither), and per pass at a 0.6 s OCR cadence (every third frame) through `decide()`: when the right
  ride is first accepted, whether a wrong one ever is (the bench's trials: same line, same destination, two others),
  and whether the right ride is ever called wrong, and if so whether naming another service (red in the app).

## Results

Development set: four videos, 40 passes tied to a track (71 left out; 10 without a size), 2,450 frames (1,141 with
the vehicle cut off by the picture's edge, in the per-pass trials only). Held-out set, run once after every choice
below was made: three of its four videos (the fourth, two labelled passes, no longer offers a 1080p stream),
23 passes (10 left out; 2 without a size), 2,640 frames (1,176 cut off).

One view at a time, share of frames naming the right display:

| glyph height | dev: frames | bench | web | web, 960 px detector | web, sharpest of 3 | web, max of 3 | held-out: frames | bench | web |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8–12 px | 78 | 13 % | 5 % | 5 % | 5 % | 2 % | 24 | 0 % | 0 % |
| 12–16 px | 119 | 48 % | 37 % | 38 % | 35 % | 6 % | 99 | 25 % | 25 % |
| 16–24 px | 241 | 55 % | 56 % | 55 % | 50 % | 24 % | 259 | 45 % | 39 % |
| 24–32 px | 150 | 55 % | 47 % | 49 % | 48 % | 21 % | 590 | 79 % | 73 % |
| 32–48 px | 349 | 54 % | 43 % | 49 % | 43 % | 14 % | 297 | 61 % | 57 % |
| ≥ 48 px | 232 | 65 % | 53 % | 61 % | 51 % | 21 % | 171 | 57 % | 57 % |

Passes, read every 0.6 s:

| set, front end | right ride accepted | glyph height at first acceptance (median / smallest) | wrong ride accepted | right ride called wrong (naming another service) |
| --- | ---: | --- | ---: | ---: |
| dev, bench | 32 / 40 | 28 / 11 px | 0 / 124 | 2 (1) |
| dev, web (`ppocr.ts`) | 28 / 40 | 24 / 14 px | 0 / 124 | 0 |
| dev, web, 960 px detector | 30 / 40 | 24 / 14 px | 0 / 124 | 0 |
| dev, web, max of 3 | 18 / 40 | 39 / 18 px | 0 / 124 | 0 |
| held-out, bench | 17 / 23 | 26 / 13 px | 0 / 73 | 1 (1) |
| held-out, web (`ppocr.ts`) | 16 / 23 | 26 / 13 px | 0 / 73 | 1 (1) |

- **Reading starts at about 12 px of glyph height**: from 12–16 px a single view names the right display a quarter to
  half the time, and the median pass is first accepted at about 25 px. A Bern tram's destination line is about a tenth
  of its box: 12 px glyphs at 1080p mean a vehicle about 120 px tall, very roughly 30 m away for a 3.5 m tram with a
  phone's main camera (not measured; the plan makes no claim in metres).
- **Compositing does not help.** The maximum of three aligned frames halves the reading rate (LED rows and the
  rolling shutter smear); the sharpest of three is no better than the newest frame. The web keeps single frames.
- **The web's front end** is close to the bench's from 16 px up and behind it below. Enlarging small crops
  bicubically, as the bench does, closed part of the gap (`ppocr.ts`, measured before the stricter tie rule: 12–16 px
  32 % → 39 %). A 960 px detector input reads a little more at 32 px and above (2 more passes of 40) for 2.25 times
  the detector's work; the web stays at 640 until a phone shows the time is there.
- **Safety:** no wrong ride was accepted by either front end on either set. The web's front end called a right ride
  wrong once, on the held-out set, as did the bench's; with a name, on both sets, only where the bench's own tracker had
  joined two trams: one pass across a cut in the video ("9 Wabern" to an "8 Saali" in another street) and one where
  another tram followed in the same spot ("3 Weissenbühl" on a "7 Bümpliz" pass). Their crops show the named display:
  the matcher was right about the vehicle in the box. The other flags named nothing listed, which the app no longer
  paints red. Earlier in this work the web's front end read the right "7 Ostring" as "7 Detrina" twice in a row, which
  would have painted the right tram red: since then red needs text that names something (`src/artrack.ts`).

## Detector (step 5)

The web reads displays only on vehicles its detector finds. Against YOLOE's boxes on 307 frames of labelled passes
(agreement with another detector, not recall; `tools/range_detector.mts`), share of frames where the detector finds
the labelled vehicle, by its height in the picture:

| vehicle height | frames | COCO-SSD lite, 0.5 (the web before) | COCO-SSD lite, 0.3 | COCO-SSD, two halves | COCO-SSD mobilenet_v2 | YOLOX-nano, 0.3 | YOLOX-nano, 0.5 | YOLOX-tiny, 0.3 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.10–0.15 | 14 | 21 % | 36 % | 21 % | 29 % | 50 % | 43 % | 100 % |
| 0.15–0.20 | 26 | 15 % | 31 % | 35 % | 31 % | 77 % | 65 % | 96 % |
| 0.20–0.30 | 46 | 61 % | 72 % | 70 % | 61 % | 91 % | 89 % | 98 % |
| 0.30–0.50 | 52 | 90 % | 96 % | 98 % | 88 % | 100 % | 98 % | 98 % |
| 0.50–1 | 167 | 89 % | 94 % | 87 % | 84 % | 90 % | 87 % | 93 % |
| boxes on no YOLOE vehicle, per frame | | 0.00 | 0.01 | 0.08 | 0.00 | 0.03 | 0.02 | 0.09 |
| ms per frame (PC, Node, one core) | | 1100 | 1102 | 2222 | 1822 | 55 | 53 | 179 |

A vehicle 0.1–0.2 of the picture tall carries 10–20 px glyphs: exactly where displays become readable, COCO-SSD lost
most of them, also at the same threshold as YOLOX. That is the plan's condition for step 5, so the web's detector is
now **YOLOX-nano** at 0.3 (Megvii, Apache-2.0, off the shelf, `src/yolox.ts`, served from `models/yolox/`), its class
taken as the best of all 80 COCO classes (a truck is a truck). Its boxes on no vehicle stay rare (0.03 a frame), and
an extra box costs only work: no label without a display read. YOLOX-tiny finds more of the small ones still, for
three times the time and 5.5 times the size: the next step if phones have the time (the debug line shows it).

## Limits

- Agreement with YOLOE is not recall; the bench's tracks come from YOLOE itself.
- The tracker's correspondence is checked by spot checks only; two wrong ties were found, both after the labelled
  frames (which the tie rule cannot see).
- Glyph size is a per-pass estimate; it does not see focus, glare or the LED scan.
- No metres: distance depends on the camera, the vehicle and the angle.
- Phone speed, heat, real camera exposure and rolling shutter: [ar-field-test.md](ar-field-test.md).

Reproduce: `rightside/tools/display-bench/range_detect.py`, `range_crops.py`, then `tools/range_eval.mts` and
`tools/range_detector.mts` (their headers say how).
