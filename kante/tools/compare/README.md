# Comparing two engines

Asks two running engines — A, the reference (usually `main`), and B, the change — the same questions on national
samples and summarises where they differ. Both must be built from the same raw data.

```bash
# A: main, with the one endpoint this needs (B has it already)
git worktree add /tmp/kante-main origin/main
git -C /tmp/kante-main apply "$PWD/kante/tools/compare/main-reach.patch"
(cd /tmp/kante-main/kante/engine && cargo build --release -p kante-server)
# both builds from the same raw data (data dirs whose raw/ link to one place)
/tmp/kante-main/kante/engine/target/release/kante build --data /tmp/data-a --force
kante/engine/target/release/kante build --data /tmp/data-b --force
# serve them
.../kante serve --data /tmp/data-a --port 8091 &
.../kante serve --data /tmp/data-b --port 8092 &
# samples (24 000 points: 40 % register addresses, 20 % beside streets and paths, 10 % station coordinates, 10 %
# stations by id, 12 % off the network (more than 50 m from any way), 8 % near the border; a walk from each to an
# address 100 m – 2.5 km away; 4 800 trips from any of them to an address 3 – 60 km away, each at an hour from
# 05:00 to 23:00 and in one of the three profiles)
cd kante/engine && cargo build --release -p kante-link --bin compare
target/release/compare sample /tmp/data-b 24000 7 > /tmp/samples.json
# ask both
python3 ../tools/compare/compare.py --a http://127.0.0.1:8091 --b http://127.0.0.1:8092 \
  --samples /tmp/samples.json --data-a /tmp/data-a --data-b /tmp/data-b --bin target/release/compare --out /tmp/cmp
# A's own search code on B's graph, for the lost stops (--main-probe): built in A's worktree
cp kante/tools/compare/main-probe.rs /tmp/kante-main/kante/engine/crates/walk/examples/probe.rs
(cd /tmp/kante-main/kante/engine && cargo build --release -p kante-walk --example probe)
# (then add --main-probe /tmp/kante-main/kante/engine/target/release/examples/probe to the compare.py line above)
# every pair of ways a lift of A joins, checked in B; and the lift edges in one graph and not the other
target/release/compare lift-pairs /tmp/data-a/built/walkgraph.bin /tmp/data-b/built/walkgraph.bin
target/release/compare lifts /tmp/data-a/built/walkgraph.bin /tmp/data-b/built/walkgraph.bin
```

What it checks (`summary.json`):

- **reach** (`POST /api/reach`): the stops each point may walk to, normal, step-free and in a wheelchair, within 5,
  10 and 20 minutes; how much later B reaches the stops both reach (and by which candidate: B says `point` or
  `door`); and every stop A reaches and B does not with its cause from the built data (`compare explain`: B links
  the stop elsewhere, B's graph puts the start elsewhere, or A's own walk to it, recomputed on A's graph, uses an edge,
  a joint, a node's tags or a lift B's graph does not have as it is); with `--main-probe`, also whether A's own search
  code reaches the stop on B's graph (if not, the loss is the graph's, not B's code's).
- **walks** (`POST /api/walk`): where A routes, does B; B's length and time against A's; every pair over 1.5 ×.
- **through**: the straight lines of each walk (from the point to the network and from it to the end) that run
  through a building, by B's outlines and a test of its own (`compare through`: points every 25 cm, some more than
  30 cm inside a building and some more than 30 cm outside it), and whether they are drawn solid or step-free.
- **plans** (`POST /api/plan`, Tuesday 24 November 2026): where A has a journey, does B, and does it arrive later;
  every trip that loses its journey or arrives more than five minutes later, with whether B reaches A's first and
  last stop and when.
- **cost** (`--only cost`): `/api/plan` and `/api/walk` latency, four requests at a time.

## Auditing one engine

`audit.py` asks one engine (no reference) on a fresh sample and counts the answers that break what must always hold:
a guessed end labelled step-free; in the step-free and wheelchair profiles a guessed end without its alert; a
straight line onto the network through a building (`compare through`) not marked a guess; legs out of order, a
journey's times not its legs', an arrive-by journey after its deadline; a reach stop over its limit or lost with more
time; and any error or timeout (not the answer that no stop is within walking distance of a remote place, which
it counts on its own). Plans are asked departing and arriving by, with their earlier and later pages.

```bash
python3 kante/tools/compare/audit.py --engine http://127.0.0.1:8092 --data /tmp/data-b --bin target/release/compare \
  --seed 1 [--points 5000 --trips 1000] [--out /tmp/audit-1]
```

It prints each count with up to five `curl` lines to replay, writes every violation to `violations.json`, and exits 1
if any count is not zero.

## Does it find the fastest journey?

`fastest.py` asks one engine random trips across the country and checks each answer two ways: against SBB's planner
(transport.opendata.ch; about a thousand questions a day), and against the engine itself — leaving later can never get
you there earlier, so a question asked a few hours later that finds an earlier arrival shows a journey the first
answer missed.

```bash
# 400 trips between stations of the feed (any two, one of them a large station, or two within 60 km), on a weekday,
# a Saturday and a Sunday; --points asks from and to a point 50–600 m beside each station, as the app does
python3 kante/tools/compare/fastest.py sample --gtfs kante/data/raw/gtfs/gtfs.zip --engine http://127.0.0.1:8092 \
  --trips 400 --out /tmp/trips.json [--points]
# the same trips on another build, or with other routing options (SBB's answers are kept)
python3 kante/tools/compare/fastest.py rerun --in /tmp/trips.json --engine http://127.0.0.1:8091 --out /tmp/trips-a.json \
  [--set maxWalkMin=40]
# every trip where SBB arrives more than five minutes earlier, with both journeys
python3 kante/tools/compare/fastest.py report --in /tmp/trips.json --legs
# the engine against itself (exits 1 if a later question finds an earlier arrival)
python3 kante/tools/compare/fastest.py later --in /tmp/trips.json --engine http://127.0.0.1:8092
```

Not every trip SBB wins is a journey the engine should have found. SBB lets you change in the timetable's minimum
change time, which can be less than the walk between the two platforms takes, starts at a neighbouring station at
once, and walks up to about twenty minutes in a straight line; the engine walks the way there is, at the traveller's
pace, and goes beyond the traveller's longest walk only for half an hour gained. What was a fault of the search when
this was written (November 2026): journeys of more than seven rides were never found, a change at a village stop was
missed for the two minutes added to every change, a place whose bus does not run for sixteen hours, or whose nearest
stops nothing calls at out of season, had no journey at all, and a walk a minute over the longest was never taken,
whatever it saved (the first bus at five instead of home at midnight).
