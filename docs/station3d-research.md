# Station 3D: research on data, a first-person walk, and all Swiss stations

Research notes, 24 November 2026. Every source below was checked on that day, against the live catalogue APIs
(data.sbb.ch Opendatasoft API, opendata.swiss CKAN, the swisstopo STAC API, developer.sbb.ch's portal JSON, Overpass)
or the page named. **Unverified** marks the claims that no page could settle. The background is in
[station3d-solid.md](station3d-solid.md), [sbb-journey-maps.md](sbb-journey-maps.md) and
[../tools/station3d_data/README.md](../tools/station3d_data/README.md).

Licence shorthand: **OGD-BY** is the opendata.swiss "Open use. Must provide the source" terms (`terms_by`), which
data.sbb.ch (https://data.sbb.ch/page/licence), opentransportdata.swiss and swisstopo (https://www.swisstopo.admin.ch/ogd-conditions,
free since 1 March 2021, commercial use allowed) all use. **ODbL** is OpenStreetMap's licence.

---

## 1. More data for accuracy

### 1.1 data.sbb.ch (61 datasets in the catalogue today)

What is new or unused here, in order of value. All are OGD-BY; credit "data.sbb.ch".

| Dataset (id) | What it gives | Coverage | Integration in `build_station3d.py` |
| --- | --- | --- | --- |
| **`21196_behig-haltekantepunkt`** "BehiG Haltekantepunkt" | **Platform-edge points every 1 m** along each stop edge (`punkt_stationierung`), LV95 `e`/`n` + WGS84, track (`kundengleisnr`), edge and kerb lengths, the platform height class in `konformitaet` (e.g. `P 55` = 55 cm, `P 35`), cant/radius (`punkt_uh`, `punkt_radius`), boarding-aid type | 496,187 points, **985 SBB-infrastructure stations**; Zürich HB tracks 3–18, Basel, Bern, Luzern 2–15, Lausanne, Genève, Wankdorf, Bümpliz Nord, Brünnen all present. Last modified **2024-05-08** (static; platforms seldom change) | **Replaces the withdrawn `perronkante`.** A drop-in source for `platform_edges.geojson` (group points by `haltekante_fid`, order by `punkt_stationierung`) → `spans.json`, sector spans along curved kerbs, `extend_platforms` at Zürich, Basel, Luzern, Lausanne, Genève, which today have none. Platform-top height = rail + P-class; this gives level 0 vs. rail level for the generic builder (§3). |
| `21197_behig-haltekantesegment` | The same edges as segments, with `perron_nr`, `perrontyp`, `max_uh` | 11,171 rows (2023-10-27) | The pairing of two edges into one island platform (`perron_nr`), so a generic builder can draw an island between two kerbs. |
| `haltestelle-haltekante` | Every ATLAS stop edge: `length`, `boardingareaheight`, `compassdirection`, station `height` (m a.s.l.) | 30,747 rows, updated 2026-11-17 | Mostly already in `platforms.js`. `height` is a cheap level-0 elevation for stations without measured heights. |
| `perron` | Platform length and **gross/net area** (`perronflach_brutto_m2`, `p_lange`), type (`Mittelperron`, …) | 1,569 rows | **Platform width = area / length**, for synthetic platforms (§3.4). One point per record only. |
| `perronoberflache` | Surface material per platform section (`oberflache`, `flache`), build year | 2,212 rows, 793 stations | Point only (checked: the GeoJSON export has Points, no polygons). Material/colour hint only. |
| `sektortafel`, `haltestelle-uhr`, `billetautomat` | Already used (`tools/station3d_sbb_layers.py`) | sector boards at **378** stations, clocks at 932, ticket machines at 914 | Generalise the script from 10 keys to any stop id. |
| `billetentwerter` (ticket validators) | Points with `gleisebene` ("on the track level": Ja 2,589 / Nein 23) | 2,612 | Another prop layer; `gleisebene` is a level hint the clocks lack. |
| `12093_lautsprecher-akkustikbox` | Loudspeakers with `montage_an` (mounting) | 316 | Minor prop. |
| `haltestelle-wartehallen` | Waiting-room buildings: position, `anzahl_untergeschosse` / `anzahl_obergeschosse` | 938 | Basement/upper-floor counts of small station buildings: a sanity check for the levels of a generic model. |
| `haltestelle-karte-trafimage` | Links to SBB's official plan per station | 63 stations | Already linked. **Link, don't copy** (the plans are not open data). |
| `passagierfrequenz` | Daily passengers per station | 5,724 rows | **The order of the rollout** in §3 (biggest stations first). |
| `bilder-von-bahnhofen` | 20 photos (1280 px), 2018 | 20 stations | A photo card at most; not imagery for 3D. |
| `mobiliar-im-bahnhof` | Counts of furniture types per station (one point per station, lat/lon swapped in the API) | 7,920 rows | **Not usable for placement.** |

Gone: **`aufzugzustand`** (lift/escalator status, Zürich only, every 5 minutes) and **`aufzugsstammdaten`** (129 lifts)
return 404 on data.sbb.ch today; opendata.swiss still lists `elevator-condition` (metadata from 2025-07-24) with dead
links. `perronkante` and `haltestelle-perronkante-inkl-bls` are also gone (404). There is **no open dataset of SBB
lifts, escalators, stairs or ramps** any more.

### 1.2 opentransportdata.swiss: ATLAS and the accessibility (PRM) data

ATLAS v2 since 7 January 2026; the v1 "prm-reference_point-*" files ended on 30 June 2026. All OGD-BY, credit
"opentransportdata.swiss". Downloads are plain CSV (`;`), e.g.
`https://data.opentransportdata.swiss/dataset/reference-point-v2` (landing pages: `…/relation-v2`, `…/platform-v2`,
`…/stop-point-v2`, `…/toilet-v2`, `…/parking-lot-v2`, `…/contact-point-v2`, `…/service-point-v2`, `…/bfr-rollstuhl`).
Cookbook: https://opentransportdata.swiss/en/cookbook/accessibility-cookbook/.

What the files hold (from the files themselves):

- **Reference points** (1,876 at 1,781 stations): name and type only (`MAIN_STATION_ENTRANCE` 1,363, `PLATFORM` 391,
  `ALTERNATIVE_STATION_ENTRANCE` 103, `ASSISTANCE_POINT`, `INFORMATION_DESK`). **No coordinates.** Bern has two
  ("Hauptzugang via Bahnhofplatz", "Zugang Welle/Passarelle via Schanzenstrasse").
- **Relations** (6,148): reference point → element (platform 4,109, parking 1,040, toilet 582, contact point 417) with
  `stepFreeAccess` (`YES` 3,327, `YES_WITH_RAMP` 1,280, `YES_WITH_LIFT` 462, `NO` 813, `TO_BE_COMPLETED` 114,
  `NOT_APPLICABLE` 152), `tactileVisualMarks`, `contrastingAreas`. **No path geometry**: a yes/no per pair, not a route.
- **Platform (stop edge) PRM** (52,140 rows): `height` (cm), `inclination`, `levelAccessWheelchair`, `boardingDevice`
  (e.g. `LIFTS`), `vehicleAccess`, wheelchair-area size.
- **Service points** (`service-point-v2`): every stop with LV95/WGS84 and `height`; **1,710 Swiss stop points carry
  `TRAIN`** (plus 63 rack railways, 28 metro, 579 tram). Coordinates get rounded from Dec 2026/Jan 2027 (notice on the
  dataset): keep the builder tolerant of that.

Integration: no geometry, so it **checks** rather than **draws**. The builder already reports step-free reach. Compare
it per platform with `stepFreeAccess` from the main entrance (`YES_WITH_LIFT` but the model has no lift → a missing lift
in OSM; `NO` but the model finds a step-free way → a wrong tag). Use it as a quality gate in §3, and show the official
step-free verdict next to the router's. Toilets/contact points without coordinates can only be matched by name to OSM
POIs.

**Live lift outages.** The SIRI-SX / VDV736 event feed (https://opentransportdata.swiss/de/cookbook/event-cookbook/siri-sx/)
says verbatim *"Über diesen Feed werden unter anderem auch Liftstörungen kommuniziert"*. It is XML, one document of
all events, with endpoints `siri-sx` (planned, limited to 48 queries a day and 10 an hour) and `siri-sx-unplanned`
(refreshed every 30 s), plus GTFS-RT Service Alerts. It needs an API-Manager key (Bearer). **Unverified:** how a single
lift is identified in the messages (a SLOID of the stop or edge? free text?). The Swiss realization guide
(https://www.tp-info.ch/sites/default/files/2024-07/realization_guide_siri-sx_oev_schweiz_v1.0.pdf) could not be read
as text here. If lifts are referenced only by stop + text, the app can show "lift outage at this station" but not
close a specific lift in the router. Next step: pull one day of `siri-sx-unplanned` and grep for lift events. A
server-side poller is required (key, rate limits); never put the key in `config.js`.

### 1.3 developer.sbb.ch (45 APIs listed, all "scope PUBLIC" = listed, not open)

Checked through `https://developer.sbb.ch/public/api/apis/<name>` and `/plans`:

| API | Status |
| --- | --- |
| Journey-Maps-Tiles | "SBB internal application use only … We do not approve non-SBB subscription requests" (unchanged since [sbb-journey-maps.md](sbb-journey-maps.md)). |
| **Journey-Routes** (indoor + pedestrian routing, "orientation support at stations for people with visual impairments") | "for internal SBB consumers and approved contractors only". All six plans need approval. |
| Journey-Maps (API key) | Marked **DEPRECATED**. |
| **Journey Places** (POIs, stop places) | All plans need approval. Its target customers are SBB channels, Trafimage, HAFAS and PT operators; POI fields are further gated by Azure AD roles. Not usable for an independent app. |
| G-SHARP "geo" (SBB ArcGIS Enterprise) | Approval required; no description of open layers. |
| Signaletik Editor pictograms (official SBB pictograms, SVG) | Approval required; external use bound by https://brand.sbb.ch/document/4#/markenelemente/piktogramme-1. Use open icons unless SBB approves. |
| atlas API | `Read` plan **without approval**: the live version of the ATLAS CSVs above. |

**So: there is still no public SBB indoor geometry or indoor routing API.** HERE's "Indoor Map as a Service" with SBB
as first customer is commercial and not open (press release https://www.here.com/about/press-releases/here-launches-indoor-map-as-a-service-with-sbb-ag-as-first-customer;
terms for third parties unverified).

### 1.4 swisstopo (all OGD-BY; credit "© swisstopo"; download per tile through STAC `https://data.geo.admin.ch/api/stac/v1/collections/<id>/items?bbox=…`)

| Product (STAC id) | Format, resolution | What it adds | Integration |
| --- | --- | --- | --- |
| **swissBUILDINGS3D 3.0 Beta** (`ch.swisstopo.swissbuildings3d_3_0`) | Per map sheet, CityGML / FileGDB / DWG, LoD2 with roof overhangs; solids or separate roof/facade/footprint | Station halls, roofs, **platform canopies where captured** (Bern's `shell_mesh.json` came from it; canopy coverage elsewhere unverified) | Generalise the Bern step (`scripts/enrich/` in the research repo) to any bbox: clip the sheet, keep buildings touching the extent, write `shell_mesh.json`. Version 2.0 is no longer updated. |
| **swissSURFACE3D** (`ch.swisstopo.swisssurface3d`) | Classified LiDAR, 1 km² LAZ tiles (Bern: 2023 flight) | Heights of platforms, canopies, bridges and footbridges, measured | Spot heights for `spots` / `heights.json` automatically: sample class-2 ground on platform polygons (level 0), class-6/17 on footbridges. The roof hides the floor of halls and nothing sees underground. |
| **swissALTI3D** (`ch.swisstopo.swissalti3d`) | DTM, 0.5 m and 2 m COG tiles | Street level at each entrance, underpass mouths | Already used through the height service (`api3.geo.admin.ch/rest/services/height`); for 1,700 stations read the 2 m COGs with HTTP range requests instead of one call per point. |
| **swissTLM3D** (`ch.swisstopo.swisstlm3d`; national GDB/SHP/INTERLIS, not tiled) | 3D vectors | Railway centre lines with tunnel/bridge structures, roads, paths, stops (`TLM_HALTESTELLE`, per the 2025 release notes) | Tracks and bridge decks where OSM is thin; a second opinion on which paths are tunnels. Whether it holds platform polygons or pedestrian underpasses as objects is **unverified** (object catalogue not checked). |

### 1.5 OpenStreetMap indoor coverage (measured)

Overpass over Switzerland (24 Nov 2026), counted within 250 m of each of the 1,710 ATLAS train stop points (a proxy:
road underpasses and nearby shopping centres count too):

| Within 250 m of a train station | Stations |
| --- | --- |
| a platform way/area (`railway=platform` / `public_transport=platform`+`train`) | 1,499 (88 %) |
| any `highway=steps` | 1,293 |
| …of which with `step_count` | 690 |
| a footway with `tunnel=*` (underpass) | 856 |
| a footway with `bridge=*` | 528 |
| `highway=elevator` | 230 |
| any `indoor=*` | 989 |
| ≥ 20 `indoor=*` features (real indoor mapping) | **42** |
| any `level=*` | 642 |

The best indoor mapping: St. Gallen (906 `indoor` features), Rapperswil, Zürich Flughafen, Zürich HB, Bern,
Prilly-Malley, Basel SBB, Luzern, Winterthur, Chur, Aarau, Lausanne-Flon, Genève, Zug, Basel Bad Bf, Schaffhausen,
Baden, Nyon, Olten, Zürich Oerlikon, Biel/Bienne. Escalators were not counted (OSM tags them `highway=steps` +
`conveying=*`).

The path to better data: OSM itself (survey, Simple Indoor Tagging https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging),
and SKI+'s OSM guidance for public transport (https://tp-info.ch/sites/default/files/2024-08/ski_osm_ueberlegungen_v0.9.0_0.pdf,
draft v0.9.0; contact opendata@sbb.ch). Mapillary imagery may be used to map into OSM (https://help.mapillary.com/hc/en-us/articles/115001770409).

### 1.6 Imagery (Mapillary, Panoramax, Street View, SBB)

See §2.3: none gives indoor geometry, and none is a source to copy into the model beyond what OSM mappers derive.

---

## 2. A first-person walk through the route

### 2.1 Feasibility

Feasible in the existing renderer (`src/station3d-solid.ts`) with no new data. The route already has `points`
([x, y, level]), `steps[]` with `from`/`to` indices, `seconds` and `kind`, and the renderer has `zOf`, `V()`, a
`setStretch` and the corridor cutaway. (An earlier first-person walk existed in the removed `station3d.js`.) What
decides whether it looks like the station is **content**, not camera code (§2.2).

### 2.2 Camera (recommendations, three.js 0.170)

1. **True heights in first person.** Switch to `S = 1` on entry (`setStretch(1)`, restore on exit). Stretched
   stairs/escalators at ×2.2 look absurd at eye level.
2. **Path.** Points from `route.points` with `V(x, y, zOf(l))` at `S = 1`, plus eye height (1.65 m; 1.2 m for a
   wheelchair profile). Drop points closer than 0.3 m. Put extra points at both ends of every stair/escalator/ramp piece
   (from `steps[].from/to`) so the spline cannot cut a corner through a wall or float off a landing. Then
   `new THREE.CatmullRomCurve3(pts, false, 'centripetal')` (centripetal: no overshoot or loops at sharp corners), and
   drive it by arc length (`getPointAt(u)`, `getUtoTmapping`). Keep straight connector pieces linear: use one curve per
   flat stretch and a straight `LineCurve3` per connector, joined in a `CurvePath`.
3. **Timing.** Map arc length to the router's `steps[].seconds`, so the replay runs at the speed the router assumed,
   then speed it up (×4 default, ×1/×2/×8 buttons). Flat ≈ 1.3 m/s, escalator at belt speed (0.5 m/s, no head bob),
   stairs slower.
4. **Lifts** (two points with the same xy and different z): stop. Turn to face the doors (towards the previous point),
   show "Lift to <level name>", rise or fall with an ease (≈ 1 m/s, scaled) inside the glass shaft, then turn to the
   exit direction. Don't let the spline interpolate through a shaft.
5. **Looking.** Yaw from a horizontal look-ahead (6–8 m on flat floors, 2–3 m on stairs/connectors, so the view
   doesn't point through the wall of a turning stair). Pitch from the slope, clamped to ±20° (looking down an
   escalator). Smooth with `camera.quaternion.slerp(target, 1 - Math.exp(-dt * 6))`, which is frame-rate independent.
   Build the target with `Matrix4.lookAt(eye, aim, up)` → `Quaternion.setFromRotationMatrix`.
6. **Clipping.** Near plane 1 m today: set `camera.near = 0.05`, `far ≈ 800` and `updateProjectionMatrix()` in first
   person; restore after. Use `controls.enabled = false` while playing.
7. **Cutaway.** The corridor cutaway discards everything above the route, so from inside the ceiling vanishes. Set
   `uN = 0` and `uCutY = 1e6` in first person. The slabs must then be visible from below (`side: DoubleSide`, or a thin
   extrusion) so they act as ceilings.
8. **Fog.** `scene.fog = new THREE.Fog(bg, 12, 90)` (shorter underground): it hides the missing walls in the distance
   and gives depth. Labels need the same distance fade.
9. **Controls.** Play/pause, a scrub bar on arc length with ticks at step boundaries (the step text shows as a
   caption; scrubbing updates **Next ›** as well), drag-to-look while paused (a yaw/pitch offset that slerps back on
   play), "exit to overview" (animate back to the orbit pose). Honour `prefers-reduced-motion`: cut from step to step
   instead of flying.
10. **Performance.** The labels are already capped at about 15. With the fog, lower `far` and skip the trains and
    shells beyond about 150 m.

### 2.3 What eye level needs, and the imagery

From eye level, OSM gives floors, kerbs, the walls on level 0, pins and connectors. To be recognisable:

1. **Walls and ceilings below ground (synthetic, flagged).** Extrude the `edge` kerbs of indoor floors (`indoor=*`,
   `tunnel=*`, `covered=yes`) to the room height (2.6–3.0 m) in first person only, in a neutral material, and close the
   top with the slab of the level above, or a ceiling at +3 m. They are outlines OSM already has, not invented
   geometry; say in the UI that they are schematic. Derived floors (`derived: true`) keep kerbs only.
2. **Platform canopies and hall roofs.** From swissBUILDINGS3D (as at Bern) and OSM `building=roof`/`train_station` with
   heights. The most recognisable thing on a Swiss platform.
3. **Signs at eye level.** Platform number boards at stair heads, sector letters hanging where `boards.json` says
   "hanging", shop names as fascia boards (the pins moved to the nearest kerb/wall and facing the corridor), and the
   direction signs the route itself implies at decision points ("Gleis 7 ↑"). Use open icons, not SBB pictograms
   (approval required, §1.3).
4. **The train** at the platform (the hologram exists) is the last frame of a boarding walk.

**Imagery — legally usable?**

| Source | Licence / terms | Usable? |
| --- | --- | --- |
| Google Street View (Zürich HB and ShopVille are covered indoors, per https://www.pctipp.ch/themen/news/so-erkunden-sie-den-hb-zuerich-mit-google-street-view) | Google Maps Platform terms: no export, extraction, scraping or storing of Street View images outside the Services; only `pano_id` may be cached (https://cloud.google.com/maps-platform/terms/maps-service-terms) | **Not as textures or for tracing.** At most a separate, embedded Street View panorama through the Maps JS API (key, billing, Google's terms); not recommended. |
| Mapillary | Images CC BY-SA 4.0 (https://help.mapillary.com/hc/en-us/articles/115001770409); data derived for OSM allowed | Usable as a photo with attribution and share-alike; deriving into OSM allowed. **Indoor coverage of Swiss stations unverified** (the API needs a token; not queried). Best use: a "photo here" link at a step, and a source for OSM mappers. |
| Panoramax | CC BY-SA 4.0 on most instances (etalab-2.0 at IGN) | No Swiss instance found; coverage of Swiss stations unlikely. |
| SBB 360° panoramas | None found (no official SBB station tours) | — |
| data.sbb.ch `bilder-von-bahnhofen` | OGD-BY, 20 photos from 2018 | Photo cards only. |

**Recommendation:** no photographic textures. Clean, schematic architecture (walls, ceilings, canopies, signs) plus
fog is enough for orientation and stays within "nothing is invented".

---

## 3. All Swiss stations

### 3.1 Numbers

- **1,710** Swiss ATLAS stop points with `TRAIN` (service-point-v2, 24 Nov 2026), plus 63 rack-railway stops.
- **About 1,050** have a pedestrian tunnel or bridge or a lift within 250 m (856 underpass, 528 footbridge, 230 with
  lifts), i.e. a multi-level way to the platforms (an upper bound: road underpasses count too).
- **42** have real indoor mapping (≥ 20 `indoor=*` features); **about 640** have some `level=*` nearby; **690** have
  stairs with `step_count`.
- **1,499** have a platform drawn in OSM; **985** have 1 m platform-edge points from SBB (§1.1); **378** have sector
  boards.

### 3.2 What is hand-configured today, and what can be derived

From the `STATIONS` table in `tools/build_station3d.py` (≈ 790 lines for 10 stations):

| Key | Today | Derivable automatically from |
| --- | --- | --- |
| `name`, `origin` | by hand | ATLAS service point (`designationOfficial`, WGS84) |
| `uics` | by hand | ATLAS service points within ~300 m whose name starts with the station name ("Bern", "Bern, Bahnhof", …) + the stop places of the same `parentSloid`; cross-check `platforms.js` |
| `bbox`, `extent` | by hand | the hull of the stop edges + OSM platforms + the stairs/tunnels touching them, buffered by 60–100 m; `extent_cut` only by hand |
| `levels` (heights, names) | by hand, with evidence in comments | levels present on public ways in OSM; heights from step counts × 0.17 m (the builder already does this), swissSURFACE3D/ALTI3D spot heights, SBB P-class for the platform top; defaults −4.5 m for an underpass and +6.5 m for a footbridge (to be confirmed from a sample: unverified); names by type: "Platforms", "Underpass", "Footbridge", "Level −2" |
| `level_height` | by hand | constant default (4.0) |
| `entrances` | by hand | OSM `entrance=*` nodes, else where a station path leaves the extent at street level; the ATLAS main-entrance **name** (no position) can label the nearest one |
| `layers` | by hand | whatever `station3d_sbb_layers.py` finds for the stop id |
| `ground`, `spots`, `spot_heights`, `structures` | by hand | mostly swissALTI3D/SURFACE3D sampling (street, bridge decks) |
| `osm_edits`, `skip_edges`, `stop_areas`, `stop_names`, `links`, `level_shift`, `squares`, `decks`, `area_names`, `exit_names`, `closed`, `notices`, `opens` | by hand, with evidence | **not derivable**: these are corrections. A generic build gets none, and the station gets a hand entry only when its checks fail. |

### 3.3 A generic builder

1. **One OSM extract, not 1,700 Overpass calls.** Geofabrik's `switzerland-latest.osm.pbf` (552 MB, daily) →
   `osmium extract -b <bbox>` per station → the same Overpass-JSON shape the cache uses (`--osm FILE`). Same for the
   SBB layers: one bulk download per dataset, filtered by stop id.
2. **`auto_station(uic)`** produces a `STATIONS` entry (§3.2); a hand entry overrides it field by field. The 10 existing
   entries stay as they are.
3. **Levels** from OSM `level=*` where present; else from what the builder already does (platform on the level of its
   track, `repair_crossings` for bridges/tunnels over tracks, step counts). Add a fallback height for an underpass or a
   bridge with neither steps nor `level`: swissSURFACE3D on the deck, else the default.
4. **Quality gates, automatic**: all stop edges connected; every entrance reaches every platform; step-free reach
   compared with ATLAS `stepFreeAccess` (§1.2); the platform outline within 3 m of the SBB kerb points; no level
   without walkable space. Result: a grade, `full` / `basic` / `fail`, written into the model and the index.
5. **Tiers**:
   - **A, hand-tuned** (today's 10, then the next 20–40 by passengers: Winterthur, St. Gallen, Zürich Oerlikon,
     Zürich Stadelhofen, Zürich Flughafen, Olten, Aarau, Biel, Zug, Baden, Chur, …): auto entry + a reviewed hand entry.
   - **B, auto, multi-level** (≈ 1,000): the generic builder; published when the gates pass.
   - **C, at-grade** (≈ 650: platforms reached at street level or by a level crossing): a model with one level is
     enough; the route is a walk along the platform.
   - **Failures** fall back to §3.4.
6. **Run** as a scheduled job (weekly), not by hand; the log names the stations that changed grade.

### 3.4 Fallback for poor OSM data (schematic, labelled as such)

When OSM has no usable platform or way between platforms:

- **Platforms** from SBB's kerb points (`21196`): each edge is a polyline; island platforms pair two edges (`21197`
  `perron_nr`); the width from `perron` area ÷ length; the height from the P-class. Without SBB data (private
  railways: BLS, RhB, …): ATLAS edge position + `length` + `compassdirection` as a straight platform of default width.
- **Tracks** from OSM `railway=rail`, else swissTLM3D.
- **Access**: an OSM footway `tunnel=yes`/`bridge=yes` crossing the tracks within the platform span becomes an underpass
  or footbridge, joined to each platform it crosses by a generic stair. **No invented underpass** when nothing is
  mapped: show "the way between the platforms is not mapped" and the official plan link where one exists.
- Every synthetic part carries `derived: true` (already in the schema), and the model `schematic: true`, so the viewer
  draws it lighter and says so.

### 3.5 Size and loading

Measured on today's files (model + solid companion): Bümpliz Nord 23 KB (7 KB gzip), Brünnen 36 KB (9 KB),
Wankdorf 78 KB (19 KB), Luzern 241 KB (56 KB), Zürich HB 652 KB (137 KB).

Estimate for all 1,710: ~1,550 small × 35 KB + ~130 medium × 150 KB + ~25 large × 500 KB ≈ **90 MB raw, ≈ 20 MB
gzipped** (estimate, not measured). That is fine as static files on demand, one station per view, as today.

- The index (`stations3d/index.js`) grows to ~2,500 stop ids, ≈ 50 KB; split it out of the start-up path (load it
  with the first map card) or put it in `platforms.js`, which already has every stop.
- Keep the two files per station (model for routing/position, solid for drawing). Optionally merge them for tier C.
- Don't commit 90 MB of generated files to the app repository: publish them as a build artefact (a release asset or a
  separate `gh-pages`/CDN branch), with a manifest of `{key, built, grade, bytes}`.

---

## 4. Recommendations, in order

1. **Use SBB's 1 m platform-edge points (`21196_behig-haltekantepunkt`)** for `platform_edges` / `spans` at Zürich,
   Basel, Luzern, Lausanne and Genève now: it replaces the withdrawn `perronkante` and covers 985 stations. Low effort,
   high accuracy.
2. **Check every model's step-free reach against ATLAS `stepFreeAccess`** (relation-v2) and print the disagreements:
   it finds OSM errors at no cost and is the quality gate for §3.
3. **First-person walk** (§2.2): `S = 1`, near 0.05, centripetal Catmull-Rom by arc length, lift pause, slerped look,
   fog, cutaway off. Then **synthetic walls/ceilings from the existing kerbs** in first person only, and eye-level signs.
   No photographic imagery (Street View is not allowed; Mapillary coverage indoors is thin and share-alike).
4. **Generic builder** (§3.3): Geofabrik extract + `auto_station(uic)` + automatic gates + tiers; roll out by
   `passagierfrequenz`. Start with the 30 busiest stations, review them, then the rest in bulk.
5. **swissBUILDINGS3D canopies/halls and swissSURFACE3D spot heights** generalised from Bern to any bbox.
6. **Lift outages from SIRI-SX** (`siri-sx-unplanned`) through a small server-side poller, after checking how a lift is
   identified in the messages (unverified).
7. Keep asking SBB (gis@sbb.ch, opendata@sbb.ch) for an open indoor layer. As of today Journey-Maps-Tiles,
   Journey-Routes and Journey Places all require approval for SBB or its contractors.
8. **Improve OSM** where the gates fail: the generic builder's report is a to-do list for mappers.
