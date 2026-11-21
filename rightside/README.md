# RightSide (native iOS) inside Santiago de Claude

RightSide is the native SwiftUI/ARKit companion to the Santiago de Claude web app: journey guidance on an
iPhone, with the camera used to find the right boarding point and to read the route number and destination on
an arriving bus or tram.

It was imported unchanged from the RightSide source snapshot of 21 November 2026
(`rightside-source-20261121.zip`, SHA-256 `f53023d668799f6e48f1b8783a1fa8cd7e33c5d2813a4cf5f9c3ce95756e6850`).
The directory layout of that snapshot is kept, so the scripts' relative paths still work:

| Path | What it is |
| --- | --- |
| `redesign/apps/ios/` | The active iOS app: Xcode project, sources, bundled models and data packs, XCTest targets. Its own README has the build history. |
| `redesign/scripts/` | Development and evaluation scripts from the RightSide project. Several refer to recordings that were not transferred. |
| `scripts/` | iPhone build/install helpers and the vehicle report test. |
| `SOURCE-NOTE.txt` | The note that came with the snapshot. |

The app is built on a Mac with Xcode (see `redesign/apps/ios/README.md`). It is not part of the static site:
the GitHub Pages workflow copies only the site's own files. Text files here are kept with LF line endings (`.gitattributes`), because
the Xcode project and shell scripts are used on macOS.

Bundled third-party models and their licences are listed in
`redesign/apps/ios/RightSide/Resources/TransportPacks/model-manifest.json` (YOLOE, AGPL-3.0, needs a licensing
review before any proprietary release) and `redesign/apps/ios/RightSide/Resources/VehicleDisplayRecognition/v1/`
(PP-OCRv5 latin recogniser, Apache-2.0).

## Changes made here (21 Nov 2026)

### Bus and tram recognition: compare the display with the stop's departures

The snapshot compared OCR text with the selected ride by exact spelling. On recorded Bern footage it never
accepted the right vehicle and warned "wrong vehicle" for 25–49 % of right vehicles: "9 Wabern" is not spelled
"Wabern, Tram-Endstation", "Soali" is a misread of "Saali", and adverts or a van's phone number parsed as
"line e" or "line 031".

- `Sensors/DepartureDisplayMatcher.swift` scores every display row of a vehicle against the services that can
  actually stop here: the selected ride plus the departure board of the boarding stop. A service only wins if
  it explains the glyphs clearly better than every other one (margin), with LED-aware edit costs (O/0, a/o, f/t,
  W/M/U …), optional locality ("Bern Wankdorf, Bahnhof" → "Wankdorf Bhf"), via rows and brand words handled.
  OCR text is never rewritten; the result is a scored choice or an honest "ambiguous / unlisted / unreadable".
- `Sensors/VehicleEvidence.swift`: the decision uses that evidence over the existing 3-frame / 0.8 s window.
  A clearly different listed service is **named** ("Display shows 10 Ostermundigen, Rüti · not your service").
  The old exact rule now needs a credible contradiction in two distinct frames. Without a board the closed-set
  path keeps the snapshot's 0.7 confidence floor. Authoritative trip binding rules are unchanged.
- `Sensors/DepartureBoardCandidates.swift` + `UI/ContentView.swift`: opening the camera loads the boarding
  stop's departures (OJP SLOID → stationboard id: `ch:1:sloid:2905` → `8502905`) and passes them in.
- Measured on recorded video with a PC stand-in for the phone's OCR (`tools/display-bench`): on a held-out set
  labelled after the code was frozen, right vehicles accepted 0 % → 66 %, false "wrong vehicle" alarms
  49 % → 0 %, wrong vehicles accepted 0 % throughout. Matching costs ~2 ms per frame.

### Confidence-ranked frames and live vehicle evidence (GPS, compass, Kante engine)

- **Per-frame confidence** (`DisplayBoardMatch.confidence` × `DisplayReading.frameQuality`): destination fit ×
  route-numeral evidence (read / confusable / unread / contradicted) × margin over the next service × the OCR
  engine's score of the text used × the segmentation quality of the frame (detector score, vehicle size).
- **Decision** (`VehicleServiceMatcher.boardEvidence`): the three most confident frames of the last 2 s are the
  evidence. Two of them agreeing is the consensus (the "baseline"). Without a consensus the single most
  confident frame decides if its confidence is ≥ 0.6 and no other frame reads another service at half its
  confidence or more; the badge then says "Best reading matches · check the display yourself". Without a
  departure board the snapshot's strict 3-frame rule is unchanged.
