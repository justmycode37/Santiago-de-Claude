# Search evaluation

Scores the search bar against about 2,100 queries for 424 real targets, the way people type them, and grades what
the first rows show. It is the before/after measure for changes to the search: offline, the same numbers every run.

```bash
npm run search-eval                                   # score the page's search, and Kante's /api/search alone
npm run search-eval -- --group stop --show 10         # one group, with ten cases it gets wrong
npm run search-eval -- --update-baseline              # after a change that is meant to move the numbers
```

## How the cases are made

1. **`make-targets.mts`** picks 424 targets from data the search does not ask, so where the right answer lies is
   known: stops of every kind, stations and platforms from ATLAS (`platforms.js`), addresses, named places and kinds
   of place from OpenStreetMap's amenities across Switzerland (`data/ch/`), towns and postcodes. → `targets.json`
2. **Subagents** (GPT-6.2 Sol, reasoning high, ten batches) write five queries per target as people would type them:
   `exact`, `casual`, `partial` (stopped mid-word), `typo`, `alias` (Genf, HB, Gare de …), `descriptive`
   ("Thun train station", "nächste Apotheke"), and say whether a query only makes sense on the spot. They see the
   names, never the coordinates. → `queries/batch-*.jsonl`
3. **`build-cases.mts`** joins the two: a query that only makes sense on the spot is asked with the map near its
   target, one that says where with the map in another town. → `cases.json`

## How they are scored

- **`eval.mts`** runs every case through the page's own `search()` (`src/app/search-places.ts`, the parts of the
  page it imports stubbed, as in `tools/test_walkguess.mts`) and through the Kante engine's `/api/search` alone.
  The rank of a case is where the first right answer is in the list (within the first ten): **top1**, **top3** (the
  rows shown before "Show more"), **top10**, **MRR**, **empty**; per kind of target and per way of typing.
- **`answers.json.gz`** holds the sources' answers (swisstopo, Kante), with only the fields the page reads, and a
  run replays them. `--record` asks for those missing (about 2 minutes; `--shard k/n` for runs side by side).
- **Photon is left out** unless `--photon` is given: its public server shuts out a client that asks more than about
  once a second, so recording it takes hours. Without it the page's place names and kinds of place score low, as
  the page does when Photon does not answer.
- **`baseline.json`** is the rank of every case at the last `--update-baseline`; a run shows the change in top-3
  share (Δ) and the cases that left the top 3. `--check` exits 1 when the page's top-3 share fell.

## The judges

A rank says whether the right answer is there; the judges say how good the list is to the person (the town instead
of the stop, a nearer branch, a pharmacy 4 km away). `--judge-out <file>` writes the lists not graded yet: the
query, what was wanted, where the map is and the first three rows, each keyed by all of that. Subagents grade each
0–3 into `judged/*.jsonl`, and every run shows the mean grade per group. A change to the search changes only some
lists, so only those need grading again: run, `--judge-out`, have them graded, run.

## Rebuilding

New targets: `node tools/search-eval/make-targets.mts --out <dir>` (the subagents' batches go to `<dir>`), queries
from the subagents into `queries/`, `node tools/search-eval/build-cases.mts`, then `--record` and
`--update-baseline`. A full `--record` drops the answers no case asks for.
