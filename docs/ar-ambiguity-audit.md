# AR camera: how often a display could mean more than one run

Step 2 of [the plan](ar-recognition-plan.md) asks: given the time, the boarding point, the direction, the line and
same-destination express/local pairs, how often is the rider's run the only one a vehicle display could stand for?
Its answer orders the later work. Script: `livemap/measure/ambiguity_audit.py`, on the timetable (no live data) of an
engine built from this branch, Wednesday 25 November 2026, run 24 November.

## Method

- 295 stations with their own boarding points in 12 city centres (Bern, Zürich, Basel, Genève, Lausanne, Luzern,
  St. Gallen, Winterthur, Lugano, Biel, Thun, Chur), at 07:30, 12:00, 17:30 and 21:00.
- 6,530 rider runs: up to 10 runs leaving each station within 15 minutes, each with a real later stop of its own
  (one of its next 15) as the rider's destination.
- A **same-display rival** is another run at the station, within the time window, with the same line and a destination
  a display could show the same way. The audit's rule is looser than the app's (any of the matcher's full renderings
  of the name at least 0.85 alike, the app uses 0.9 with an LED-aware distance), so it finds at least the rivals the
  app would; an earlier run with exact names only found a fifth as many unsafe ones (0.1 % within ±10 minutes).
- A rival is **safe** when riders may board it here and it lets them off at the rider's stop (`/api/due` `pickup`,
  `servesTo`). Vehicles that only set down here are found among those under way within 4 km at some moment of the
  window. For unsafe rivals the audit also records whether the boarding point or the timetable direction (the next
  stop's bearing, more than 45° apart) would tell the two apart.
- Runs whose board was cut at its limit (200 entries) are counted apart, never as unique.
- **Destination shared by another line**: a run whose destination another line shows too, so only the numeral tells it
  apart.

## Results

| mode | runs | window | board cut | unique | all rivals safe | unsafe rival | …boarding point tells | destination shared by another line |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| all | 6,530 | ±5 min | 1.1 % | 89.3 % | 9.0 % | 0.6 % | 87 % | 11.5 % |
| all | 6,530 | ±10 min | 1.1 % | 33.8 % | 64.5 % | 0.7 % | 87 % | 14.4 % |
| all | 6,530 | ±20 min | 1.1 % | 10.9 % | 86.8 % | 1.2 % | 74 % | 16.1 % |
| bus | 4,710 | ±10 min | 1.1 % | 39.9 % | 58.0 % | 1.0 % | 87 % | 14.6 % |
| tram | 1,432 | ±10 min | 1.1 % | 10.1 % | 88.8 % | 0 % | – | 16.9 % |
| train | 180 | ±10 min | 0 % | 100 % | 0 % | 0 % | – | 7.8 % |

- **Unsafe rivals are rare:** 0.7 % of rider runs within ±10 minutes (47 runs; 39 rivals skip the rider's stop, 8 may
  not be boarded here), 1.2 % within ±20; none for trams or trains. The boarding point tells most of them apart.
- **Same-display rivals are common but harmless:** within ±10 minutes two in three runs share their display with
  another run that also takes the rider to their stop; trams in Zürich and Bern nearly always.
- **The numeral matters:** 11–16 % of runs share their destination with another line, so a display read without its
  number cannot be told apart. The matcher already treats that as ambiguous.
- By city at ±10 minutes, unique runs range from 3 % (Zürich) to 77 % (Biel).

## What it means for the build order

- The label rules in `src/artrack.ts` already withhold green exactly where it matters: any same-display run on the
  board that cannot be boarded here or does not serve the rider's stop makes the label neutral. In the other 99 % of
  runs, every vehicle showing the rider's display takes them there, so green is right whichever it is.
- Step 4 (a per-track posterior and assignment) could only choose between same-display runs, which look the same to a
  camera, by timing or position. The planning review (GPT Astra, Gemini Neon, 24 November) found those terms
  unjustified without field data, and found that ordering the banner by a camera track's posterior would be an amber
  label by another name. **Step 4 is deferred**: nothing here needs it, and it could only add risk. Two cheap
  follow-ups the numbers point to: a board-only line in the banner when an unsafe same-display run is due ("a 10 →
  Rüti that does not stop at X is due too"), and, since the boarding point tells most unsafe rivals apart, leaving a
  rival at another boarding point out of the green rule once boarding points are known reliably (not before: the
  rider may stand at the wrong one).
- The numeral case argues for step 3's reading-range work: a far display read without its number gives nothing.

Not covered: live disruptions (replacement buses, short workings announced live), other days, rural stops. The `due`
archive (`livemap/measure/due_archive.py`) records the live side.
