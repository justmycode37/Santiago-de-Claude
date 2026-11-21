# Ist-Daten: would learned travel times beat the timetable?

Question: when a vehicle's departure at stop A has been **measured** but the arrival at the next stop B has no fresh
forecast, would a per-hop travel time learned from past days place the vehicle better than the scheduled hop duration?
Same question for dwell time (actual departure − actual arrival).

**Short answer: yes, clearly.** Median/MAE error of the predicted arrival at B drops from 33.5 s to 10.6 s overall
(trains 46 → 12 s, buses 34 → 10.5 s, trams 25 → 10 s); p90 from 68 s to 23 s. Hour-of-day buckets add almost nothing
over a plain per-(A,B) median, and that table is only ~0.46 MB gzipped.

Numbers produced by `ist_daten_hops.py` (this folder), run 2026-11-21, 15 days 2026-11-06 … 2026-11-20.

## Data and method

- Source: the open "Ist-Daten" archive, `https://data.opentransportdata.swiss/en/dataset/ist-daten-v2`. One CSV per
  operating day (`…/download/YYYY-MM-DD_istdaten.csv`, 302 → signed Cloudflare R2 URL; resource ids change per file,
  so the script scrapes the dataset page; a plain GET needs a `User-Agent`, the CKAN API answered 403). About 50 days
  are kept online; older ones are at `archive.opentransportdata.swiss`. Each file is ~0.7 GB, ~2.6 M rows on a weekday
  (1.6–2.1 M Sat/Sun), 37 M rows in total. All 15 days were downloaded (~38 MB/s, ~6 s each), reduced in streaming
  fashion to a compact gzip, raw files deleted; nothing is in the repo.
- Columns verified from the header (22, `;`-separated): `BETRIEBSTAG, FAHRT_BEZEICHNER, BETREIBER_ID, BETREIBER_ABK,
  BETREIBER_NAME, PRODUKT_ID, LINIEN_ID, LINIEN_TEXT, UMLAUF_ID, VERKEHRSMITTEL_TEXT, ZUSATZFAHRT_TF, FAELLT_AUS_TF,
  BPUIC, HALTESTELLEN_NAME, ANKUNFTSZEIT, AN_PROGNOSE, AN_PROGNOSE_STATUS, ABFAHRTSZEIT, AB_PROGNOSE,
  AB_PROGNOSE_STATUS, DURCHFAHRT_TF, SLOID`. Scheduled times (`ANKUNFTSZEIT`, `ABFAHRTSZEIT`) are whole minutes;
  actual/forecast times (`*_PROGNOSE`) carry seconds.
- **Status values**: `REAL`, `PROGNOSE`, `GESCHAETZT`, `UNBEKANNT` (or empty). Only `REAL` is treated as measured, for
  training and truth. (Swiss stops: arrivals 95.7 % REAL, 3.5 % PROGNOSE, 0.9 % GESCHAETZT, 0.4 % UNBEKANNT.)
- Mode from `PRODUKT_ID`: Zug → train, Tram → tram, Bus/BUS → bus, everything else (Metro, Zahnradbahn, Schiff …) →
  other.
- Scope: stops with BPUIC `85…` only (547 k of 37 M rows dropped); rows of cancelled journeys/stops (188 k),
  extra journeys `ZUSATZFAHRT_TF` (206 k) and pass-throughs `DURCHFAHRT_TF` (2 k) are skipped. Rows of a journey are
  ordered by scheduled time; a hop is two consecutive remaining stops of one `FAHRT_BEZEICHNER`
  (a cancelled stop breaks the chain; a pass-through is bridged). Hops/dwells with a scheduled or actual duration
  < 0 s or > 2 h are dropped (25 k hops, 17 k dwells).
- Split: test = the last 2 weekdays (Thu 2026-11-19, Fri 2026-11-20); training = the other 13 days (incl. 2 Saturdays and
  2 Sundays): 26.9 M hop and 25.4 M dwell samples. Test: 4.52 M hops and 4.27 M dwells with both ends measured.
