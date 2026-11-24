# AR camera: how far away a display is read

Step 3 of [the plan](ar-recognition-plan.md): re-extract the public Bern videos of the display bench
(`rightside/tools/display-bench`) at 5 frames/s, keep far vehicles, and measure the reading rate by the display's glyph
height in pixels, for the bench's front end and the web's, with single frames and with 3-frame compositing. Then step
5's question: is the detector the bottleneck? Run 24 November 2026 on a PC; nothing here is a phone measurement.

## Method

- **Frames.** The bench's videos (1080p) at 5 frames/s, local evaluation only: neither videos nor frames are stored
  in the repository. YOLOE (`range_detect.py`, the bench's own settings) boxes every frame, with no minimum height.
- **Which vehicle is which** (`range_crops.py`). An IoU tracker follows boxes frame to frame and splits a track when
  the box height jumps by more than 35 %. A labelled pass of the 1 frame/s bench is tied to a track only if every one
  of its labelled frames lands on that one track, and only if no other labelled pass lands on it too; otherwise it is
  left out ("unknown"). The track's earlier frames (the far approach) inherit the label only through the tracker, so
  crops were spot-checked: one tie proved wrong (below).
- **Glyph height** without relying on reading that frame: per pass, the median over the track's frames of a whole
  vehicle (box not touching the picture's edge) of the height of the line its bench read names as the display, as a
  share of the box height (0.06–0.12 of the vehicle box; passes with fewer than three such reads are left out), times
  the box height in every frame. Missed frames stay in the denominator.
- **Front ends**, on the same crop of each frame (the vehicle's upper 55 %, 4 % wider, full resolution):
  the bench's (`ocr_frames.py`: PP-OCRv5 det + latin rec, the crop enlarged to 1600 px, at most twice) and the web's
  (`src/ppocr.ts`, in onnxruntime-web, `tools/range_eval.mts`), also with a 960 px detector input and on two aligned
  3-frame composites: the sharpest of the three, and their pixel-wise maximum.
- **Judged by** the display matcher (`src/arcore.ts`) against the bench's 39-service board: per view (right display,
  wrong display, neither), and per pass at a 0.6 s OCR cadence (every third frame) through `decide()`: when the right
  ride is first accepted, whether a wrong one ever is (the bench's trials: same line, same destination, two others),
  and whether the right ride is ever called wrong.

Development set: four videos, 56 labelled passes tied to a track (55 left out), 3,126 frames (1,149 of them with
the vehicle cut off by the picture's edge, kept for the passes but not in the per-view table).

## Results (development set)

One view at a time, share of frames naming the right display (no front end named a wrong one below 32 px):

| glyph height | frames | bench front end | web (`ppocr.ts`) | web, detector at 960 px | web, sharpest of 3 | web, max of 3 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 8–12 px | 83 | 18 % | 7 % | 7 % | 4 % | 1 % |
| 12–16 px | 127 | 50 % | 39 % | 40 % | 37 % | 7 % |
| 16–24 px | 402 | 59 % | 58 % | 56 % | 54 % | 26 % |
| 24–32 px | 264 | 67 % | 61 % | 64 % | 63 % | 30 % |
| 32–48 px | 571 | 63 % | 54 % | 60 % | 53 % | 21 % |
| ≥ 48 px | 526 | 77 % | 67 % | 71 % | 67 % | 23 % |

Passes, read every 0.6 s:

| front end | right ride accepted | glyph height at first acceptance (median / smallest) | wrong ride accepted | right ride called wrong (naming another service) |
| --- | ---: | --- | ---: | ---: |
| bench | 53 / 56 | 39 / 10 px | 0 / 179 | 3 (1) |
| web (`ppocr.ts`) | 50 / 56 | 39 / 10 px | 0 / 179 | 0 |
| web, max of 3 | 32 / 56 | 45 / 18 px | 0 / 179 | 0 |

- **Reading starts at about 10–12 px of glyph height** and is right about half the time from 12–16 px. A Bern tram's
  destination line is about a tenth of its box: 12 px glyphs at 1080p mean a vehicle about 120 px tall, roughly 30 m
  away for a 3.5 m tram with a phone's main camera (not measured; the plan makes no claim in metres).
- **Compositing does not help.** The maximum of three aligned frames halves the reading rate (LED rows and the
  rolling shutter smear); the sharpest of three is no better than the newest frame. The web keeps single frames.
- **The web's front end** was behind the bench's on small text until it enlarged small crops bicubically, as the
  bench does (`ppocr.ts`: 12–16 px 32 % → 39 %, passes 49 → 50). A larger detector input did not help.
- **Safety:** no wrong ride was accepted by either front end. The web's never called a right ride wrong. The bench's
  did three times: two contradictions that named nothing listed (which the app no longer paints red), and one pass
  whose track the tracker had joined to another tram: its crops show "3 Weissenbühl", not the labelled "7 Bümpliz"
  (a correspondence error of this pipeline, not a misread). Earlier in this work the web's front end read the right
  "7 Ostring" as "7 Detrina" twice in a row, which would have painted the right tram red: since then red needs a
  display that names something (`src/artrack.ts`).

## Detector (step 5)

The web reads displays only on vehicles its detector finds. Against YOLOE's boxes on 302 frames of labelled passes
(agreement with another detector, not recall: `tools/range_detector.mts`):

| vehicle height (share of the picture) | frames | COCO-SSD lite (was the web's) | COCO-SSD, two halves | COCO-SSD mobilenet_v2 | YOLOX-nano | YOLOX-tiny |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.10–0.15 | 26 | 15 % | 23 % | 27 % | 69 % | 96 % |
| 0.15–0.20 | 25 | 32 % | 32 % | 36 % | 84 % | 92 % |
| 0.20–0.30 | 34 | 56 % | 79 % | 65 % | 97 % | 100 % |
| 0.30–0.50 | 55 | 89 % | 95 % | 100 % | 98 % | 100 % |
| 0.50–1 | 158 | 93 % | 92 % | 89 % | 100 % | 99 % |
| ms per frame (PC, Node, one core) | | 1113 | 2220 | 1851 | 55 | 186 |

A vehicle 0.1–0.2 of the picture tall carries 10–20 px glyphs: exactly where displays become readable, COCO-SSD lost
two in three. That is the plan's condition for step 5, so the web's detector is now **YOLOX-nano** (Megvii,
Apache-2.0, off the shelf, `src/yolox.ts`, served from `models/yolox/`). YOLOX-tiny finds even more but is 5.5 MB more
and 3× slower; it is the next step if phones have the time. Not measured: false detections (frames without vehicles),
and speed on a phone (the debug line shows it).

## Held-out set

Run once, after every choice above was made (front end, single frames, bicubic enlarging): three of its four videos
(the fourth, two labelled passes, no longer offers a 1080p stream), 19 passes tied to a track (14 left out), 1,989
frames (855 with the vehicle cut off).

| glyph height | frames | bench front end | web (`ppocr.ts`) | web, max of 3 |
| --- | ---: | ---: | ---: | ---: |
| 8–12 px | 24 | 0 % | 0 % | 0 % |
| 12–16 px | 69 | 20 % | 17 % | 3 % |
| 16–24 px | 202 | 50 % | 42 % | 15 % |
| 24–32 px | 483 | 80 % | 72 % | 48 % |
| 32–48 px | 220 | 56 % | 51 % | 25 % |
| ≥ 48 px | 136 | 51 % | 49 % | 18 % |

| front end | right ride accepted | glyph height at first acceptance (median / smallest) | wrong ride accepted | right ride called wrong (naming another service) |
| --- | ---: | --- | ---: | ---: |
| bench | 14 / 19 | 26 / 15 px | 0 / 61 | 1 (1) |
| web (`ppocr.ts`) | 14 / 19 | 26 / 14 px | 0 / 61 | 1 (1) |

The held-out set reads later than the development set (about half the time from 16–24 px rather than 12–16 px) and
confirms the rest: the web's front end close to the bench's, compositing no help, no wrong ride accepted. The one right
ride called wrong (by both front ends, as "8 Saali") is the bench's own error: the video cuts from a "9 Wabern" tram
to an "8 Saali" one in another street, and the bench's tracker joined the two boxes across the cut (its crops show
both). A live camera has no cuts; a jump that size revokes the label in `src/artrack.ts` (fast pan, crossing).

## Limits

- Agreement with YOLOE is not recall; the bench's tracks come from YOLOE itself.
- The tracker's correspondence is checked by spot checks only; two wrong ties were found (a tram joined to the
  next one in the same spot, and one across a cut in the video). Every right ride the matcher called wrong with a
  name traced back to such a tie, not to a misread.
- Glyph size is a per-pass estimate; it does not see focus, glare or the LED scan.
- No metres: distance depends on the camera, the vehicle and the angle.
- Phone speed, heat, real camera exposure and rolling shutter: [ar-field-test.md](ar-field-test.md).

Reproduce: `rightside/tools/display-bench/range_detect.py`, `range_crops.py`, then `tools/range_eval.mts` and
`tools/range_detector.mts` (their headers say how).