- **Kante `/api/due`** (`Sensors/VehiclePositionEvidence.swift`): while the journey camera runs (not offline,
  not simulated) it asks every 15 s what is about to stop at the boarding stop — by stop id, so no position
  leaves the phone when the stop is known; otherwise lat/lon with 150 m. Due trips join the candidate services
  (headsign = what the display shows, vias included). Engines without `due` (`/api/meta` → `features`) fall
  back to `/api/vehicles` positions.
- **Position likelihood per detected vehicle**: timing (at the stop or due within 60 s → 1, fading to 0.2 at
  5 min, departed > 20 s ago → 0; timetable-only/stale times count less sharply) × direction (an approaching
  vehicle must appear on the side it arrives from: the camera's true heading — fused compass + GPS + walked path
  from `GeoARAlignment`, else the compass — plus the box's angle in the image from the camera intrinsics,
  compared with the reverse of Kante's `approachBearing`). The likelihood adds at most 0.30 to a service's score:
  enough to break a tie such as tram 9 vs 20 to Wankdorf when the numeral is unread, never enough to override a
  readable, different display (a read route number is worth 0.60).
- **Data check**: live `/api/due` for Bern, Bahnhof (saved in `tools/portable-tests/fixtures/`) listed 23 bus/tram
  display identities; 20 are spelled exactly as on the transport.opendata.ch board.
- **Results** (dev / held-out, `tools/display-bench`): right vehicle accepted 41 % → 69 % / 66 % → 77 %; still
  no false "wrong vehicle" alarm and no wrong vehicle accepted. Of the held-out acceptances 22 of 27 rest on the
  best single frame. The videos carry no GPS or compass, so position evidence is measured only in simulation
  (`--positions`, `--positions-degraded` with missing vehicles, decoys at the stop and ±30° compass bias): wrong
  vehicles flagged 72 % → 79 % (75 % degraded), still no wrong vehicle accepted.

### AR journey guidance without Apple geographic AR coverage

- `Spatial/GeoARAlignment.swift` estimates the transform between ARKit's world (visual-inertial odometry) and
  east/north metres from compass headings, GPS fixes and the shape of the walked path, with an honest σ.
  `ARRouteGuidance` decides what may be drawn: ground arrows only if the lateral error 10 m ahead is ≤ 3.5 m,
  one direction arrow up to 15 m, otherwise nothing ("use the map").
- `Spatial/ARRouteGuide.swift` draws the walking route as ground chevrons and the boarding point (the resolved
  edge/platform when known) in the journey camera. Skipped for simulated journeys and while Apple geo AR runs.
- The journey camera opens directly when a journey is active (was the 3D mesh scanner).
- Simulation (`tools/portable-tests`, 200 seeded walks, GPS σ ≈ 5 m with correlated drift, compass bias up to
  ±24°): median heading error 15° standing (compass only) → 7° after 40 m of walking; the reported 2σ covered
  the true error in 99–100 % of runs.

### Validation status — what was and was not run

| Check | Where | Result |
| --- | --- | --- |
| Portable logic (`tools/portable-tests`, 63 checks incl. restated snapshot XCTest assertions and live Kante fixtures) | Swift 6.4.3, Linux (WSL) | pass |
| Swift 6 strict-concurrency type-check of the portable files | same | pass |
| Recorded-video benchmark, dev + held-out (`tools/display-bench`) | same + Python/ONNX on PC | see its README |
| Syntax parse of every changed iOS file | swift-frontend `-parse` | pass |
| **iOS compile, XCTest targets, UI tests** | needs Xcode on the Mac | **not run** |
| **Physical iPhone: camera OCR rate, AR arrow placement, compass behaviour, thermal** | needs the phone | **not run** |

The UIKit/ARKit/SceneKit code (`ARRouteGuide.swift`, the camera view and controller changes, `ContentView`)
has only been syntax-checked and reviewed. Build it in Xcode before installing. On the phone, check in
particular: the heading Core Location reports while the phone is held upright (used as the compass prior),
chevron height (drawn 1.4 m below the camera), and whether Apple Vision reads LED displays more or less often
than the PC stand-in.

### Next steps worth doing

- Restrict candidates to the boarding edge (`/api/due?quay=`) once the journey resolves the quay id.
- Validate the camera heading, field of view and `/api/due` timing on the phone at a real stop.
- Record a few real passes on the iPhone through the existing indoor/replay lab and add them to the benchmark.
- Feed the walked-path alignment from ARKit plane detection (actual ground height instead of 1.4 m).
