# SBB Journey Maps, and getting along without it

SBB's indoor station plans (floors, rooms, shop outlines, level switching) are in the **Journey Maps Tiles** API, the
map behind the SBB app. This page covers how a key is obtained, why this project does without one, and what it uses
instead. It was checked on 2026-11-21 against the portal's own data: `https://developer.sbb.ch/public/api/apis/journey-maps-tiles`
and `.../plans`, the JSON behind the product page.

## How a key is obtained, and why we don't have one

1. Sign in at **https://developer.sbb.ch/apis/journey-maps-tiles** (SwissPass login, among others).
2. Create an application.
3. Subscribe it to **Journey-Maps-Tiles** with the plan **"Unlimited"**, the only one. It costs 0 CHF, counts hits
   per method with no published limit, and needs approval (`approvalRequired: true`).
4. The key is the application's `api_key`, a query parameter on the CDN:
   `https://journey-maps-tiles.geocdn.sbb.ch/styles/journey_maps_bright_v1/style.json?api_key=…`.

The product description says, verbatim: *"Journey Maps Tiles is intended for SBB internal application use only. This
is not an API for a public audience or open data map tiles source. We do not approve non-SBB subscription
requests."* For public maps it points to Trafimage, and it gives gis@sbb.ch for advice.

The neighbouring APIs are closed in the same way:
- **Journey-Routes** (indoor and pedestrian routing) is "for internal SBB consumers and approved contractors only".
- **Journey Places** (POIs) needs approval and Azure AD.

A production key from the portal was tried on 2026-11-21. Every request was refused with 403 "forbidden", the same as
with no key: the subscription was not approved.

**So this project does not use Journey Maps.** If an approved key ever exists, it belongs in the build only, on the
developer's machine (an environment variable). It does not go in the site's `config.js` (sent from every browser) or
behind a proxy (which would republish SBB-internal tiles). Nothing derived from the tiles goes into the repository
before the subscription's terms allow it.

## What we use instead

| Need | Open source used | Notes |
| --- | --- | --- |
| Floors, corridors, stairs, escalators, lifts, platforms | **OpenStreetMap indoor tagging** (Simple Indoor Tagging) | The best open source. SBB's own mapping team maintains it at the big stations. The builder checks every stop and entrance is connected and reports step-free reach. |
| Heights of the floors | OSM step counts and `ele`, swisstopo heights | Each level table states its source (`tools/build_station3d.py`) |
| Sector signs, clocks, ticket machines, platform lengths | **data.sbb.ch** open data | `tools/station3d_sbb_layers.py` |
| Station shells and roofs | swisstopo swissBUILDINGS3D | Bern so far (`tools/station3d_data/bern/`) |
| Shops and services | OSM points | Drawn as pins with names. Not outlines: none are invented. |
| **The official plan, for the traveller** | data.sbb.ch `haltestelle-karte-trafimage` | SBB's own plan of each station: the interactive plan at plans.trafimage.ch, or the A4 PDF. The dataset has 63 stations, including all the modelled big ones, and it can be queried by stop id from the browser (CORS open): `…/datasets/haltestelle-karte-trafimage/records?where=bpuic in (8503000)`. A 3D view can link it. Link, don't copy: the plans are not open data. |

What this leaves out compared with Journey Maps:
- walls below ground;
- outlines of shops and rooms (OSM has points);
- SBB's names for some areas.

The continuous view says so instead of guessing ([station3d-solid.md](station3d-solid.md)).

The way to close that gap without SBB's data is to **improve OpenStreetMap**: survey a station on foot and map rooms,
walls and shop outlines with level tags. The builder picks up the improvements on its next run. Tracing from SBB's
plans or apps is not allowed without their permission.

Worth asking, but unconfirmed: geOps, who build Trafimage, offer a Maps API with a free personal test key at
developer.geops.io. Whether it carries station-plan floors is not documented; ask support@geops.io.
