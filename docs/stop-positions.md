# Stop positions and directions (`platforms.js`)

Built 21 Nov 2026 by `tools/build_platforms.py` from the ATLAS export of that day plus the OpenStreetMap
Switzerland extract (Geofabrik, same day), via `tools/extract_osm_stops.py`.

## What changed against the previous `platforms.js`

Official ATLAS positions and directions are kept as they are. The build only adds data where ATLAS has none,
and marks every point that is not fully official with a 6th field `src`:

| `src` | Meaning | Points |
|---|---|---|
| (none) | position and direction from ATLAS | |
| `o` | position from an OSM stop pole (the stop has no ATLAS boarding point) | 116 poles at 113 stops |
| `b` | direction estimated from the road beside the point, not official | 17,178 |
| `s` | no boarding data anywhere: only the stop's own position, **not a place to stand** | 392 stops |

- Stops whose points all say 0° (290 stops): 0° is a placeholder, now treated as no direction.
- Bus stops with two or more points but a missing direction: **10,331 → 5,567**.
- Floor levels (275 platforms) and all official positions are unchanged. Exceptions: one level that OSM changed since
  the last build, and a few stops that differ because today's ATLAS export is newer.

### How a direction is estimated
Nearest road (bus) or road / tram track (tram stop) within 25 m of the point. On a one-way road it is the
one-way direction; otherwise it is the direction that has the point on its right (traffic keeps right). No answer when
the point lies within 1.5 m of the road's centre line or two roads that run different ways are equally close (a
junction). The estimate is also dropped when a two-point stop would then have both points facing the same way.

## Checks

**Against official directions** (printed by every build): of 19,297 points with an official direction, 13,321 get an
estimate and 90.8 % of those are within 60°. On a sample of the misses, many of the "errors" were official directions
pointing across the road into a field or building, so this understates the rule.

**Pair test** (the 5,154 two-point bus stops with opposite official directions, 10,308 trips): the estimate picks
the right point for **96.1 %** of the trips it decides (279 wrong). The app's keep-right fallback is wrong for
13.5 %. It stays silent for 30.7 % of trips, where the app falls back as before.

**OSM pole positions** against official points, at stops that have both: median 5.8 m apart, 88 % within 15 m.
At the 113 filled stops the poles sit a median of 12 m from the old stop position (up to 233 m).

**Blind check on aerial photos** (swisstopo SWISSIMAGE, 65 random points, 4 reviewers who did not know a point's
source; "decided" leaves out "unclear"):

| Group | n | Position at a stop or kerb | Direction correct (of decided) |
|---|---|---|---|
| A: new OSM poles | 12 | 12 (1 with visible stop marking) | 3 of 3 |
| E: the old stop-only points those replace | 12 | 11, 1 on a roof 20 m from the bus bay | – |
| B: official point, estimated direction | 26 | 25 (1 in a car park, an ATLAS position) | 22 of 25 (1 reversed, 2 across) |
| C: official point, official direction (control) | 15 | 15 | 11 of 13 (1 reversed, 1 across) |

Estimated directions do about as well as official ones (88 % vs 85 % on this small sample). Bern, Mittelstrasse
(8571358) now has estimated directions 314° and 137°; both match the kerb side on the photo.

## Not done
- Stops where ATLAS has one point but OSM shows poles on both sides: the missing side is not added.
- ATLAS positions are not corrected (one sample point sits in a car park).
- `index.html` reads `src` into each edge but does not show it yet (task A of the handoff: label `estimated` /
  `unknown`).
