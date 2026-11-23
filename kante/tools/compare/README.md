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
