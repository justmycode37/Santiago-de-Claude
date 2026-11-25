# Reference walks

A fixed set of 149 walks in ten city centres (`refwalks.json`), checked by eye, and a tool that scores an engine
against it. It measures what the national comparisons (`../compare`) cannot: whether a walk is the one a person
would take, not only whether it differs from `main`'s.

## The set

- **Walks**: between addresses of the official building address register (a third from the main station), 200 m –
  1.5 km apart, in Bern, Zürich, Basel, Geneva, Lausanne, Luzern, Winterthur, St. Gallen, Lugano and Biel; 45 of
  them step-free (wheelchair). Data: OpenStreetMap Switzerland of 21 November 2026, the register of 24 November.
- **Chosen by what `main` got wrong** (`select.py`, from 900 candidates of `mine.py`): 45 walks that walk 30 m or
  more on carriageways whose sidewalks are drawn apart, 30 that walk over a busy road from a footway where no
  crossing is mapped, 24 that end at another door than this change's, 20 with many turns, 30 controls.
- **Checked by eye** (`render.py`, `verdict.py`): each walk drawn by `main` (red) and by this change (blue) over
  swisstopo's aerial image (SWISSIMAGE) with the mapped ways, crossings and doors, with close-ups of where the two
  differ; a checker who did not know which is which judged which a careful local walker would take (sidewalk
  rather than carriageway, crossing at crossings, no zig-zag or detour, the front door). Checked 24 November 2026
  by Claude Sonnet 5.5 subagents: 34 times this change's walk, 4 times `main`'s, 109 both fine, 2 unclear; many
  of the "both" with low confidence (the aerial image does not always show a kerb or a gate).
- **Golden walks**: the 24 where one walk was judged right with medium or high confidence. The check stores what
  the right walk does that the wrong one does not: the OpenStreetMap ways only it uses (`must_use`, metres), the
  ways only the wrong one used (`must_avoid`), and its door. The other walks are scored only by what they walk on.

The set is frozen: the walks, their ends and their checks do not change when the engine does. Unverified claims are
not scored (the "both", "unclear" and low-confidence walks are not golden).

## Scoring

```bash
python3 -I score.py --set refwalks.json --engine http://127.0.0.1:8092 --data DATA --bin path/to/compare --out score.json
```

`compare metrics` matches a walk's line to the graph within 5 cm: run the engines it measures with
`KANTE_WALK_RULES_OFF=kerb`, else walks along roads are drawn at the road's edge and count as off the network.

A golden walk passes when it uses at least 70 % of the metres of the right walk's own ways, at most 15 m of the
wrong walk's, and ends within 5 m of the right door. Reported by category, city, profile and the checker's issue,
each failure listed (a gain in one place never hides a loss in another). For every walk: metres on carriageways
whose sidewalks are drawn apart, on busy carriageways and car-only roads, busy roads walked over without a mapped
crossing, `crossing=no` passed, metres on closed ways, turns, length and time (`compare metrics`: the walk's line
matched to the graph of DATA). `--time 2026-11-24T23:30` asks every walk for that time (opening hours).

## Making a set again

```bash
python3 -I mine.py --a A --b B --data DATA --bin compare --out DIR        # 900 candidates
python3 -I select.py --candidates DIR/candidates.json --out refwalks.json
python3 -I render.py --set refwalks.json --a A --b B --data DATA --bin compare --out IMG
# check the pictures (verdicts/<n>.jsonl: id, verdict A|B|both|neither|unclear, confidence, issue, reason)
python3 -I verdict.py --set refwalks.json --verdicts DIR --walks IMG/walks.json --data DATA --bin compare
```

Images: © swisstopo (SWISSIMAGE), map data © OpenStreetMap contributors.