- Predictors, given the measured departure at A (dwell: measured arrival at S):
  (a) scheduled duration; (b) learned median of the **measured** duration for key (A, B, hour of scheduled departure,
  day type weekday/Sat/Sun), fallback to (A, B), fallback to (a) when < 5 samples. Dwell key uses (S, next stop N).
  Variants: *coarse* = 5 time buckets (0–5, 6–8, 9–15, 16–18, 19–23 h) instead of 24 hourly; *pair only* = (A, B) alone.
  Level used on test: hourly bucket 99.0 %, pair 0.7 %, schedule fallback 0.3 %.
- Error = predicted − actual arrival (dwell: departure), absolute value in seconds, shown as MAE / median / p90.

## Results: hop travel time (4.52 M test hops)

| group | n | scheduled MAE / med / p90 | learned hourly | learned coarse | learned pair only | within ±30 s: sched → hourly → pair |
|---|---:|---|---|---|---|---|
| **all** | 4,523,234 | 33.5 / 24 / 68 | **10.6 / 5 / 23** | 10.7 / 5 / 23 | 11.0 / 5 / 23 | 61% → 94% → 93% |
| train | 280,102 | 46.2 / 36 / 98 | 12.2 / 5 / 28 | 12.3 / 5 / 28 | 12.6 / 5 / 28 | 44% → 91% → 91% |
| tram | 444,789 | 24.6 / 16 / 56 | 10.3 / 5 / 23 | 10.3 / 5 / 23 | 10.5 / 5 / 24 | 70% → 93% → 93% |
| bus | 3,788,651 | 33.6 / 24 / 68 | 10.5 / 5 / 22 | 10.6 / 5 / 22 | 11.0 / 5 / 23 | 61% → 94% → 93% |
| other | 9,692 | 25.5 / 17 / 52 | 10.1 / 5 / 19 | 10.1 / 5 / 19 | 10.2 / 5 / 20 | 76% → 94% → 94% |
| scheduled ≤ 2 min | 3,984,446 | 27.4 / 22 / 56 | 9.5 / 5 / 20 | 9.5 / 5 / 20 | 9.8 / 5 / 21 | 66% → 95% → 94% |
| scheduled > 2 min | 538,788 | 78.9 / 62 / 161 | 19.1 / 9 / 42 | 19.3 / 9 / 42 | 20.1 / 9 / 44 | 25% → 85% → 84% |
| scheduled = 0 s | 482,970 | 39.7 / 37 / 60 | 7.0 / 3 / 14 | 7.0 / 3 / 14 | 7.2 / 4 / 14 | 33% → 97% → 97% |
| train ≤ 2 min | 91,480 | 27.3 / 22 / 57 | 6.3 / 2 / 15 | 6.3 / 2 / 15 | 6.6 / 3 / 16 | 64% → 97% → 97% |
| train > 2 min | 188,622 | 55.4 / 47 / 111 | 15.1 / 6 / 35 | 15.2 / 6 / 35 | 15.5 / 6 / 35 | 34% → 88% → 88% |
| tram ≤ 2 min | 431,014 | 23.7 / 16 / 54 | 9.9 / 5 / 22 | 9.9 / 5 / 22 | 10.1 / 5 / 22 | 71% → 94% → 94% |
| tram > 2 min | 13,775 | 53.7 / 51 / 96 | 21.9 / 13 / 48 | 21.9 / 13 / 48 | 22.5 / 13 / 50 | 30% → 81% → 80% |
| bus ≤ 2 min | 3,453,089 | 27.8 / 23 / 56 | 9.5 / 5 / 20 | 9.5 / 5 / 20 | 9.9 / 5 / 21 | 65% → 95% → 94% |
| bus > 2 min | 335,562 | 93.1 / 78 / 187 | 21.2 / 10 / 45 | 21.5 / 10 / 45 | 22.5 / 10 / 48 | 20% → 83% → 82% |
| bus = 0 s | 453,167 | 39.2 / 36 / 59 | 7.0 / 3 / 14 | 7.0 / 4 / 14 | 7.2 / 4 / 14 | 34% → 97% → 97% |
| tram = 0 s | 26,678 | 46.1 / 44 / 60 | 6.9 / 3 / 12 | 6.9 / 3 / 12 | 6.9 / 3 / 12 | 7% → 97% → 97% |
| train = 0 s | 2,345 | 59.2 / 62 / 89 | 7.3 / 3 / 15 | 7.3 / 3 / 14 | 7.3 / 3 / 14 | 17% → 96% → 96% |

