# Search evaluation

Scores the search bar against about 2,100 queries whose right answers come from data the search does not ask:
the stops and platforms of ATLAS (`platforms.js`) and OpenStreetMap's amenities across Switzerland (`data/ch/`).
It is the before/after measure for changes to the search: offline, the same numbers on every run.

```bash
npm run search-eval                         # score the page's search (and Kante's /api/search alone)
npm run search-eval -- --group stop-typo --show 10   # one group, with ten cases it gets wrong
npm run search-eval -- --update-baseline    # after a change that is meant to move the numbers
```

## How it works

- **`make-cases.mts`** writes `cases.json`, seeded so the same data gives the same cases. Each case is a text,
  where the map is (its middle is also where distances are measured from) and the points one of which a right
  answer lies within `m` metres of.
- **`eval.mts`** runs every case through the page's own `search()` (`src/app/search-places.ts`, the parts of the
  page it imports stubbed, as in `tools/test_walkguess.mts`) and through the Kante engine's `/api/search` on its own.
  The score of a case is the place of the first right answer in the list (1 = the top row), within the first ten.
- **`answers.json.gz`** holds the sources' answers (swisstopo, Photon, Kante), keyed by the request, with only the
  fields the page reads. A run replays them. `--record` asks the sources for those not recorded yet (paced, one
  request at a time per server) and adds them; `--shard k/n` lets n recordings run side by side. A source that
  does not answer is not recorded: run `--record` again later.
- **`baseline.json`** is the rank of every case at the last `--update-baseline`. A run shows the change in top-3
  share per group (Δ) and the cases that left the top 3. `--check` exits 1 when the page's top-3 share fell.

The columns: **top1**, **top3** (the three rows the list shows before "Show more"), **top10**, **MRR** (mean of
1/rank), **empty** (no results at all).

## The groups

| group | what is typed | right when |
|---|---|---|
| `stop-exact` | an ATLAS stop's name, "Bern, Zytglogge" (trains, trams, buses, boats, cable cars) | within 120 m of the stop (250 m for a station) |
| `stop-casual` | the same as people type it: lower case without the comma, the stop's own name without the town (map nearby), ae/oe/ue, no accents | as above |
| `stop-prefix` | the last word cut short: "Bern, Zytgl" | as above |
| `stop-typo` | one letter swapped, left out, wrong or added in a word of five letters or more | as above |
| `station-alias` | "Bahnhof Thun", "Thun Bhf", "Gare de Sion", "Stazione Lugano", "Zürich HB" | within 300 m of the station |
| `exonym` | "Geneva", "Genf", "Berne", "Lucerne", "Basle", "Zurich main station" | within 2.5 km of the town's station (400 m when a station is asked for) |
| `platform` | "Bern Gleis 7", "Thun voie 3", "Bern, Bahnhof Kante H" | within 15–40 m of that platform |
| `address` | "Obergasse 6, Elgg", "Kramgasse 12" (map nearby), with the postcode, "str." for "strasse" | within 75 m |
| `place-name` | an amenity's name: "Migros", "Amavita Apotheke Bahnhof" (map nearby), or name and town | within 100 m of it or of a nearer place with the same name |
| `category` | "pharmacy", "Apotheke", "closest toilet", "Bancomat", "Spielplatz", "AED" | within 60 m of one of the ten nearest of that kind |
| `town`, `postcode` | "Köniz", "3011" | within 3 km (2.5 km) of the middle of its addresses |

The stop groups ask whether the stop is found: for "Fraubrunnen" (a station named like its town) the town is
not a right answer, the station is. The data the answers come from has gaps of its own (a stop's OpenStreetMap name may differ from ATLAS's, an
amenity may have moved), so no system reaches 100 %: the numbers are for comparing, not a grade.

## Rebuilding the cases

`node tools/search-eval/make-cases.mts` after the data changes, then `--record` the new requests and
`--update-baseline`. New cases need new answers; the old ones stay in `answers.json.gz` (delete it to start over).
