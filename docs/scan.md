# Scan: recognising stops with the camera

Scan opens the rear camera (or takes a photo); in the app it is reached through the **AR** button of a journey
([ar.md](ar.md)), no longer from the ••• menu. Code: `stopvision.ts`, loaded on first use; the photo
database `stop-images/` is built by `tools/build_stop_images.py`.

## What it tells you

Three separate answers, each only as far as the evidence goes:

| Answer | From | Said as |
| --- | --- | --- |
| **Which stop** | The stop name on the sign (OCR), checked against the stops around you | "Recognised" only with a read, distinctive name; GPS, compass and photos alone say "Nearby" |
| **Which edge you're looking at** | Bay letter or destinations on that sign (only text on the same sign as the name), photos of that edge, the compass | "You're looking at Bay B (towards …)", "(probably)" when it is not certain |
| **Which side of the road you're on** | GPS, only for bus/tram stops whose two edges clearly face each other across one road, when the fix is precise enough; or the compass while you look across at the other side's sign | "You're at …; … is across the road", or "not clear from GPS" |

During a journey it adds where your next ride leaves: from this side, from the other side ("Cross over" only when
the stop is recognised, the boarding edge is confirmed and your side is certain), or from another stop. The
boarding edge comes from the route; the Kante engine's `/api/due` confirms it live (by bay letter, or by the
direction the vehicle leaves in where edges have no letters).

When the sign clearly names a stop far from your GPS position, Scan says "Check location: sign and location
disagree" instead of showing the wrong stop.

The sign that was read is **outlined in the picture** (the rest dimmed, a label with the stop and bay; green when
recognised, orange for a conflict). The outline is measured from where the words were read; it disappears when
the phone turns. Map-based pins (approximate) have a dashed border.

## What photos can and cannot do

Reference photos help decide **which stop** (as a tie-breaker; alone they pick the right stop among those around
you about two times in three). They are **not** used to decide which edge or side of the road: 84 % of the
street-level photos look along the road, like a dashcam, so both sides of a stop look alike in them, and only about
21 % of edges (Bern and Zürich) have a photo looking across the road at their own kerb. Edges come from the sign,
the compass, the edge positions in `platforms.js`, the per-edge timetable and `/api/due`.

## How the sign is read

- tesseract.js returns words with their boxes. The stop name is the biggest text on a sign; destinations under it
  are smaller. Big lettering often reads with a low confidence, so all words count for matching names; the
  typical text size uses confident words only.
- Reading passes take turns between Tesseract's sparse-text and page modes and between the upper part and the
  whole frame: each reads signs the others miss.
- Every reading is sent to the app as a `scan:text` event (`{ text, tap }`); platform/bay words are parsed with
  `SIGNLOC.parse` (signloc.ts) when it is loaded.

## Tested

With real Swiss stop-sign photos as the camera feed and simulated GPS/compass (headless Chromium, phone size):
sign + GPS recognised (Simmirank, Aspholz, Buchs Rathaus); no GPS: the big name wins over destinations (Aspholz);
wrong GPS: "Check location"; side of the road correct from both sides of Zürich Aspholz, "not clear" at ±15 m,
no verdict at the Aarau bus station (several bays close together). Missed: signs Tesseract cannot read (busy
scenes, small angled signs) stay "Nearby".

## Reusable by other features

| Piece | Where | What it does |
| --- | --- | --- |
| Sign layout | `layoutOf()`, `locateName()`, `signRegion()` in `stopvision.ts` | OCR words with picture-pixel boxes; where a name is written; the sign plate around it |
| Highlight overlay | `drawHighlight()` | Outline + dim + label for any box in picture pixels on a `object-fit: cover` video or image |
| Side of the road | `sideOf()`, `standing()` | Which of two facing edges you are at, from GPS + accuracy (abstains when unclear) |
| Edge names | `edgeName()`, `towards()` | "Bay A (towards …)" / "the stop towards …" from platforms.js + GTFS lines |
| Next boarding point | `route` hook in `index.html` | The next ride of the journey under way: stop, edge index (also for Kante journeys), line, time, whether the edge is confirmed |
| Live boarding check | `checkRoute()` + `due` hook | Ties a ride to an edge with Kante `/api/due` (quay label or departure bearing) |
| Sign/GPS conflict | in `useText()` | A big, distinctive stop name far from the GPS fix |
| Text events | `scan:text` | Everything Scan reads, for other features (indoor positioning) |
| Word events | `scan:words` | Every word of each reading with its box in picture pixels and confidence (`ScanWordsDetail`), e.g. for vehicle displays (`ARCORE.read`) |
