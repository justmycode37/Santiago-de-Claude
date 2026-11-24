# Station 3D: data for more correct interiors

Research notes, 24 November 2026. The question: can Google Maps, Street View or any other source make the inside of
the modelled stations look more correct (walls and ceilings below ground, shop outlines, signage, photos)? Background:
[station3d-research.md](station3d-research.md) (data.sbb.ch, ATLAS, swisstopo, OSM coverage),
[station3d-solid.md](station3d-solid.md), [sbb-journey-maps.md](sbb-journey-maps.md).

Every claim was checked on that day against the page or API named. **Unverified** marks what no reachable page settled.
sbb.ch and news.sbb.ch refuse automated fetches (HTTP 403) except for some PDFs and company.sbb.ch, so some SBB rules
could only be read from their PDFs.

## Bottom line

- **Google and Apple are dead ends for geometry.** No public API returns indoor geometry, and Google's terms forbid
  tracing, extracting or caching anything from Street View. They also forbid showing Street View **on the same screen
  as a non-Google map**, which rules out a panorama panel inside our 3D viewer. A plain link that opens Google Maps
  at a panorama needs no key and is the only Google route left.
- **SBB's indoor data (Journey Maps, HERE/NavVis scan of Zürich HB, Trafimage plans) is closed or copyright.** The
  plans may be linked and used privately, not traced into OSM or our models without written permission.
- **New and usable now: the cadastral survey (Amtliche Vermessung, AV), "Einzelobjekte".** It is open data with
  measured 2D outlines of **underground buildings, underpasses/tunnels, canopies ("Unterstand"), platforms, important
  stairs and pillars**, at Zürich, Bern, Basel and Genève. These are the real outer walls of the underground
  levels, the hall roofs and the columns: exactly what the first-person view is missing. Lausanne (VD) and Luzern (LU)
  returned nothing from the national service.
- **Photos:** Panoramax (CC BY-SA 4.0, no token) has street-level images round Zürich HB, Genève and Bern but no
  indoor sequence was found. Mapillary needs a token and its terms forbid use "in connection with real-time navigation
  or route guidance". The best photo route is **our own handheld capture**, published openly (Panoramax), which also
  feeds OSM mapping.

---

## 1. Google

### 1.1 Indoor maps (floor plans in Google Maps)

