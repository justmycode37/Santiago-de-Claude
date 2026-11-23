# Integration of the November 2026 feature branches

This is the map used to combine the open feature PRs into `main`: what each one touches, where they collide, what
each takes from the others, and what is duplicated. The plan was challenged by two planning partners (GPT and
Gemini) before work started; their corrections are folded in.

Base: `main` at 5d23cfa (#22 removed the ride-position setting and on-board reports from the app). It already contains live tracking (#11: Kante `/api/due`, `/api/match`, `/api/trip`,
`/api/vehicles`, `/api/stream`, `/api/observe`, `live.js`, `KanteJourney.applyTrip`, `requay`; contract in
`kante/docs/LIVE-API.md`), the map pin/search layout and language setting (#14), station models for Brünnen
Westside and Bümpliz Nord with builder changes, route choice (#19: journey list, walking all the way), walking-speed
learning (`walk-pace.js`), the showcase walk (`Station3D.play/pause/isPlaying`), Pages publishing of `demo-media`
(#20) and the short README rule in `AGENTS.md` (#21). The site deploys with GitHub Pages
(`.github/workflows/pages.yml`); merging to `main` also redeploys the hosted engine at kante.omniroute.app.

## Outcome (21 Nov 2026)

Merged into `main` with merge commits, in this order; `main` was built, tested (`npm test`) and loaded in a browser
after each web merge:

| PR | Merge commit | Notes |
| --- | --- | --- |
| #12 | 0a79ac9 | stand-in fixed in review: `close()` cancels a loading `open()`, `isOpen()` covers it, load failure reaches `'error'` listeners |
| #17 | 93eb00b | |
| #18 | e44920b | medium review items go to a follow-up (below) |
| #29 | e856a2a | `main` merged into the branch first (`src/types/kante.d.ts`) |
| #15 | 2237a3e | merged as it was, by the owner's decision; review findings in a follow-up |
| #24 | 58ac288 | same |
| #23 | a84dc3d | four review findings fixed first; kante.omniroute.app redeployed and healthy (`/api/meta` lists `identify`, `quay-sloid`) |
| #13 | 49a3f0a | held until its high review findings were fixed (step-free door, live platform change at modelled stations and for a platform-only change, cleared walk returning, On foot times) |
| #8 | bf709c6 | held until its high review findings were fixed (viewer/indoor load race and station switch, invented or stale blue dot); last fix: a remembered GPS fix is handed on only while recent |
| #34 | fbf3ba6 | follow-up: #13's medium/low review items |
| #33 | 7409fd6 | follow-up: #18's review items, Zürich furniture levels |
| #31 | 16f1f25 | follow-up: the 12 RightSide review findings (portable tests 111/111; held-out right vehicle accepted 74.3 %, wrong 0 %) |

Order changed from the plan: #8 and #13 were held for review fixes while the rest went in; Scan (#29) landed before them. The glue of this integration (this file, a README line) is the last PR, from `integration/all-features`.

### Follow-ups

- **RightSide (#15, #24): 12 review findings — fixed in #31 (merged):** shared frame cache across vehicles in one
  frame; `sameDisplay` erasing a different destination; ground arrows without a walking route; kerb-side test without
  a perpendicular bound and on rail edges; "board at" taking another departure's quay; stale Kante evidence after
  failed polls; descent applied twice in `ARRouteGuide`; Kante feature check latching on HTTP errors and polls not
  restarted on a new leg; empty `quayLabel`; AR target label not refreshed; `pathFit` yaw from a frozen GPS and stale
  compass headings; 2 MB edge pack parsed on the main thread every frame.
- **Continuous 3D view (#18) — fixed in #33 (merged):** "Inside view" link drops walking speed, journey date and coordinate fallbacks; no error
  state when three.js or WebGL fail; `sbb_sections` furniture levels at Zürich (11 props 20–56 m off their floor);
  `station3d_sbb_layers.py` end-border signs. 
- **Walk router (#13) — fixed in #34 (merged):** "Lift to level −1" drawn as stairs up; `netWalkOption` dropped when another row opens;
  re-ranking ignores `maxWalkMin`; a cleared transfer keeps its old walk minutes in the spare time; the option row keeps
  the old first-walk minutes; an engine walk arriving after a station walk loses its timing; approximate network
  walks gating; a change's `t1`; multi-section walk-only distance.
- Reuse not done yet: indoor dot in the continuous view and more stations (`feature/station3d-next`, in progress);
  `/api/due` departures for `SIGNLOC.match`; RightSide's display matcher ported to the web Scan; `/api/identify` and
  `?quay=<SLOID>` in RightSide and Scan; walk tiles for Zürich.

Still owed: the remaining reuse above, and the Mac/iPhone checks below.

### Test results

- `npm test` (station routes 63 + 37, walk router 14, walk refinement 30), `npm run check` 0 errors, `node tools/sim_indoorloc.js --check`
  passes; Kante `cargo test --workspace` 165 passed; RightSide portable tests 111/111 and display bench (held-out: right
  vehicle accepted 74.3 %, wrong accepted 0 %) on Swift 6.4.3 in WSL.
- Browser (Chromium, 390 px and desktop, built `dist/`): map, journey list, Bern journey on the walk network into the
  Bern station model, 3D view loaded on first use with indoor position (sign → floor), Done/close/reopen, open+close
  race, Zürich HB in the 3D and continuous views, live delay on a ride, Scan opening and its OCR/photo engines on a
  sample sign, no console errors except the optional `config.js`. Start-up loads no 3D or indoor script.
- Not tested: an iPhone/Xcode build of RightSide (no Mac), real-phone sensors and GPS for indoor position and walks,
  Scan end to end on a photo in this browser (its reading loop needs a visible tab; the owner ran 16 photo cases).

## The PRs and merge order

| Order | PR | Branch | What |
| --- | --- | --- | --- |
| 1 | #12 | `fix/serve-backlog` | `tools/serve.py` backlog 128; `station3d.js` loads on first use (stand-in `window.Station3D` in `index.html`) |
| 2 | #8 | `feature/indoor-positioning` | `indoorloc.js`, `signloc.js`, `indoornav.js`; `levelSure` in `station3d.js`; `scan:text` event in `stopvision.js` |
| 3 | #17 | `feature/station3d-zurich` | `stations3d/zurich.js`, builder fixes, `tools/station3d_sbb_layers.py` |
| 4 | #18 | `feature/station3d-solid` | continuous 3D view `station3d-solid.{html,js}`, `stations3d/zurich.solid.js`, `tools/station3d_solid.py`; contains #17 |
| 5 | #13 | `feature/walk-router` | `walkroute.js`, `walkgraph/`, `tools/build_walkgraph.py`, `tools/swisstlm3d.py`, journey wiring in `index.html` |
| 6 | #15 | `rightside-ar-recognition` | RightSide native iOS app, only under `rightside/` |
| 6b | #24 | `feature/rightside-platforms` | RightSide only, stacked on #15: `platforms.js` stop edges as the AR target, kerb side, ARKit floor and `stations3d` heights; `rightside/tools/build-edge-packs.py` |
| 7 | #29 | `feature/scan-context` | Scan: GPS + compass + image, side of road, route check with `/api/due`, sign highlight; `src/stopvision.ts`, `src/app/14-menu.ts` |
| 8 | #23 | `feature/vehicle-identify` | Kante only: `quay=` takes ATLAS SLOIDs, `GET /api/identify` (vehicle → trip), RhB divided trains, faster feed retry. Last, because merging redeploys kante.omniroute.app; check `/api/meta` after |

#13 does not touch `stopvision.js`, so it does not wait for Scan; Scan goes after the other web PRs whenever it is ready, and #23 after it.

Not part of this integration: #1 (toilet data), #4 (better bus stop data). #16 (TypeScript migration by a teammate)
landed in `main` during the integration; every web PR was moved onto it (map below).

## Map for the TypeScript migration (#16)

#16 (a teammate's) landed in `main` (4e57bc8) during this integration. Scripts moved to `src/*.ts`, the page's
inline script to `src/app/*.ts` (one scope, joined in file-name order and put into `index.html` at build time), and
the site is built into `dist/` by `scripts/build.mts` (`npm run build`, `npm run dev`; `tools/serve.py` now serves
`dist/`). See `docs/development.md`, "Moving a branch from before the move to TypeScript". A type error never blocks
the build or deploy (`npm run check` reports; on `main` it already reports 1121 errors, so the bar for our PRs is
"no new errors"). Each feature branch merges `main` and moves its changes:

| Our change | Before | After #16 |
| --- | --- | --- |
| #12 lazy `Station3D` stand-in | inline `<script>` in `index.html` | still an inline `<script>` in `index.html`, in place of `<script src="station3d.js">` (done, f396466 on `fix/serve-backlog`, with `play/pause/isPlaying`) |
| #12 `request_queue_size`, `daemon_threads` | `tools/serve.py` | already in `main`'s `tools/serve.py` |
| #8 loading of the indoor scripts | the stand-in in `index.html` | the stand-in in `index.html` |
| #8 GPS hook `(window.INDOORNAV \|\| Station3D).setUser(...)` | `index.html` app script | `src/app/16-location.ts` (line ~58) |
| #8 `levelSure` (8 lines) | `station3d.js` | `src/station3d.ts` (merges by itself or nearly) |
| #8 / Scan `scan:text` dispatch, Scan's changes | `stopvision.js` | `src/stopvision.ts` |
| #8 `indoorloc.js`, `signloc.js`, `indoornav.js`; #13 `walkroute.js`; #18 `station3d-solid.js` | repository root | stay in the root (copied as they are) or move to `src/<name>.ts` with a `declare var` in `src/types/`; `*-dev.html` pages are left out of the release automatically |
| #18 "Inside view" button (`s3HasSolid`, `s3SolidUrl`) | `index.html` app script | `src/app/62-sheet-content.ts` (next to `s3Plan`) |
| #13 `buildSteps` ends, `tripStart` start | `index.html` | `src/app/44-journey-steps.ts` |
| #13 off-route tolerance on foot | `index.html` | `src/app/50-tracking.ts` (`trackJourney`) |
| #13 `syncEnds` / re-refine after `requay` | `index.html` | `src/app/54-live-timetable.ts` |
| #13 On foot card, header, ranking | `index.html` | `src/app/62-sheet-content.ts`, `66-pill.ts` |
| #13 `routeWalk`, `refineJourney`, `netDirections`, walk revisions | `index.html` | `src/app/70-routing.ts` |
| #13 `walkgraph/` published | `.github/workflows/pages.yml` | `STATIC_DIRS` in `scripts/build.mts` |
| README lines | `README.md` | `README.md` (short, `AGENTS.md`) |

Untouched by #16: `stations3d/`, `tools/build_station3d.py`, `tools/station3d_*.py`, `walkgraph/`, `tools/build_walkgraph.py`,
`kante/` (#23), `rightside/` (#15, #24).

## Shared files and conflicts

| File | Touched by | Conflict | Resolution |
| --- | --- | --- | --- |
| `index.html` script tags | #12 (stand-in replaces `<script src="station3d.js">`), #8 (adds indoor scripts beside it) | textual | keep #12's stand-in. The stand-in also loads #8's three scripts after `station3d.js` and before the first `open()`, so start-up loads none of them (`indoornav.js` returns early if `INDOORLOC` is missing, so it must not run before it). GPS remembered by the stand-in is handed to `INDOORNAV` as well as the viewer. |
| `index.html` stand-in API | #12, `main` (`Station3D.play/pause/isPlaying`) | semantic | stand-in gets the three new methods |
| `index.html` journey code | #13; `main` (#19 journey list, `tripStart`, `!journeyList` guard, `placeUserDot`, `walk-pace.js`, `set-foot` text) | textual + semantic | owner (#13) merges `main` and fixes the semantic issues listed below |
| `stopvision.js` | #8 (`scan:text` dispatch in `useText`), Scan | expected | keep the dispatch; Scan dispatches `scan:text` from every place it reads text |
| `station3d.js` | #8 (`levelSure`, 8 lines), `main` (showcase walk) | none | — |
| `stations3d/index.js`, `tools/build_station3d.py`, `tools/station3d_data/README.md` | #17/#18, `main` (Brünnen, Bümpliz Nord) | textual + builder policy | owner merges `main`. Policy conflict: `main` trusts a supplied furniture `level` unconditionally (a Bümpliz Nord clock sits nearer the underpass than any level-0 area); #17 trusts it only within 15 m of a walk polygon on that level. One rule that serves both; check #17's stop-matching filters against Brünnen and Bümpliz Nord; rebuild all six and explain every byte that changes; rebuild `zurich.solid.js` if `zurich.js` changes. |
| `.github/workflows/pages.yml` | #13 (`walkgraph`), `main` (`demo-media`, `rm station3d-detail-dev.html`) | textual | keep all of `main`'s lines and add `walkgraph` |
| `README.md` | #8, #13, #15, Scan | textual | `AGENTS.md`: keep the README short; one line per feature at most, details in `docs/` |

## Semantic issues found in planning (owner #13 fixes)

1. **Custom start pin.** #13's first walk uses `{ gps: true }` with GPS accuracy even when the trip starts at a pinned
   place (`tripStart`, #14). It must start at the pin.
2. **Walking time versus drawn walk.** #19 ranks and shows "On foot" with the engine's distance and time; #13 redraws
   the walk on the network but keeps the engine's time. All the way on foot: card, header and arrival follow the
   network walk at the traveller's walking speed. Walks inside a plan with rides: the engine's time stays for
   feasibility, but a network walk that no longer fits the change is said, not hidden.
3. **Live platform change.** `KanteJourney.requay()` clears walk geometry and sets `kanteWalk` without network
   refinement, and #13's `st.ends` platform/floor is not updated. Re-refine after a requay, and guard each walk leg
   with a revision so an older network answer cannot overwrite a newer one.
4. **Start-up.** `walkroute.js` (33 KB) is a blocking script; load it deferred or on first use.
5. **Tests.** The Node harness behind #13's measurements is committed as a runnable test.

## Reuse between the features

In this integration:

1. **Indoor scripts load with the viewer (#12 ↔ #8).** No start-up cost for indoor positioning.
2. **Scan's read text → indoor position (Scan → #8).** Every text Scan reads is dispatched as `scan:text`; inside a
   station `SIGNLOC` decides. Scan does not grow its own platform/sector sign parser; where it needs one it calls
   `SIGNLOC.parse`.
3. **Scan's route check uses Kante `/api/due` (#11 → Scan)** through the `KANTE_LIVE` client, with the stationboard
   as fallback, as RightSide does (#11 → #15, already in #15).
4. **Walk router hands off to every station model (#13 ↔ #17, `main`).** The hand-off is keyed on `Station3D.has()`,
   so Zürich HB, Brünnen and Bümpliz Nord are covered without changes. Walk tiles exist only for Bern; elsewhere the
   street parts fall back to the online routers.
5. **The continuous 3D view reachable from the app (#18).** For a station with a `stations3d/<key>.solid.js`
   companion, the 3D view offers the building view, passing the route ends the solid page understands. Only if this
   stays small; otherwise it is a follow-up.
6. **Indoor position on Zürich HB, Brünnen and Bümpliz Nord (#8 ↔ #17, `main`).** `INDOORLOC.load(key)` is generic;
   smoke-checked on the new models.

Follow-up, deliberately not in this integration:

- Indoor dot in the continuous view: `station3d-solid.js` has no position API, and the standalone page does not share
  the indoor session. Needs an embedded mount (import map for three.js in `index.html`) and a position subscription.
- `/api/due` departures for `SIGNLOC.match`: today a matched departure board places the traveller on the first
  matching service's platform; a concourse board lists many platforms. Needs board-type and ambiguity handling and
  a `quayLabel/line.name/headsign` adapter first.
- Port RightSide's `DepartureDisplayMatcher` to the web Scan for vehicle displays.
- Walk router boarding-edge data (`{ platform, level, ref }` endpoints, doors and kerbs in `walkgraph/`) as the AR
  boarding target and kerb side for RightSide.
- RightSide and Scan: `/api/due?quay=<SLOID>` for the exact boarding edge and `/api/identify` to bind a seen vehicle
  to its trip (#23). The journey already resolves the ATLAS SLOID quay.
- `tools/station3d_sbb_layers.py` for the other stations; the corridor-cutaway shader in `station3d.js`.
- Walk tiles for Zürich (`tools/build_walkgraph.py --area zurich`); solid companions for the other stations.

## Duplicates

- **Sign text parsing:** one parser, `SIGNLOC.parse`, for platform, sector and exit signs. Scan keeps stop-name
  matching.
- **Stop departures:** Scan and RightSide read Kante `/api/due`; transport.opendata.ch stationboards only as fallback.
- **Two 3D viewers:** `station3d.js` (floors pulled apart, routing, indoor position, showcase walk) and
  `station3d-solid.js` (one building at true heights). Different views of the same model files and the same
  `station-route.js` routes, so both stay. (Later replaced: since November 2026 only `station3d-solid.js` remains,
  through the station view; `station3d.js` was removed.)
- **Walk geometry:** `walkroute.js` where tiles exist; the online routers only as fallback.
- **#17's commit inside #18:** disappears by merging #17 first.

## Test plan for the combined branch

- `tools/serve.py`, real browser, desktop and 390 px:
  - map load, place search, start-up time and bytes against `main`, no console errors;
  - cold lazy load of the 3D viewer and indoor scripts, failed load, Done, close/reopen, switching stations, Scan
    text between openings;
  - a Bern journey with walks through Bern station (3D view, step-free, indoor position) and an outdoor walk on the
    walk router; a pinned start away from GPS; PT / On foot switching while routing is pending; settings changes;
    missing tiles (Zürich) falling back;
  - live vehicles and live info on a journey;
  - Scan on a sample image;
  - Zürich HB in the 3D view and in the continuous view, including a missing companion;
  - the Pages artifact as the workflow assembles it (`walkgraph`, `demo-media`), not just the repository.
- Suites: `tools/test_station_route.mjs`, `tools/test_station_route2.mjs`, `node tools/sim_indoorloc.js --check`,
  #13's walk router test, `cargo test` in `kante/engine`, RightSide portable tests and display bench (Swift on WSL).

## Owed after merge

- **RightSide (#15):** merged without an Xcode build or an iPhone test, by the project owner's decision (it lives only
  in `rightside/` and is not part of the site). Owed: an Xcode build on a Mac, XCTest/UI tests, and recordings on a
  real iPhone at a real stop (Vision read rate, compass, AR alignment, `/api/due` timing). Only Linux/WSL Swift checks
  were possible. Note the AGPL-3.0 licence of the bundled YOLOE detector before any closed-source release.
- Indoor position (#8) and the walk router (#13) on a real phone with real sensors and GPS.
- Continuous 3D view (#18) performance on a real phone.
