# AR camera: labels on the public-video bench

After a replay demo the product owner asked for three things: a vehicle once identified should stay identified while
it passes ("the tram hasn't changed"), two trams side by side should not be one box, and far fewer vehicles should be
left uncertain. This measures the web camera's labels (`src/artrack.ts`, the code the phone runs) on the bench of
[ar-reading-range.md](ar-reading-range.md), before and after. Run 24–25 November 2026 on a PC; no phone measurement.

## Method (`tools/ar_bench.mts`)

- **Frames:** the bench's labelled passes (dev 40, held-out 23 after the two fixes below), with 10 frames either side,
  at 5 frames/s from the public 1080p videos (local only, nothing committed).
- **Detector and reader, cached once:** YOLOX nano, tiny and tiny with 8-bit weights on every frame; the web's PP-OCR
  reader on every detected vehicle's display band and the road band every third frame (0.6 s, its pace on a phone).
- **Session, replayed:** `createArSession` gets every frame's boxes and, every 0.6 s, the read of the region its own
  `readTarget()` picks (one vehicle, or the road band), as the phone does. The board is the bench's 39 Bern services,
  complete and fresh, every run serving the rider's stop (so this measures the camera, not the board rules).
- **Riders:** for each pass, one rider waiting for its service and one for another service of the same line.
- **Judged per frame a labelled vehicle is in view** (its reference box from the bench's YOLOE tracker): the label on
  the best-overlapping box. *Certain* = green for its own rider, red for the other; *white* = display text only;
  *nothing*; **WRONG** = green for the other rider, red for its own. Separately, a **colour on a box over two
  vehicles**: any green or red on a box holding 60 % or more of two reference boxes that are not nested in each other
  (the reference detector also boxes parts of one tram), however well it fits the bigger one.
- **Two fixes to the bench's own ties,** found because the camera named the vehicle "wrong" and the frames showed it
  right: two passes run across a cut in the video into another street (QfULTK 203: a 3 → Weissenbühl before
  frame 4479; SFXY 71: an 8 → Saali from frame 74). The cuts also reset the session, as a phone never jumps streets.
  [ar-reading-range.md](ar-reading-range.md) had found both as "the matcher was right about the vehicle in the box".

## Results

| set | version | own rider: green | other rider: red | other rider: white | after first certain, still certain | wrong colour | colour on a box over two vehicles (moments) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dev | before (nano) | 21.9 % | 8.6 % | 5.6 % | 32 % | 0 | 3 |
| dev | now, nano | 32.2 % | 18.2 % | 1.8 % | 60 % | 0 | 1 |
| dev | **now, tiny int8** | **37.2 %** | **27.4 %** | 2.9 % | **69 %** | 0 | **0** |
| held-out | before (nano) | 32.2 % | 19.0 % | 7.3 % | 43 % | 0 | 12 |
| held-out | now, nano | 49.1 % | 38.9 % | 4.8 % | 73 % | 0 | 13 |
| held-out | **now, tiny int8** | **54.2 %** | **42.8 %** | 2.8 % | **83 %** | 0 | **3** |

(Shares of the frames the labelled vehicle is in view. On this bench's complete board the own rider's display is green or
nothing, never white. Frames: dev 2,450 own + 6,792 other; held-out 2,640 + 5,090.)

- **Remembering** is most of the gain: once a vehicle was certain, it now stays certain 69–83 % of the frames it is
  in view, against 32–43 % before. The rest is mostly the vehicle leaving the detector (very close, cut off at the
  edge) or a guard forgetting on purpose.
- **YOLOX-tiny** finds more far vehicles (under 0.15 of the picture tall: 8–18 % certain against 0–4 % before) and
  draws a box over two vehicles less than half as often (dev: 147 of 14,928 label boxes against 371 of 12,732). With
  8-bit weights it is 5 MB (nano 3.7 MB, tiny 20 MB) and on a PC in onnxruntime-web takes 48 ms a picture (4 threads;
  nano 22, tiny 60). The page falls back to nano if it averages over 220 ms on the phone.
- **White** is rarer (3 % of the other rider's frames, from 6–7 %): mostly a red's first frame (a red needs two).
- **Boxes over two vehicles,** looked at frame by frame: with tiny, of the three held-out moments two are the reference
  detector boxing two parts of one tram passing close (SFXY 94, 115); one is real (03aY 166): the box of an 8 →
  Saali also takes in a small tram behind it, which the detector did not box on its own in that frame, so nothing
  could tell (one frame, 0.2 s; the next frame the containment veto holds). Before, held-out had 12 such moments.
  With nano (the fallback) the flags stay about as before (13): nano boxes more pairs as one.
- Most frames are still *nothing*: vehicles too far to read (glyphs under ~12 px), or seen from the side before their
  display was ever read. Reading range is [ar-reading-range.md](ar-reading-range.md)'s subject.

## What changed (`src/artrack.ts`)

- **Memory:** a vehicle's display is remembered once two pictures within 6 s match the same listed display and none
  names another, or, for green only, one very clear picture (strength ≥ 0.8). It stays through garbled and unreadable
  reads for 20 s after the last picture that said it again. Only what each picture says on its own counts, so a
  garbled read right after a good one adds nothing. The colour is still decided against the live board at every
  moment. One contradicting picture hides it until a later one says it again; a second forgets it.
- **Review fixes (GPT Astra, Gemini Neon):** nothing is remembered on a stale or incomplete board, near a read of
  two displays in the box, or on a box holding another vehicle's; a memory is checked again against its own pictures
  when the board's departures change; each read counts at its own capture moment (late ones too); with only the
  rider's display listed, a sharp exact read still counts. Two reads of one stalled video picture are one frame (`src/pictime.ts`: the moment
  the picture was shown, from requestVideoFrameCallback); two reads of one picture joined are checked again for two
  displays; a remembered red is dropped when the board no longer lists that departure; a detector that keeps failing
  falls back to nano and backs off.
- **Guards:** a crossing, an ambiguous match, a fast pan, or a vehicle seen more than once vanishing into the box
  forgets everything. A one-detection box smaller than half of a remembered vehicle's box is flicker on a part of it
  (a tram's rear section as it turns), which was the commonest reason labels were lost. A box growing or shrinking
  beyond one vehicle's change on the bench at that time step (width p99.5, height p99.9) hides a remembered label
  until read again and drops any other. A box holding most of another
  vehicle's box gets no colour (the held-out failure above). Two text groups in one box that each match a listed
  display mean two vehicles: no label.
- **Reading order:** vehicles not yet known first, a known one again every 1.5 s, the road band every fourth turn.

## What can be here (25 November)

The owner asked to use what is known besides the display (which vehicles can be here now, which way they go, tram
or bus) to settle half-read displays, and to try pixel masks instead of boxes. Planned with GPT Astra and Gemini Neon,
who agreed on the line drawn here: setting a departure aside because of its time is the same as adding evidence for
the ones left, so a late, early or unlisted vehicle would get the wrong green. Context may choose a name or what to
read next, never a colour.

| set | version | own rider: green | other rider: red | other rider: white | after first certain, still certain |
| --- | --- | ---: | ---: | ---: | ---: |
| dev | before (memory, tiny) | 37.2 % | 27.4 % | 2.8 % | 69 % |
| dev | **"not yours, whichever it is"** | 37.2 % | **28.5 %** | 2.2 % | 70 % |
| held-out | before | 54.2 % | 42.8 % | 2.8 % | 83 % |
| held-out | "not yours, whichever it is" | 54.2 % | 42.8 % | 2.8 % | 83 % |

No wrong colour, and every red names the vehicle's own service or a group holding it. Kept: the "not yours" rule
(arcore `notYours`): a read as clear as one the matcher accepts on its own, fitting at most three other departures
about equally and the rider's display clearly not (never among them nor close), counts for red naming all of them
("Not yours: 9/19 → Wabern, Tram-Endstation", the likelier in view now first; different destinations: each line with
its own). Live times only order that name. Display bench (`tools/test_arcore.mts`, phone mode): wrong vehicles
flagged 223 → 226 of 349 (dev), 75 → 77 of 113 (held-out), right ones accepted unchanged, none wrong.

The first version did more (dev red 35 %) and was taken back after the reviews (GPT Astra, Gemini Neon) showed how it
could go wrong: a loose read ("abern" at 0.77, or a "via" row of the rider's own route) could put red on the rider's
own vehicle; naming one departure by its live time changed which frames agreed, so timing changed colours; a guessed
LED digit ("y" for 9) could give a one-frame wrong green; group names could collide with real lines ("1/9" and 19).
So "abern" alone stays unlabelled; a clean "Wabern" or the line number settles it.

Tried and left out, measured:

- **Reading the line number again** with room beside the destination (`ppocr.ts`): 14 numbers recovered on labelled
  vehicles, all right, but no gain (dev green 37.0 → 36.2 %, held-out white 2.5 → 4.5 %) for up to three more
  recogniser runs per read. On these LED displays the 9 is not missed but read as "y" or "3"; treating those as a
  possible 9 was also tried and dropped (it can turn a 19 or another line's display into a wrong match).
- **Pixel masks** (torchvision LR-ASPP MobileNetV3, BSD, VOC bus and train, 13 MB, 37–68 ms a frame on a PC in
  onnxruntime-web): good outlines of trams seen from the side, but two touching trams are one blob (it cannot tell
  vehicles apart, which was the reason to want it) and a close head-on tram is missed. Boxes stay.
- **Setting departures aside by time, position or direction:** not done (above). `/api/vehicles` positions are the
  same timetable forecast drawn on a map, not independent evidence; the compass near trams and box motion are too
  unreliable to rule a direction out. A rule that sets aside only trips measured past this stop minutes ago would be
  safe but changes little; it needs the `due` archive's numbers first.

## Process and limits

- Planned with GPT Astra and Gemini Neon (their advice: remember the display, not the colour; suspend on the first
  contradiction; diagnose before changing models; a coloured merged box counts as wrong). Tuned on dev only.
- **The held-out set is no longer untouched:** its first run found the coloured merged box (a real failure, also in
  the code before) and the second cut; the box veto and the bench fix came from that, then it was run again. A fresh
  video set should confirm.
- Zero wrong labels is a small sample: 63 passes, each seen by its own rider and by riders of other services in the
  same scene (not independent); with zero errors in about 130 independent encounters the one-sided 95 % upper bound
  would still be about 2 %. Vehicles without a bench label are never judged: a colour on one of them is not counted.
- **Known gaps** (code review, GPT Astra): a vehicle seen in one detection only, inside a remembered vehicle's box,
  that the box then takes in without growing, is taken for flicker, so the colour comes back on a box over both
  (requiring flicker to stick out of the box closed this but cost a third of the gain and changed nothing on the
  bench); a merge the detector never splits (03aY 166 above). The display reads still decide the text; the box can be
  too big.
- The reference boxes and ties come from YOLOE and the bench's IoU tracker, not from people; spot checks found two
  wrong ties (fixed above).
- Not on a phone: detector and reader time, real exposure, the gyro, 3 rather than 5 detections a second
  ([ar-field-test.md](ar-field-test.md)). The native iOS app has its own tracker and is not changed here.

Reproduce: `tools/ar_bench.mts` (its header), after `range_detect.py` and `range_crops.py`; `tools/quantize_yolox.py`
makes the 8-bit model.