(other ≤ 2 min / > 2 min / 0 s: 19.1→8.7, 93.7→25.9, 45.0→7.7 MAE; full table in `results.md` produced by the script.)

## Results: dwell time (4.27 M test dwells; scheduled dwell is 0 for 89 % of them)

| group | n | scheduled MAE / med / p90 | learned hourly | learned coarse | learned pair only | within ±30 s: sched → hourly → pair |
|---|---:|---|---|---|---|---|
| **all** | 4,274,127 | 21.9 / 17 / 45 | **9.2 / 4 / 19** | 9.5 / 4 / 20 | 10.0 / 5 / 20 | 78% → 96% → 95% |
| train | 251,700 | 41.7 / 34 / 76 | 17.4 / 7 / 39 | 17.7 / 7 / 39 | 18.5 / 8 / 41 | 43% → 86% → 86% |
| tram | 424,705 | 25.9 / 22 / 44 | 7.9 / 5 / 16 | 8.0 / 5 / 16 | 8.3 / 5 / 17 | 71% → 97% → 97% |
| bus | 3,589,037 | 19.9 / 16 / 43 | 8.8 / 4 / 19 | 9.1 / 4 / 19 | 9.6 / 5 / 20 | 81% → 96% → 96% |
| other | 8,685 | 37.9 / 28 / 61 | 17.7 / 7 / 37 | 17.8 / 7 / 37 | 18.3 / 7 / 37 | 56% → 87% → 88% |
| scheduled dwell 0 s | 3,810,683 | 18.9 / 16 / 36 | 8.1 / 4 / 18 | 8.3 / 4 / 18 | 8.7 / 5 / 19 | 84% → 97% → 96% |
| scheduled dwell > 0 | 463,444 | 45.9 / 43 / 60 | 18.5 / 7 / 45 | 19.4 / 7 / 46 | 20.7 / 7 / 49 | 25% → 85% → 84% |
| train, scheduled > 0 | 67,606 | 41.7 / 27 / 96 | 35.1 / 17 / 85 | 36.6 / 17 / 89 | 38.3 / 18 / 92 | 55% → 68% → 66% |
| tram, scheduled > 0 | 89,863 | 38.9 / 39 / 51 | 8.8 / 5 / 18 | 8.9 / 5 / 18 | 9.3 / 6 / 18 | 23% → 96% → 96% |
| bus, scheduled > 0 | 302,586 | 49.0 / 44 / 60 | 17.6 / 6 / 43 | 18.6 / 6 / 44 | 20.1 / 7 / 48 | 19% → 86% → 85% |

Trains with a scheduled stop > 0 are the one place where the learned median barely helps (35 vs 42 s MAE): such dwells
are timetable-driven and dominated by delay recovery, not a stable property of the stop.

## Measured share and 0-s hops (all 15 days, 66.5 M stop events)

| mode | stop events | measured | arrivals measured | departures measured |
|---|---:|---:|---:|---:|
| train | 4,289,790 | 96.4% | 96.4% | 96.4% |
| tram | 6,634,751 | 98.1% | 97.9% | 98.2% |
| bus | 55,383,616 | 95.3% | 95.3% | 95.2% |
| other | 161,360 | 85.7% | 85.7% | 85.7% |
| **all** | 66,469,517 | 95.6% | 95.6% | 95.6% |

Per day the overall share is 94.9–96.5 %. Ten largest operators (by stop events; abbreviations as in `BETREIBER_ABK`,
non-cancelled, non-extra, Swiss stops): PAG 97.1 %, TPG 98.6 %, VBZ 98.1 %, TL 98.1 %, "VBZ Fpl" 98.8 %, BVB 96.8 %,
SVB Auto 98.9 %, VBL 98.4 %, **TPF Auto 85.0 %**, SBB 97.4 %. (Full table with arrival/departure split in `results.md`.)

Scheduled stop pairs (consecutive stops with scheduled dep at A and arr at B): 33.2 M, of which **3.60 M (10.8 %) have a
scheduled duration of 0 s**: bus 12.2 % (3.37 M of 27.7 M), tram 6.2 % (204 k of 3.3 M), other 6.7 %, train 0.8 %
(17 k of 2.1 M). The same share holds among pairs with both ends measured (10.8 %). Their real median is ~37 s.

