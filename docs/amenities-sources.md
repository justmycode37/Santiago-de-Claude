# Free / public everyday amenities in Bern: datasets and OSM counts

Researched 21 Nov 2026. VERIFIED = I called the URL or ran the query myself in this session and saw the result. UNVERIFIED = from search snippets/memory only.

## Key findings

- The Stadt Bern open data (opendata.swiss org `geoinformation-der-stadt-bern`, ~190 datasets, all served from the ArcGIS geoportal `map.bern.ch`) has NO dataset for public toilets, drinking fountains (Brunnen), WiFi, pharmacies, doctors, libraries, ATMs or supermarkets. VERIFIED by listing the org's full dataset list and the `map.bern.ch/arcgis/rest/services/Geoportal` service list. Searches on opendata.swiss for Brunnen/WC/Apotheke/WLAN in Bern also found nothing. For these, OSM is the only machine-readable source.
- The city does have official layers for: sports facilities, playgrounds, swimming pools, ice rinks, tourist info, kids/youth/neighbourhood services (Quartierangebote), markets, bike pumps, parks, Kitas, schools, parking, tourist sights, Velomiete.
- SBB data on `data.sbb.ch` (Opendatasoft API, no key) gives station WiFi, ticket machines and Libero zones.
- Bike share in Bern is now **Velospot** (ex-PubliBike), GBFS v3 feed works. The old PubliBike GBFS v2 feed returns 0 stations.

## Table

