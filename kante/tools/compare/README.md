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
# samples (24 000 points: half addresses inside buildings, 30 % street points, 20 % stations; a walk from
# each to an address 100 m – 2.5 km away; 4 800 trips between addresses 3 – 60 km apart)
cd kante/engine && cargo build --release -p kante-link --bin compare
target/release/compare sample /tmp/data-b 24000 7 > /tmp/samples.json
# ask both
python3 ../tools/compare/compare.py --a http://127.0.0.1:8091 --b http://127.0.0.1:8092 \
  --samples /tmp/samples.json --data /tmp/data-b --bin target/release/compare --out /tmp/cmp
# lift edges in one graph and not the other, with OSM ids, and what the other has there
target/release/compare lifts /tmp/data-a/built/walkgraph.bin /tmp/data-b/built/walkgraph.bin
```

What it checks (`summary.json`):

- **reach** (`POST /api/reach`): the stops each point may walk to, normal and step-free, within 5, 10 and 20 minutes;
  stops A reaches and B does not, and how much later B reaches the others.
- **walks** (`POST /api/walk`): where A routes, does B; B's length and time against A's; every pair over 1.5 ×.
- **through**: the straight lines of each walk (from the point to the network and from it to the end) that run
  through a building, by B's outlines, and whether they are drawn solid or step-free.
- **plans** (`POST /api/plan`, Tuesday 24 November 2026, departures 08:00 – 19:00, a quarter step-free): where A
  has a journey, does B, and does it arrive later.
- **cost** (`--only cost`): `/api/plan` and `/api/walk` latency, four requests at a time.