## Limits

- Ist-Daten has **stop times only**: nothing about where a vehicle is *within* a hop, so the result says the arrival at
  B is better predicted, not that the interpolation curve (speed profile, dwell/standstill at signals) is right.
- The archive is the **finished** day. "Measured" shares are end-of-day shares (95.6 %); the live feed will have fewer
  measured values at any moment, and PROGNOSE values there are not what is in the daily file's REAL columns. The
  training itself uses only REAL, so it is not biased by the forecast quality.
- Truth and training both use the same measurement systems; a systematic artefact in how an operator derives "REAL"
  (e.g. fixed dwell offsets) would be learned and look like a real gain. TPF Auto (85 % measured) is the only large
  operator with a visible gap.
- Only 2 test days (Thu/Fri, neighbouring the training days, no holiday/disruption); training window 13 days. Day type is
  weekday/Sat/Sun only, no holidays, no school-holiday or line-level conditioning (pooled over all lines/directions
  sharing a stop pair). A real deployment should retrain on a longer window; DST nights (naive local seconds) and
  timetable changes (December) would need care. Hops are only evaluated where A-departure **and** B-arrival are
  measured (95 % of pairs), so cancelled/unmeasured hops are not scored.
- Errors are conditional on the measured departure at A; they say nothing about delay-dependent hop times (late buses
  run differently), which a per-hop median cannot capture.
- 0.3 % of test hops (new stop pairs, <5 samples) fell back to the schedule.

## Profile table

The hourly profile (`profile_hop.csv.gz`: A, B, daytype, hour, n, median_s; plus (A,B)-rows) is 5.5 MB gzipped
(hop) + 4.8 MB (dwell); the **pair-only** version is 0.46 MB (hop) + 0.40 MB (dwell) — 53.8 k stop pairs (hops),
50.2 k (dwell) with ≥ 5 samples; the hourly tables have 1.16 M / 1.09 M keys — and costs only +0.4 s MAE (hops) / +0.8 s (dwell). Written to
`%TEMP%\ist-daten\cache\out\` (not in the repo).

## Keyed by station (format v3, what the engine uses)

The archive's stop numbers (`BPUIC`) come in 7, 8 and 9 digits, so a table keyed by them only partly matched the
engine's stations (7.5 k of 53.8 k pairs). Since format v3 the script keys each stop by its **station** (from `SLOID`,
`ch:1:sloid:7000:…` → 8507000; else the first 7 digits of BPUIC). Re-run on the same 15 days, pair-only, test days
19–20 Nov: hops 33.5 → **11.4 s** mean error (median 24 → 5 s, p90 68 → 24 s; within ±30 s 61 % → 93 %), dwell
21.9 → **10.2 s**. The engine finds 48,810 of the 48,830 hop pairs and 46,175 dwell pairs. Files: 0.38 MB (hop) and
0.33 MB (dwell) gzipped. The engine uses the dwell profile only for buses, trams and other non-rail vehicles.

## Recommendation

Worth building, in a deliberately small form: ship a **per-(A,B) median hop duration** (no hour/day-type buckets; ~0.5 MB
gz, rebuilt weekly from the last ~2 weeks of Ist-Daten) and use it instead of the scheduled duration whenever A's
departure is measured but B has no fresh forecast, with the schedule as fallback for pairs with < 5 samples (0.3 %).
It cuts the arrival error by about 3× for **all modes** (train 46 → 13 s, bus 34 → 11 s, tram 25 → 11 s MAE; p90 68 → 23 s)
and removes the 0-s hop problem (11 % of all hops, 12 % of bus hops, whose real duration is ~37 s). The larger win
in metres is on trains (higher speed, longer hops: a 46 s error is ≈ 1.3 km at 100 km/h). The same profile for dwell is
also a clear win for buses and trams (20 → 9 s, 26 → 8 s) and for zero-scheduled-dwell trains (42 → 11 s), but **not**
for trains with a scheduled stop (keep the schedule there). Hour buckets are not worth the 10× size. Still to verify
before relying on it: that the live engine's "measured departure" shows the same bias as REAL in the archive, and
the gain on a longer, noisier window (holidays, timetable change).