| Amenity | Best source | URL | Format | Licence | Bern coverage / count | Verified |
|---|---|---|---|---|---|---|
| Public toilets | OSM (`amenity=toilets`). City publishes only a PDF concept + news; Gemeinderat answer Dec 2025 says 42 WC + 8 Pissoirs (city-run). ATLAS station toilets (team already has) | Overpass, see below. PDF: https://www.bern.ch/politik-und-verwaltung/stadtverwaltung/prd/hochbau-stadt-bern/publikationen/aeltere-publikationen-1/copy3_of_downloads/offentliche-toilettenanlagen-in-der-stadt-bern.pdf (2010, old) | JSON/GeoJSON | ODbL | 165 OSM elements (151 nodes, 14 ways). Of these: 101 have `fee` tag (94 = `fee=no`), 86 `wheelchair`, 35 `opening_hours`, 17 `access=customers`, 3 private. Filter on `access` and `fee` | OSM count VERIFIED. City official count UNVERIFIED (search snippet) |
| Drinking water / Brunnen | OSM: `amenity=drinking_water` + `amenity=fountain` with `drinking_water=yes`. No city dataset found | Overpass | JSON/GeoJSON | ODbL | `amenity=drinking_water`: 33. `amenity=fountain`: 443 elements (157 nodes, 53 ways, 233 relations); 248 tagged `drinking_water=yes`, 101 `=no`. Union (drinking_water OR fountain+drinking=yes OR water_tap) = 294 | OSM VERIFIED. City dataset: none exists on opendata.swiss (VERIFIED absence); a city "Brunnenkataster" outside opendata.swiss UNVERIFIED |
| Free public WiFi | (a) OSM `internet_access=wlan` (b) SBB station WiFi list | (b) https://data.sbb.ch/api/explore/v2.1/catalog/datasets/wifistation/records?where=standort%20like%20%22Bern%25%22 | JSON / GeoJSON export | SBB: https://data.sbb.ch/page/licence | OSM: 147 `wlan` (78 with `internet_access:fee=no`). SBB: 79 stations CH-wide, 2 in Bern (Bern 8507000, Bern Wankdorf 8516161). No Stadt Bern hotspot dataset found | OSM VERIFIED, SBB VERIFIED. Library/city hotspots UNVERIFIED |
| Phone charging | OSM has nothing useful | n/a | | | `amenity=device_charging_station`: 1; `socket_charging=yes`: 0. `amenity=charging_station` = cars (72 elements), NOT phones. Practical answer: libraries, station, cafes; hand-curate a few | VERIFIED (counts) |
| Libraries (Kornhausbibliothek, Stadtbibliothek etc.) | OSM `amenity=library` | Overpass | JSON | ODbL | 55 elements (includes uni/school/Quartier libraries) | OSM VERIFIED. No city dataset found |
| Warm/indoor public spaces | OSM `amenity=community_centre` (34), `social_facility` (70), libraries (55), `townhall` (9), post_office (23). Plus city "Quartierangebote" | https://map.bern.ch/arcgis/services/Geoportal/Quartierangebote/MapServer/WFSServer | WFS (GeoJSON via ArcGIS), OSM | Opendata.swiss "terms_open" (https://opendata.swiss/terms-of-use#terms_open), ODbL | See counts | OSM counts VERIFIED; WFS endpoint exists (Sportanlagen tested, Quartierangebote not queried) |
| Benches / rest | OSM `amenity=bench` | Overpass | | ODbL | 2792 (2717 nodes, 75 ways). Too many; only render at high zoom | VERIFIED |
| Playgrounds | City WFS (preferred) or OSM `leisure=playground` | https://map.bern.ch/arcgis/services/Geoportal/Spielplaetze/MapServer/WFSServer | WFS | terms_open | OSM: 388 elements (122 nodes, 261 ways, 5 rel). City WFS count not queried | OSM VERIFIED. City WFS capabilities from opendata.swiss metadata only (UNVERIFIED live) |
| Pharmacies | OSM `amenity=pharmacy` | Overpass | | ODbL | 55 (53 nodes + 2 ways); 51 have `opening_hours`, 30 `dispensing`; 0 have an `emergency` tag. No on-duty data in OSM | OSM VERIFIED |
| Notfallapotheke (on duty) | No open dataset found. Use pharmalog / Apothekerverband lookup or link out; 144 for emergencies | not found | | | Search surfaced Bahnhof Apotheke (reported 8-21h, 2023) only | UNVERIFIED (link-out only; do not invent a feed) |
| Hospitals / ER | (a) OSM `amenity=hospital` (b) Kanton Bern "Spitäler und Kliniken" | (b) https://geofiles.be.ch/geoportal/pub/download/SPITAL/spital.zip (also `spital.gpkg.zip`, `spital_spitklin.parquet`) | Shapefile zip / GPKG / Parquet | terms_open | OSM: 10 hospitals, 21 clinics. Names found: Inselspital, Kinderkliniken Inselspital, Lindenhofspital, Sonnenhofspital, Salem-Spital, Engeriedspital, Hirslanden Klinik Permanence, Klinik Beau-Site, UPD, Notfallzentrum Kinder-/Jugendpsychiatrie (24/7). `emergency=yes` on Inselspital, Lindenhof, Sonnenhof, Permanence | OSM VERIFIED. Kanton file HTTP 200 (544 KB) VERIFIED; contents/fields not inspected |
| Walk-in doctors | OSM: `amenity=clinic` + `emergency=yes`; `amenity=doctors` | Overpass | | ODbL | doctors 66, clinic 21. OSM has City Notfall (`emergency=yes`, Mo-Su 07:00-22:00) and Medbase (Mo-Fr 08-17, Sa 09-17) | OSM VERIFIED. Hours not verified vs. operators |
| AED (defibrillators) | Kanton Bern "AED-Standorte" | https://geofiles.be.ch/geoportal/pub/download/AEDSTO/aedsto.zip (+ `aedsto.gpkg.zip`, parquet) | SHP / GPKG / Parquet | terms_open | Canton-wide, modified 2026-04-21. Bern count not extracted. Extra, not requested | File HTTP 200 (8.9 MB) VERIFIED; fields UNVERIFIED |
| ATMs | OSM `amenity=atm` (+ `amenity=bank` 44) | Overpass | | ODbL | 96 ATMs, 44 banks | VERIFIED |
| Money exchange / remittance | OSM `amenity=money_transfer` / `bureau_de_change` | Overpass | | ODbL | money_transfer 3, bureau_de_change 1. Post offices (23) also do Western Union style services but verify per branch. Realistically hand-curate (Western Union/MoneyGram agents, PostFinance, SBB exchange counter at station) | OSM counts VERIFIED. Service list UNVERIFIED |
| Supermarkets | OSM `shop=supermarket` | Overpass | | ODbL | 119 total. Name match Aldi/Lidl/Denner: 31. Name match Aldi/Lidl/Denner/Migros/Coop: 88 (case-insens. name regex, may include some `Coop Pronto`-style items) | VERIFIED |
| Free events | No open dataset found in this pass | | | | Not checked beyond city "Märkte" layer (https://map.bern.ch/arcgis/services/Geoportal/Maerkte/MapServer/WFSServer, from the service list, not queried) | UNVERIFIED |
| Sports facilities | Stadt Bern WFS "Sportanlagen" (verified) | https://map.bern.ch/arcgis/services/Geoportal/Sportanlagen/MapServer/WFSServer | WFS 2.0.0, output GEOJSON | terms_open | 92 features (typeName `Geoportal_Sportanlagen_1:Sportanlage`). Fields: PUNKTNAME, BESCHRIEB, URL, EMAIL, TELEFON, STRASSE, HAUSNUMMER, PLZ, ORT, rubrik_desc, zugang_hindernisfrei_desc, DIVATTR1.., Letzte_Aenderung. OSM: 82 sports_centre, 524 swimming_pool (mostly private pools, ignore) | WFS VERIFIED. **Needs a browser User-Agent, plain curl gets "Access Denied" page** |
| Swimming / ice rinks | City WFS `Schwimmbaeder`, `Kunsteisbahnen` | https://map.bern.ch/arcgis/services/Geoportal/Schwimmbaeder/MapServer/WFSServer | WFS | terms_open | not queried | URLs from service list / opendata.swiss; UNVERIFIED live |
| SBB ticket machines | SBB `billetautomat` | https://data.sbb.ch/api/explore/v2.1/catalog/datasets/billetautomat/records?where=bps_name%3D%22Bern%22 | JSON/GeoJSON/CSV export | https://data.sbb.ch/page/licence | 1347 CH-wide. `bps_name="Bern"`: 15, all typ_text ePOS in first 3 rows; 30 for `bps_name like "Bern%"`. Fields: bps_name, typ_text, id_automat, eigentumer, sprache, geopos. OSM `vending=public_transport_tickets`: 211 (includes bus stop machines) | VERIFIED |
| Travel centres / lost & found | No open dataset found. OSM `shop=ticket`/`office=` not queried. Link out to sbb.ch (Fundbüro) | https://www.sbb.ch | | | n/a | UNVERIFIED |
| Libero tariff zones | SBB `tarifverbundkarte` (polygons) | https://data.sbb.ch/api/explore/v2.1/catalog/datasets/tarifverbundkarte/exports/geojson?where=partners%20like%20%22Libero%22 | GeoJSON (polygons + `name`, `partners`, `partnercodes`, `tarifverbund_urls`, `level`, `source`) | https://data.sbb.ch/page/licence | 398 Libero polygons, municipality-level (e.g. id 2381 "Bern", also Bremgarten b. Bern, Muri b. Bern, Wohlen b. Bern). These are municipality polygons, not the numbered zone numbers like "100"; you must map to Libero zone numbers yourself | VERIFIED (export returns GeoJSON). Zone-number mapping UNVERIFIED |
| Bike sharing | Velospot GBFS v3 (via MobiData BW) | https://api.mobidata-bw.de/sharing/gbfs/v3/velospot_ch/gbfs (station_information, station_status, vehicle_status) | GBFS 3.0 JSON | Not stated in feed; Mobility Database lists it. Check before shipping | 1684 stations CH-wide, **295 inside the Bern bbox** (includes Köniz etc.). OSM bicycle_rental: 249 (229 PubliBike/Velo network) | VERIFIED |
| Bike share (old PubliBike) | https://api.publibike.ch/v1/gbfs/v2/gbfs.json | | GBFS 2.3 | CC-BY-4.0 per search result (UNVERIFIED) | `station_information` returns an **empty list**. Do not use | VERIFIED (empty) |
| sharedmobility.ch API | https://api.sharedmobility.ch/v1/sharedmobility/identify?Geometry=7.4391,46.9489&Tolerance=500&geometryFormat=geojson&sr=4326 | | JSON/GeoJSON | not checked | Works, returns Velospot items in Bern. `https://sharedmobility.ch/gbfs.json` and `/v1/gbfs/...` paths did not respond | identify VERIFIED. Aggregated GBFS UNVERIFIED |
| Elevators at stations | Team already has ATLAS PRM. `data.sbb.ch` dataset `elevator-condition` does NOT exist (404) | | | | n/a | VERIFIED absent |
| Station shops/services at Bern station | sbb.ch page lists Amavita Apotheke, Medbase, Coop in Bahnhof Bern | https://www.sbb.ch/de/reiseinformationen/bahnhoefe/bahnhof-finden/bahnhof-bern/geschaefte/shop-detail.html/geo-medbase-bern-bahnhof-1f50 | HTML | | Static; hand-curate | UNVERIFIED (search snippet) |

Also seen on the city list (not queried): Kindertagesstaetten, Velopumpenstandorte, Velomiete, Schlauchautomate, Parkanlagen, Touristeninformation, Infostaende und Kastanienkioske, Abfallsammelstellen, Akustische Uebergangssignale. Pattern for every one: `https://map.bern.ch/arcgis/services/Geoportal/<Name>/MapServer/WFSServer`.

## OSM counts

Bbox (S,W,N,E) = 46.9, 7.34, 46.99, 7.5. Counts include nodes + ways + relations (`nwr`).
Query form (swap the filter), run against https://overpass.osm.ch/api/interpreter:

```
[out:json][timeout:60];
nwr[amenity=toilets](46.9,7.34,46.99,7.5);
out count;
```

**Important:** `overpass-api.de` and `lz4.overpass-api.de` timed out from this machine (connection timeout). `overpass.private.coffee` connected but returned nothing. `https://overpass.osm.ch/api/interpreter` (Swiss instance) worked. Use that one. Identical consecutive queries fail with `duplicate_query` error; space them out.

| Filter | Total | nodes / ways / relations |
|---|---|---|
| amenity=toilets | 165 | 151 / 14 / 0 |
| amenity=drinking_water | 33 | 33 / 0 / 0 |
| amenity=fountain | 443 | 157 / 53 / 233 (248 with drinking_water=yes) |
| drinking_water union (see above) | 294 | 129 / 19 / 146 |
| amenity=pharmacy | 55 | 53 / 2 / 0 |
| amenity=hospital | 10 | 2 / 8 / 0 |
| amenity=clinic | 21 | 17 / 4 / 0 |
| amenity=doctors | 66 | 66 / 0 / 0 |
| amenity=library | 55 | 52 / 3 / 0 |
| internet_access=wlan | 147 | 136 / 10 / 1 |
| internet_access:fee=no | 78 | 67 / 10 / 1 |
| amenity=atm | 96 | 96 / 0 / 0 |
| amenity=bank | 44 | 44 / 0 / 0 |
| shop=supermarket | 119 | 115 / 4 / 0 |
| shop=supermarket, name ~ Aldi/Lidl/Denner (i) | 31 | 29 / 2 / 0 |
| shop=supermarket, name ~ Aldi/Lidl/Denner/Migros/Coop (i) | 88 | 84 / 4 / 0 |
| amenity=charging_station (CARS, not phones) | 72 | 67 / 5 / 0 |
| amenity=device_charging_station (phones) | 1 | 1 / 0 / 0 |
| socket_charging=yes | 0 | 0 |
| amenity=bicycle_rental | 249 | 238 / 11 / 0 |
| bicycle_rental network ~ PubliBike/Velo | 229 | 218 / 11 / 0 |
| amenity=bench | 2792 | 2717 / 75 / 0 |
| leisure=playground | 388 | 122 / 261 / 5 |
| leisure=sports_centre | 82 | 28 / 50 / 4 |
| leisure=swimming_pool | 524 | 1 / 521 / 2 (mostly private) |
| amenity=post_office | 23 | 23 / 0 / 0 |
| amenity=money_transfer | 3 | 3 / 0 / 0 |
| amenity=bureau_de_change | 1 | 1 / 0 / 0 |
| amenity=vending_machine + vending=public_transport_tickets | 211 | 211 / 0 / 0 |
| amenity=community_centre | 34 | 23 / 10 / 1 |
| amenity=social_facility | 70 | 40 / 27 / 3 |
| amenity=shelter | 266 | 4 / 262 / 0 (mostly bus stop shelters / sheds) |
| amenity=townhall | 9 | 5 / 3 / 1 |
| amenity=language_school | 2 | 2 / 0 / 0 |

Caveat: the 233 relations under `amenity=fountain` looked high; I did not inspect them individually. Dedupe fountains on centre point before display.

## Recommendation: fastest path for a 1-day hackathon

1. **One Overpass call, one GeoJSON-ish file, committed to the repo** (do not hit Overpass from the PWA at runtime). Use `out center tags;` so ways/relations get a point. Union query, bbox 46.9,7.34,46.99,7.5, against `https://overpass.osm.ch/api/interpreter`:

```
[out:json][timeout:90];
(
  nwr[amenity=toilets];
  nwr[amenity=drinking_water];
  nwr[amenity=fountain][drinking_water=yes];
  nwr[amenity=pharmacy];
  nwr[amenity~"^(hospital|clinic|doctors|library|atm|community_centre|money_transfer|bureau_de_change)$"];
  nwr[internet_access=wlan]["internet_access:fee"=no];
  nwr[shop=supermarket][name~"Aldi|Lidl|Denner|Migros|Coop",i];
  nwr[leisure=playground];
)(46.9,7.34,46.99,7.5);
out center tags;
```

   Save as `data/amenities.json`, then in a script map `amenity`/`shop`/`leisure` to a `category` field and drop to `{lat,lon,category,name,opening_hours,fee,wheelchair}`. Expect roughly 1,000-1,200 points. Skip benches (2792) unless on a toggle at high zoom.
2. **Official datasets to add (2):**
   - Stadt Bern Sportanlagen WFS as GeoJSON: `https://map.bern.ch/arcgis/services/Geoportal/Sportanlagen/MapServer/WFSServer?service=WFS&version=2.0.0&request=GetFeature&typeNames=Geoportal_Sportanlagen_1:Sportanlage&outputFormat=GEOJSON` (92 features, WGS84, has accessibility field). Download with a browser User-Agent and commit the file; do not call it from the client.
   - SBB: `billetautomat` (bps_name = Bern, 15 rows) and `wifistation` (2 Bern stations), plus `tarifverbundkarte` Libero polygons for "which zone am I in".
3. **Live data in the client:** only Velospot GBFS (`station_information` + `station_status`) if there is time. Static filter to the Bern bbox.
4. **Hand-curate (an hour, ~15 rows):** Notfallapotheke link-out (pharmalog / 144), Inselspital + City Notfall + Permanence ER card, SBB Fundbüro / Reisezentrum Bern, remittance agents, free-WiFi libraries, Kornhausbibliothek. Do not promise on-duty pharmacy data; no open feed was found.
5. Credit "© OpenStreetMap contributors (ODbL)" in the app footer. Official city/canton data is under opendata.swiss "terms_open" (attribution may be required; check the exact terms page). SBB data licence: https://data.sbb.ch/page/licence (not read in full).

## Not done / risks

- City WFS layers other than Sportanlagen were not queried live (capabilities only for Sportanlagen). Field names differ per layer.
- Kanton Bern SPITAL/AEDSTO files were confirmed to exist (HTTP 200) but not unzipped.
- OSM counts are raw (no dedup, includes private/customer-only items). Free events, travel-centre and lost-and-found data: no source found.
- Licence of the Velospot feed and of the sharedmobility.ch API was not confirmed.

## Official sources pulled (Nov 2026)

`tools/build-official-places.mjs` → `data/official-places.json` (5418 items, 57/57 sources OK, 5.2 MB, ~40 s). All VERIFIED by running it on 21 Nov 2026. Bbox 46.9,7.34,46.99,7.5.

- **Stadt Bern geoportal, 44 layers, 4464 items.** I used the ArcGIS REST query (`.../Geoportal/<Svc>/MapServer/<layer>/query?outSR=4326&f=geojson`) instead of WFS: the WFS is LV95-only by default, and **Velopumpenstandorte, Velomiete, Berufsschulen, Kunst_im_oeffentlichen_Raum and Parkhaeuser have no WFS at all** (GetCapabilities returns an ArcGIS error page), while REST works for every layer. Max 1000 records per page (use resultOffset). It still needs a browser User-Agent. Counts: TVM_Feld tactile fields 1138, Haltestellen 713, Veloabstellplatz 550, Kunst im öffentlichen Raum 447, akustische Übergangssignale 145, Kindergärten 130, Spielplätze 128, Behindertenparkplätze 120, Parkanlagen 117, Sportanlagen 92, Bundesverwaltungen 86, Kitas 84, Stadtverwaltungen 79, OekoInfoMobil 74, Kantonsverwaltungen 70, Volksschulen 58, Quartierangebote 46, Abfallsammelstellen 43, Infostände/Kastanienkioske 28 (polygons), Familiengärten 27, Hochschulen 27, Bahnhöfe 25, Märkte 23 (polygons), Taxi 23, Jugendangebote 23, Carsharing 21, Sehenswürdigkeiten 20, Kinderangebote 19, Velopumpen 18, Berufsschulen 18, Schwimmbäder 15, Mittelschulen 10, Parkhäuser 9 (with live free-space text), Stimmlokale 7, E-Mobil 7, Kunsteisbahnen 5, Velostationen 5, Schlauchautomaten 4, Friedhöfe 3, Velomiete 2, Krematorium 2, Touristeninfo 1, Messe 1, Kindesschutz 1. Quirks: field-name case differs per layer (`Rubrik_Desc` vs `Rubrik_desc`, `PLZ` vs `Plz`). `Divattr1..4` have no aliases and mean different things per layer (hours, capacity, ...). The accessibility field is `Zugang_hindernisfrei_Desc` ("ja"/"nein"/"unbekannt") plus `Zugang_Bemerkung`. Most layers ship LV95 `H_coord/V_coord` too. The swisstopo approximate formula matches the server's own reprojection to within **0.5 m** over 2719 points. Bern Bahnhof (Bahnhoefe layer) = 46.94890, 7.43992. Still no toilets, fountains or libraries layer.
- **Kanton Bern (geofiles.be.ch GPKG zips), 383 items:** AED 283 (`AEDSTO.gpkg`, table `aedsto_aedsto_vw`. It has `lat_deg/long_deg` as well as LV95 geometry. `zugzeit` = "24h" / "Zeitweise öffentlich", `zugang` = free-text hours. The other two tables are coverage polygons, skipped). Hospitals/clinics 26 (`spital_spitklin_vw`: Inselspital, Lindenhof, Sonnenhof, Salem, Permanence, Beau-Site, psychiatric clinics...; flags akut/geburt/psychklin/rehaklin; only integer LV95 `e_koord/n_koord`). Found on opendata.swiss: **"Standorte der Leistungserbringung in den Bereichen Alter und Behinderung"** (`ILV/ilv.gpkg.zip`), with elderly care 52 and disability services (Wohnheim/Werkstätte/Tagesstätte) 22, plus phone, email and website. I read it with Node's built-in `node:sqlite` and a 20-line zip reader, so no GDAL is needed. GPKG geometry = 'GP' header + WKB, LV95 (EPSG:2056). Licence terms_open (opendata.swiss package metadata). `terms_of_use_de.pdf` is in each zip.
- **SBB data.sbb.ch, 276 items:** the catalog has only 61 datasets. It has **no shops, toilets, lockers (as points), P+R, Velostation or travel-centre dataset.** Pulled: wifistation 2, billetautomat 40, billetentwerter 66, haltestelle-wartehallen 9, **sektortafel 143** (platform sector signs with Gleis + sector letters, useful for "find your pole"), 12093_lautsprecher-akkustikbox 1, haltestelle-visuell-taktile-sicherheitslinie 7, mobiliar-im-bahnhof 8 (one point per station, aggregated inventory. Bern has "Schliessfächer NSFA: 308", benches, lifts...). Quirks: **`mobiliar-im-bahnhof` geopos has lat/lon swapped.** `billetautomat.id_automat` and `wartehallen.sloid` are not unique (the script suffixes `#n`). `wartehallen` licence = opentransportdata.swiss terms. `mobiliar` and `akkustikbox` state no licence. Not pulled: `21196_behig-haltekantepunkt` (496k rows) and `haltestelle-haltekante` (platform edges), both too big and not places. `haltestelle-uhr` and `abfahrtsplakate0` are not useful.
- **Velospot GBFS v3: 295 stations** in the bbox, merged with a station_status snapshot. 3 station names embed hours ("Open from 05:00 to 21:15 - Velostation ..."), so the script moves them to `opening_hours`. The feed still states no licence.
- **Swiss Post: skipped.** There is no open dataset on opendata.swiss (only a historic "Poststellenchroniken" set). `swisspost.opendatasoft.com` no longer exists ("domain could not be found"). The developer.apis.post.ch location API needs a key. OSM `amenity=post_office` (23) remains the source.
