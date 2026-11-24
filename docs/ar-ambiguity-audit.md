# AR camera: how often a display could mean more than one run

Step 2 of [the plan](ar-recognition-plan.md) asks: given the time, the boarding point, the direction, the line and
same-destination express/local pairs, how often is the rider's run the only one a vehicle display could stand for?
Its answer orders the later work. Script: `livemap/measure/ambiguity_audit.py`, on the timetable (no live data) of an
engine built from this branch, Wednesday 25 November 2026, run 24 November.

## Method

- 295 stations with their own boarding points in 12 city centres (Bern, Zürich, Basel, Genève, Lausanne, Luzern,
  St. Gallen, Winterthur, Lugano, Biel, Thun, Chur), at 07:30, 12:00, 17:30 and 21:00.
- 6,535 rider runs: up to 10 runs leaving each station within 15 minutes, each with a real later stop of its own
  (one of its next 15) as the rider's destination.
- A **same-display rival** is another run at the station, within the time window, with the same line and destination.
  It is **safe** when riders may board it here and it calls at the rider's stop (`/api/due` `pickup`, `servesTo`).
  For unsafe rivals the audit also records whether the boarding point or the timetable direction (the next stop's
  bearing, more than 45° apart) would tell the two apart.
- **Destination shared by another line**: a run with the same destination under another line number, so only the
  numeral tells it apart.

## Results

| mode | runs | window | unique | all rivals safe | …one on another route | unsafe rival | destination shared by another line |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| all | 6,535 | ±5 min | 91.2 % | 8.8 % | 0.2 % | 0.1 % | 6.4 % |
| all | 6,535 | ±10 min | 34.3 % | 65.6 % | 0.6 % | 0.1 % | 9.1 % |
| all | 6,535 | ±20 min | 11.5 % | 88.2 % | 0.6 % | 0.2 % | 10.5 % |
| bus | 4,714 | ±10 min | 40.6 % | 59.3 % | 0.9 % | 0.1 % | 9.7 % |
| tram | 1,426 | ±10 min | 9.8 % | 90.2 % | 0 % | 0 % | 8.8 % |
| train | 185 | ±10 min | 100 % | 0 % | – | 0 % | 6.5 % |

("…one on another route": of the runs whose rivals are all safe, those where a rival leaves for another next stop, a
variant of the line that happens to serve the rider's stop too.)

- **Unsafe rivals are rare:** 16 of 6,535 rider runs within ±20 minutes (0.2 %), 0.1 % within ±10. Of the five
  within ±10 minutes, four were rivals riders may not board here (set-down-only calls) and one skipped the rider's
  stop; the boarding point or the timetable direction told only one of them apart.
- **Same-display rivals are common but harmless:** within ±10 minutes two in three runs share their display with
  another run, almost all of which take the rider to their stop too (trams in Zürich and Bern nearly always).
- **The numeral matters:** 6–10 % of runs share their destination with another line, so a display read without its
  number cannot be told apart. The matcher already treats that as ambiguous.
- By city at ±10 min, unique runs range from 3 % (Zürich) to 78 % (Biel); unsafe rivals appear only in Genève,
  Thun and Winterthur (0.2–0.5 %).

## What it means for the build order

- The label rules in `src/artrack.ts` already withhold green exactly where it matters: any same-display run on the
  board that cannot be boarded here or does not serve the rider's stop makes the label neutral. In the other 99.8 %
  of runs, every vehicle showing the rider's display takes them there, so green is right whichever it is.
- Step 4 (a per-track posterior and assignment) could only choose between same-display runs, which look the same
  to a camera, by timing or position. The planning review (GPT Astra, Gemini Neon, 24 November) found those terms
  unjustified without field data, and found that ordering the banner by a camera track's posterior would be an
  amber label by another name. **Step 4 is deferred**: nothing in these numbers needs it, and it could only add risk.
  If field captures or the `due` archive later show unsafe rivals are commoner than here, a board-only warning in
  the banner ("another 10 → Rüti that does not stop at X is due") is the first thing to add.
- The numeral case (6–10 %) argues for step 3's reading range work: a far display read without its number gives
  nothing.

Not covered: live disruptions (replacement buses, short workings announced live), other days, rural stops. The
`due` archive (`livemap/measure/due_archive.py`) records the live side.