- Google Maps shows indoor maps "inside places like malls and airports", with a level picker
  (https://support.google.com/maps/answer/2803784). There is no coverage list.
- The partner page (https://www.google.com/maps/about/partners/indoormaps/) only addresses "Existing partners", with
  regional contacts (EMEA: indoorpartners-emea@google.com). No open upload route for new venues was found. It claims
  indoor maps are "available through the Google Maps APIs", but no developer page names a field, layer or endpoint.
- **Swiss stations:** none of Zürich HB, Bern, Basel SBB, Luzern, Genève or Lausanne could be confirmed as having a
  Google indoor floor plan. **Unverified**: this needs a look in the Google Maps app (zoom in, check for a level
  picker). The only documented Swiss station work is the 2016 SBB/Google **Street View** pilot at Zürich HB
  ("The individual floors and all retail facilities are identifiable and can be explored using Street View",
  Railway Gazette, 16 Sep 2016, https://www.railwaygazette.com/technology/explore-zurich-hb-with-google/43169.article;
  PCtipp 15 Sep 2016 mentions ShopVille and a level switch). It was to be extended to "weitere Bahnhöfe" if
  successful; whether it was, and whether the 2016 imagery is still live, is **unverified** (checking needs an API key).
- Zürich **Airport** (not the station) has Google Indoor Live View since 2021 (AR, built on indoor Street View).

### 1.2 Developer APIs

| API | Indoor geometry? | Notes |
| --- | --- | --- |
| Maps JavaScript API | No | No indoor/level layer in the docs (https://developers.google.com/maps/documentation/javascript/overview). |
| Places API (New) | No | Points, details, photos; no outlines or levels. Places content may not be shown on a non-Google map (ToS 3.2.3(e)(i)). |
| Map Tiles API: Photorealistic 3D Tiles | No | "a 3D mesh textured with high resolution imagery" from the air: no interiors. Policies forbid "Geodata extraction", "Offline uses", pre-fetching/caching beyond `max-age`; you may overlay your own 3D objects only if they are not "extracted, traced, or otherwise derived … from Photorealistic 3D Tiles" (https://developers.google.com/maps/documentation/tile/policies). |
| Street View (JS `StreetViewPanorama`, Static API, Street View tiles) | Imagery only | See 1.3. |

### 1.3 Street View: what the terms allow

Google Maps Platform Terms of Service (https://cloud.google.com/maps-platform/terms, version read 24 Nov 2026), §3.2.3
"Restrictions Against Misusing the Services":

- (a) **No Scraping**: "Customer will not export, extract, or otherwise scrape Google Maps Content for use outside the
  Services. For example, Customer will not: (i) pre-fetch, index, store, reshare, or rehost Google Maps Content outside
  the services; (ii) bulk download Google Maps tiles, Street View images, …"
- (b) **No Caching**: "except as expressly permitted under the Maps Service Specific Terms." The Service Specific Terms
  (https://cloud.google.com/maps-platform/terms/maps-service-terms) permit caching Google IDs only, e.g.
  "(b) pano_ID, from Street View Static API"; the Street View Static policies say "you can store panorama ID values
  indefinitely" (https://developers.google.com/maps/documentation/streetview/policies).
- (c) **No Creating Content From Google Maps Content**: "Customer will not create content based on Google Maps
  Content", with examples such as building 3D models from 45° imagery and "construct an index of tree locations within
  a city from Street View imagery". The Street View Static policies add: don't "build 3D or terrain models". Item (vii)
  also bars using the content to train or fine-tune ML models.
- (e) **No Use With Non-Google Maps**: "Customer will not use the Google Maps Core Services with or near a non-Google
  Map in a Customer Application. For example, Customer will not … (ii) display Street View imagery and non-Google Maps
  on the same screen".

So:

| Use | Allowed? |
| --- | --- |
| Street View images as textures, for photogrammetry, or to trace walls/shops into our model or OSM | **Forbidden** (a, b, c; OSM's own rules also say no: the OSM Legal FAQ lists "photographs such as Google Street View" as unusable, https://wiki.openstreetmap.org/wiki/Legal_FAQ) |
| An embedded panorama (JS `StreetViewPanorama`, Static image, Embed API) **inside or beside our 3D station view** | **Forbidden** by (e)(ii): the station view is a non-Google map on the same screen. The JS API itself supports a standalone panorama in a `div` ("You may use a standalone Street View object without a map", https://developers.google.com/maps/documentation/javascript/streetview), but only on a screen with no other map. |
| A standalone Street View screen with no map on it | Allowed in principle (API key, billing: `StreetViewPanorama` loads are billed; Google logo, `copyright` attribution and "Report a problem" link required). Of little use: it leaves the walk. |
| A **link** "Open in Google Street View" that opens Google Maps | Fine. Maps URLs need no key ("You don't need a Google API key to use Maps URLs") and only open Google Maps: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=LAT,LNG&heading=H&pitch=P&fov=F` (or `&pano=ID`) (https://developers.google.com/maps/documentation/urls/get-started). Our reading: this is a hyperlink to Google's product, not Google content shown in our app. Without a stored `pano` ID a `viewpoint` may land on an outdoor panorama; getting the ID needs the Street View metadata API (key), and the ID may be stored. |

## 2. Apple Maps / IMDF

- The Indoor Maps Program (https://register.apple.com/resources/indoor/program/indoor_maps) builds maps only from
  "data Apple receives directly from the account established by the organization that owns or operates the
  facility"; "the only property types being added to Apple Maps are airports" (plus "selected shopping centers"), and
  "the indoor maps displayed in Apple Maps are not made available to developers via MapKit or MapKit JS."
- Swiss stations: no indoor map. Six Colors (19 Sep 2024, https://sixcolors.com/?p=32484) found level switching only at
  Zürich Airport, "not the busy Zurich train station", and the same at Bern.
- **IMDF** (OGC Community Standard 20-094, https://docs.ogc.org/cs/20-094/index.html) is open, royalty-free GeoJSON
  with Venue, Level, Unit, Opening, Fixture, Amenity, Occupant … and Apple guidance for transit stations. Useful only
  as an **export format** of our own data (e.g. to hand SBB or a venue partner), not as a source.

**Verdict:** no Apple data for Swiss stations; none could be licensed by a third party anyway.

## 3. Commercial indoor-map vendors

| Vendor | Swiss station data | Terms for us |
| --- | --- | --- |
| **HERE Indoor Map** (with **NavVis**) | Yes: SBB was the first customer (2022); "The digital representation of Zurich central station was captured with a NavVis mobile mapping device" incl. "360 panoramic images" (https://www.navvis.com/blog/navvis-announces-partnership-with-here-technologies, 17 Feb 2022) | **Needs SBB's agreement.** HERE SDK: "Indoor Maps is only available with the Navigate license"; "the HERE SDK only supports private venues, therefore your venue data will only be shown in your app", each venue "tied to your HERE SDK credentials" (https://docs.here.com/here-sdk/docs/android-venues). The venue owner decides who gets the map. Contact venues.support@here.com. The HERE press release itself returned 403. |
| **infsoft** | Built SBB's "My Train Station" app (2015): ~175,000 m² of Zürich HB digitised, ~1,200 beacons (https://www.infsoft.com/press/indoor-navigation-zurich-main-station/) | SBB's data; not licensable by us. |
| MapsPeople (MapsIndoors), Pointr, Mappedin, Esri ArcGIS Indoors, Mapbox | No Swiss station deployment found in searches (**unverified**: no customer list fully checked) | These sell software to venue owners; they hold no station data of their own to license. |
| Matterport | No public Swiss station scans found | Capture terms put the burden on the customer to hold "all necessary permissions and consents" for the property (https://matterport.com/legal/capture-services-ondemand-product-customer-agreement): in a station that means SBB. |

## 4. SBB and the other operators

- **Station plans (Trafimage).** SBB publishes plans for "more than 60 stations" (interactive at plans.trafimage.ch
  and PDFs). Terms, from https://company.sbb.ch/en/offers/services/trafimage-maps-station-plans.html: "All documents
  are protected by copyright and cannot be modified or used for commercial purposes without authorisation. Private use
  of the products is permitted. … Please contact us in any event if you wish to use Trafimage products commercially."
  Contact: SBB AG Infrastructure, Technology Operation Center Trafimage, Poststrasse 6, 3072 Ostermundigen (e-mail
  on that page). **So: link them (we already do via `haltestelle-karte-trafimage`); do not trace them into OSM or our
  models without written permission.** OSM's rules agree: "Do not use data from copyrighted maps or any other
  proprietary data!" and "you should still seek approval in writing" (https://wiki.openstreetmap.org/wiki/Copyright).
- **Journey Maps / Journey Routes / Journey Places:** SBB-internal only (see [sbb-journey-maps.md](sbb-journey-maps.md)).
  SBB's app maps are this data; the HERE/NavVis Zürich HB scan and the infsoft beacon map are earlier SBB projects.
- **Ask SBB** for an open indoor layer or permission to derive from the plans: gis@sbb.ch, opendata@sbb.ch, and the
  Trafimage team. An IMDF or OSM-ready export, or an ODbL-compatible permission letter, would solve walls and shop
  outlines at the 60 big stations at once.
- **SBB ViaStaziun** (crowdsourced station photos with Mapillary as backend, per a Mapillary case study): whether the
  images are public on Mapillary, and their licence, is **unverified**.
- **BLS, RBS, ZVV station plans:** not checked (**unverified**). RBS's underground Bern station is inside the Bern AV
  outlines below.

## 5. Open and derivable routes

### 5.1 Cadastral survey (Amtliche Vermessung), Einzelobjekte: measured outlines below ground (recommended)

The national service `https://geodienste.ch/db/av_0/deu` (WFS 2.0, layer `ms:SOSF` = Einzelobjekt surfaces, LV95,
`OUTPUTFORMAT=geojson`) and Zürich's own `https://maps.zh.ch/wfs/OGDZHWFS` (layer
`ms:ogd-0402_arv_basis_avzh_einzelobjekte_f`) were queried round each station on 24 Nov 2026:

| Station (bbox ≈ 600–900 m) | Underground buildings | Tunnel/underpass/gallery | Canopy ("Unterstand") | Platforms | Important stairs | Pillars |
| --- | --- | --- | --- | --- | --- | --- |
| Zürich HB (OGDZHWFS, 831 objects) | 228 (largest 43,125 m² and 26,869 m²; edited up to Oct 2025) | 8 | 52 (one of 43,115 m²: the hall roof) | 7 | 171 | 42 |
| Bern (859) | 32 | 25 | 46 | 6 | 131 | **408** |
| Basel SBB (1,950; only the first 200 read) | 126 | 4 | 68 | 6 | 229 | 87 |
| Genève (854) | 44 | 5 | 72 | 1 | 117 | 14 |
| Lausanne, Luzern | 0: VD and LU are not served openly through geodienste.ch (**unverified** whether their cantonal portals publish it) | | | | | |

What it gives: 2D polygons (no heights, no levels, no interior walls) of the **outer extent of each underground
structure** (ShopVille, the Löwenstrasse/Museumstrasse stations, Bern's underpasses and RBS station), the **roofs and
canopies**, platform outlines, the main stairs, and **pillars** (columns: the strongest eye-level cue in Bern's halls).
Each feature has `Art`, validity, quality and, for buildings, the `GWR_EGID` (building register id).

Licence: the cantons' terms apply (geodienste.ch §1). On opendata.swiss Zürich's AV Einzelobjekte is `terms_open`,
Basel-Stadt's `terms_by`, Bern's simplified AV `terms_open`; Genève **unverified**. Credit the canton (as the builder
already does with "Geodaten Stadt Bern"). geodienste.ch fair use: WFS 10 requests/minute; for bulk (all stations) use
its STAC/AtomFeed download, 1 dataset per offer and day (https://geodienste.ch/terms-of-use). The Bern builder already
uses AV outlines for corrections at Bümpliz Nord (`tools/build_station3d.py:404`).

How it plugs in:
- **`tools/build_station3d.py`**: a layer `av_objects.geojson` per station in `tools/station3d_data/<key>/` (fetched
  once with the bbox, converted to the model's local metres like `shell.geojson`, credited per canton).
- **`tools/station3d_solid.py`**: an `edge` (kerb) of a below-ground floor that runs within ~1 m of the boundary of an
  `unterirdisches_Gebaeude` or `Tunnel_Unterfuehrung_Galerie` becomes `kind: 'wall'` with a `source: 'av'` flag:
  a measured outer wall, no longer schematic. The underground polygon also bounds the ceiling slab. `Pfeiler` become
  columns from floor to the slab above; `Unterstand` become canopies/hall roofs where swissBUILDINGS3D has none;
  `Bahnsteig` and `wichtige_Treppe` are a check on OSM platforms and stairs (a report, as at Bümpliz Nord).
- Inner walls (shop fronts, corridor walls inside ShopVille) are **not** in the AV: they still need OSM.

### 5.2 Other public geodata

- **Stadt Zürich 3D-Stadtmodell** (block and roof models, OGD/CC0 since 2018,
  https://www.stadt-zuerich.ch/de/planen-und-bauen/bauvorschriften-und-planerische-grundlagen/planbezug-datenbezug/3d-stadtmodell.html):
  above ground only; adds nothing to the interiors beyond swissBUILDINGS3D. No open underground-structure dataset was
  found for the city (a rail-infrastructure dataset notes it excludes underground elements).
- **Leitungskataster / underground structure registers:** not open; not checked further (**unverified**).
- **swisstopo**: nothing underground (see station3d-research.md §1.4).

### 5.3 OpenStreetMap indoor (SIT)

Simple Indoor Tagging (https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging): `indoor=room` ("Conventional room
with walls"), `indoor=area`, `indoor=corridor`, `level` mandatory, and "it is possible to map walls explicitly as
elements tagged indoor=wall + level=*"; doors as `indoor=door` nodes. Shop outlines fit as `indoor=room` + `shop=*`.
This remains the only open source for **inner** walls and shop outlines. Allowed sources: own survey, own photos,
Mapillary/Panoramax images (Mapillary terms §13 explicitly permit OSM contributions), and the AV outlines where the
canton's licence is ODbL-compatible (Zürich `terms_open` is; for `terms_by` cantons the OSM community has a Swiss
waiver process: **unverified** for AV Einzelobjekte). **Not** SBB plans, Google or Apple. A practical campaign: one
station at a time, start where the builder's report flags gaps, map rooms and walls from a walk with photos.

### 5.4 Street-level imagery for a "photo of this spot" panel

| Source | Measured coverage (24 Nov 2026) | Terms |
| --- | --- | --- |
| **Panoramax** (`https://api.panoramax.xyz/api/search?bbox=…`, no token) | Zürich HB 564 images in 10 sequences (2016–2026; 123 are 360°, from a cycle ride on 30 Aug 2026), Genève 61, Bern 15, Luzern 3, Basel and Lausanne 0. **No indoor sequence identified**: Panoramax has no level field and the images round HB are street-level. | Each item carries its licence: CC BY-SA 4.0. Showing an unmodified photo with attribution is fine; no navigation clause. |
| **Mapillary** | **Unverified**: every API call needs an access token (`graph.mapillary.com` answered "Invalid OAuth 2.0 Access Token"); a client token comes free with a developer account. | User content CC BY-SA; attribution with logo. **Terms §5: you will not "Use any Mapillary Services … in connection with real-time navigation or route guidance, such as to turn-by-turn route guidance that is synchronized to the position of a sensor-enabled device"** (https://www.mapillary.com/terms, effective 15 Feb 2024). Our walk-through follows the user's position: keep Mapillary out of it, or use it only in a planning view that is not synchronised to the device. |

### 5.5 Own capture: photos, 360°, photogrammetry, Gaussian splats, phone LiDAR

- **SBB Bahnhofordnung** (PDF, read 24 Nov 2026,
  https://www.sbb.ch/content/dam/internet/sbb/downloads/de/reiseinformationen/bahnhoefe/Bahnhofordnung.pdf.sbbdownload.pdf),
  Art. 9: not permitted without a permit: "… Foto- und Filmaufnahmen mit Installationen und übrige Tätigkeiten des
  gesteigerten Gemeingebrauchs ohne Bewilligung" (photo and film shoots *with installations*, and other heightened
  common use, need a permit). Handheld photos/video without tripods or rigs are not listed; drones need SBB approval
  (company.sbb.ch drone page refused the fetch: **unverified** details). The separate rule "Regelung 70002" now 404s
  and news.sbb.ch's media permit page returns 403: the **commercial-use** threshold, process and fees are
  **unverified**. Ask SBB media relations in writing before publishing a capture made for the app.
- **Privacy:** passers-by in images are personal data (Swiss FADP, personality rights). Blur faces and plates before
  publishing; Gaussian splats and photogrammetry mostly erase moving people, but source frames still need care.
  Swiss-specific guidance (EDÖB) was not found: **unverified**.
- **What it gives:** textures and true geometry of corridors, ceilings, shop fronts, signage. Splat/NeRF scenes are
  heavy (tens to hundreds of MB per hall) and need levelling into the model's frame (control points from the AV
  outlines and OSM). **Third-party content in the scan** (shop branding, SBB signage, advertising) is copyright or
  trademark: fine for orientation, but do not redistribute as a product asset without checking.
- **Phone LiDAR** (iPhone Pro/RoomPlan-style scans): metre-accurate room shells to ~5 m range; useful to measure
  ceiling heights and corridor widths for OSM `height=`/`min_height=` and our `heights.json`, not as visible geometry.
- Plug-in: as photos, a per-step "photo here" panel reading our own Panoramax uploads by bbox; as measurements, values
  in `tools/station3d_data/<key>/heights.json`; as a mesh, an optional `interior_mesh` layer next to `shell_mesh.json`,
  shown in first person only, credited and marked as captured.

---

## 6. Summary

| Source | Walls/ceilings | Shop outlines | Signage | Photos/textures | Coverage | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Google indoor maps / APIs | — | — | — | — | not confirmed at any station | **Not usable** (no API, no extraction) |
| Google Street View | — | — | (visible only) | panoramas, Zürich HB 2016 | Zürich HB; others unverified | **Not usable** in or beside the viewer; **link out only** |
| Google Photorealistic 3D Tiles | outside only | — | — | aerial mesh | CH | Not useful for interiors |
| Apple Maps / IMDF | — | — | — | — | no Swiss stations | **Not usable**; IMDF as export format |
| HERE / NavVis (SBB) | yes (scan) | yes | yes (360°) | yes | Zürich HB | **Needs SBB agreement** |
| SBB Journey Maps | yes | yes | — | — | all SBB | **Needs agreement** (refused for non-SBB) |
| SBB/Trafimage plans | traceable | yes | — | — | 60+ stations | **Needs agreement** to derive; link only |
| **AV Einzelobjekte** | **outer walls below ground, canopies, pillars** | — | — | — | ZH, BE, BS, GE (not VD, LU) | **Usable** (cantonal OGD, credit) |
| OSM SIT | inner walls where mapped | where mapped | — | — | 42 stations well mapped | **Usable** (ODbL); improve it |
| Panoramax | — | — | (visible) | street-level, no indoor found | sparse | **Usable** (CC BY-SA 4.0) |
| Mapillary | — | — | (visible) | unknown indoors | unverified | **Usable with care**: not in the position-synchronised walk |
| Own capture (photos, splats, LiDAR) | yes | yes | yes | yes | where we go | **Usable** handheld; permit for rigs/commercial; blur people |

## 7. Recommendations, in order

1. **Pull the AV Einzelobjekte for Zürich, Bern, Basel and Genève** into `tools/station3d_data/<key>/av_objects.geojson`
   and, in `station3d_solid.py`, promote below-ground `edge` kerbs that follow an `unterirdisches_Gebaeude` /
   `Tunnel_Unterfuehrung_Galerie` boundary to measured walls; add `Pfeiler` as columns and `Unterstand` as canopies.
   Cheapest real gain in first person; no permission needed. Check Genève's licence and look for VD/LU cantonal
   downloads for Lausanne and Luzern.
2. **Write to SBB** (gis@sbb.ch, opendata@sbb.ch, the Trafimage team) asking for either an open indoor layer (IMDF/OSM
   export) or written, ODbL-compatible permission to trace inner walls and shop outlines from the station plans into
   OSM. Ask media relations at the same time whether handheld 360° capture for an independent app needs a permit.
3. **Improve OSM** (SIT `indoor=room`/`indoor=wall` with `shop=*`) at the five big stations from our own surveys and
   photos, using the builder's gap report; the builder picks it up with no code change.
4. **"Photo of this spot"**: own handheld 360° captures (blurred) uploaded to Panoramax under CC BY-SA 4.0, shown at
   steps by bbox query with attribution. Panoramax as-is has no indoor images to show yet.
5. **Google:** at most an "Open in Google Street View" link (Maps URLs, `map_action=pano`) on the station page, never
   in or next to the 3D view, and nothing derived from it.
6. **Later, optional:** photogrammetry/splat capture of one hall (Bern or Zürich) as a first-person-only layer, once
   SBB has confirmed in writing that it may be published.

## 8. Not verified

- Whether Google Maps shows indoor floor plans at any of the six stations, and whether the 2016 Zürich HB indoor Street
  View is still live or was extended to other stations (needs the app or an API key).
- Mapillary indoor coverage at Swiss stations (needs a token); ViaStaziun image licence.
- SBB's commercial filming rules, fees and drone rules (pages refused automated fetches; Regelung 70002 now 404).
- AV licence for Genève; AV availability for Vaud and Luzern outside geodienste.ch; OSM waiver status for `terms_by` AV.
- BLS/RBS/ZVV station plan terms; customer lists of MapsPeople, Pointr, Mappedin, Esri.
- Swiss data-protection guidance (EDÖB) specific to capturing people in stations.
