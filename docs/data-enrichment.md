# Data enrichment: official addresses and merged toilets

Two post-processing steps on top of the OSM builds in [places-data.md](places-data.md). Bbox for everything: S,W,N,E = 46.9, 7.34, 46.99, 7.5.

## Rebuild order (Node 24, no npm deps, `unzip` on PATH)

```sh
node tools/build-places.mjs            # data/places.json     (OSM)
node tools/build-amenities.mjs         # data/amenities.json  (OSM)
bash tools/fetch-raw.sh                # data/raw/: ATLAS toilet + service-point CSVs (and transit files)
node tools/enrich-addresses.mjs        # fills addresses in both files in place, writes *.min.json
node tools/build-toilets.mjs           # data/toilets.json (needs the outputs of the three steps above)
```

`enrich-addresses.mjs` downloads the swisstopo register once (~143 MB zip) into `data/raw/` and keeps a bbox extract (`data/raw/gebaeudeadressen-bern.csv`, ~7 MB, ~50,700 addresses). Delete the extract to force a re-read of the zip, and the zip to force a re-download. It is idempotent: values it derived on an earlier run are reset first.

## 1. Address enrichment (`tools/enrich-addresses.mjs`)

Source: swisstopo, *Amtliches Gebäudeadressverzeichnis*, national CSV in LV95 (`ch.swisstopo.amtliches-gebaeudeadressverzeichnis`, found via the STAC API at data.geo.admin.ch). Licence: open government data, free use with attribution ("Source: swisstopo / Amtliches Gebäudeadressverzeichnis"). Only addresses with `ADR_STATUS = real` are used.

Method: item coordinates are converted to LV95 with swisstopo's approximate formulas (about 1 m), so distances are plain metres. A 50 m grid index finds nearby register addresses.

- Item without an address: it takes the nearest register address within 25 m, written as `address = "Street Nr, PLZ City"`, `address_source = "derived:gwr"`, `address_distance_m`. In `places.json`, `street/housenumber/postcode/city` are filled too. Way/area items (parks, large buildings) use their centre point and get no special treatment, so a large area often gets no address.
- Item with an OSM address: the address is kept. If the OSM street (`addr:street`, else `addr:place`) does not appear among the register addresses within 50 m, the item gets `address_check = "street_mismatch"` and `address_official` = the nearest register address. The comparison ignores case, accents (`ß`=`ss`), punctuation, `str.`=`strasse` and a house number typed into the street name. Items with no register address within 50 m are not checked.
- Slim browser copies `data/places.min.json` and `data/amenities.min.json` have the same structure without `tags`, with coordinates rounded to 6 decimals.

Results (run of 2026-11-21):

| File | Items | Address before (OSM) | After | Derived | OSM addresses checked | street_mismatch | Size full / min |
|---|---|---|---|---|---|---|---|
| places.json | 6,685 | 1,952 (29.2%) | 5,929 (88.7%) | 3,977 | 1,831 | 31 | 6.79 / 4.61 MB |
| amenities.json | 7,916 | 876 (11.1%) | 5,528 (69.8%) | 4,652 | 839 | 9 | 5.66 / 4.21 MB |

Median distance to the derived address: 8.3 m for places, 12.5 m for amenities. Treat a mismatch as "check this", not as "OSM is wrong". There are real errors (Amante: Flughafenstrasse 57 should be Flugplatzstrasse 57; Hühnerbühlstrasse should be Hühnerhubelstrasse; Ostermundigen station WC: `addr:place=Bahnhoraeral`). But many flags are businesses with a correct address in large buildings whose register entrance is on another street (Bahnhofplatz vs Bubenbergplatz, Schanzenstrasse vs Laupenstrasse).

## 2. Toilets (`tools/build-toilets.mjs` → `data/toilets.json`)

`{ generated, bbox, sources: [{key,name,url,licence,count}], items: Toilet[] }`, where `Toilet = { id, lat, lon, name, address, sources[], wheelchair, toilets_wheelchair, eurokey, changing_table, fee, opening_hours, unisex, operator, level, check_date, notes }`. Every field except `id/lat/lon/sources` may be null. Values are OSM-style strings (`yes|no|limited|...`).

- `toilets_wheelchair`: a wheelchair-accessible toilet exists. For an OSM `amenity=toilets`, this is OSM `toilets:wheelchair`, else its `wheelchair`. For ATLAS, `wheelchairToilet` YES/NO/PARTIALLY becomes yes/no/limited. For Nette Toilette, it comes from the restaurant's OSM `toilets:wheelchair`.
- `wheelchair`: step-free access to the venue or building (raw OSM).
- `eurokey`: `yes` when OSM `centralkey=eurokey`, otherwise null (null means unknown, not "no").
- `sources`: `osm:<osm id>`, `atlas:<sloid> (d m)`, `nette:<n> (d m)`, `osm-place:<places.json id>` (the restaurant record used for a Nette Toilette).

Sources:

| Key | What | Licence | In bbox |
|---|---|---|---|
| osm | `amenity=toilets` from data/amenities.json | ODbL 1.0 | 165 |
| atlas | ATLAS toilets (`toilet-v2`, opentransportdata.swiss) joined to `service-point-v2` for coordinates | opentransportdata.swiss terms of use (free, attribution) | 12 |
| nette | Stadt Bern "Nette Toilette" flyer (12 restaurants/bars that let anyone use their WC), press release 11.07.2018. Addresses are geocoded exactly with the register extract | public city information | 12 |

Matching: a record from another source within 30 m of an existing one counts as the same toilet. ATLAS uses 100 m, because ATLAS only gives the station centre (its WCs were 30–80 m from the OSM toilet). OSM values win, and the other source fills null fields. A disagreeing wheelchair value would be added to `notes` (none so far). ATLAS `operator` is the station's operator, which is not always the toilet operator. ATLAS edition dates are bulk-edit dates, so they are not used as `check_date`.

Results (2026-11-21): 165 OSM + 12 ATLAS + 12 Nette gives **176 toilets**. 5 of the 12 ATLAS records matched an OSM toilet; 8 of the 12 Nette records matched an OSM toilet node; 10 of the 12 Nette restaurants were found in places.json. 12 have `eurokey=yes`, and 66 have `toilets_wheelchair=yes`.

| Coverage | OSM only (165) | Merged (176) |
|---|---|---|
| toilets_wheelchair known | 86 (52%) | 94 (53%) |
| opening_hours known | 35 (21%) | 35 (20%) |

The merge adds new toilets: 7 station WCs and 4 Nette Toilette restaurants. It does not fill many gaps, because the matched records already had the OSM values.

### Sources checked and not used

- **Stadt Bern geoportal** (map.bern.ch/arcgis/rest/services/Geoportal): all layers were scanned and none covers toilets. The city's own ~40 public WC sites (Stadtbauten / Tiefbauamt) are not published as data. The only city document with a full picture is the 2010 overview poster *Öffentliche Toilettenanlagen in der Stadt Bern* (numbered map, no coordinates or names). It says every accessible cabin in the city's "Normal" type WCs opens with the Eurokey. In OSM, these WCs show up mostly with `operator=Stadt Bern`.
- **Eurokey** (eurokey.ch / Pro Infirmis map, api.paramap.ch): data exists, but only behind an app API marked "© Pro Infirmis, alle Rechte vorbehalten", with no open licence, so it is not imported. Eurokey information comes only from OSM `centralkey`.
- BFS GWR public download (public.madd.bfs.admin.ch/be.zip, 124 MB): same addresses as the swisstopo register, which is easier to read (one CSV), so it is not used.
