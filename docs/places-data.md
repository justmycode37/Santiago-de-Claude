# Places, amenities and official location data (Bern)

Three JSON files in `data/`, all for the bbox S,W,N,E = 46.9, 7.34, 46.99, 7.5 (City of Bern plus edges of Köniz, Muri, Ostermundigen, Ittigen). The map shows them through `map-places.js`, a compact copy built from all three (see [On the map](#on-the-map)).

| File | Items | Source | Refresh (Node 24) |
|---|---|---|---|
| `data/amenities.json` | 7,916 | OpenStreetMap (ODbL) | `node tools/build-amenities.mjs` |
| `data/places.json` | 6,685 | OpenStreetMap (ODbL) | `node tools/build-places.mjs` |
| `data/official-places.json` | 5,418 | Stadt Bern geoportal, Kanton Bern, SBB, Velospot | `node tools/build-official-places.mjs` |

Sources and their quirks: [amenities-sources.md](amenities-sources.md). Random-sample location check: [verification.md](verification.md).

## On the map

`node tools/build-map-places.mjs` (run after refreshing any of the three files) writes `map-places.js` (~1.6 MB, ~17,600 places). It sorts every category into one of the groups in `map-layers.js` (toilets, drinking water, health, help, food, shops, money, benches, accessibility, tickets, bikes, kids, schools, sport, culture, places to stay, worship, recycling, other businesses) with an icon and a rank from 1 (hospitals, stations) to 5 (benches, bike racks), keeps OSM objects that appear in both OSM files once, and drops an official item when OSM has the same kind of thing within 25 m (filling in OSM's missing details from it).

In the app, the events button in the ••• menu shows these icons together with the community events, for the groups switched on under Settings › On the map (all of them at first). `map-places.js` is only loaded the first time they are shown. The map keeps the same spacing between icons at every zoom: where they would crowd, higher ranks are shown first and the rest appear as you zoom in. Tap an icon for its details (opening hours, fee, wheelchair access, address, website) and directions.

## Schemas

`data/amenities.json` = `{ generated, source, items: Amenity[] }`, `Amenity = { id: "node/123", lat, lon, category, name: string|null, opening_hours: string|null, fee: string|null, wheelchair: string|null, website: string|null }`, with `category` in `toilets | drinking_water | pharmacy | hospital | clinic | doctors | library | wifi | atm | supermarket | community_centre`; additive categories (renderers skip unknown ones): `bench | shelter | shower | lockers | post_office | post_box | bank | bureau_de_change | money_transfer | police | townhall | embassy | social_facility | food_sharing | give_box | place_of_worship | dentist | veterinary | aed | emergency_phone | phone_charging | telephone | public_bookcase | internet_cafe | bicycle_repair_station | bicycle_parking | bicycle_rental | recycling | playground | baby_changing | water_point | ticket_machine | ev_charging | car_sharing | taxi | disabled_parking | elevator`. Additive optional fields on every item (string|null, raw OSM values): `address, level, access, operator, phone, description, changing_table, unisex, male, female, toilets_wheelchair, toilets_disposal, drinking_water, covered, backrest, capacity, indoor, check_date`, plus `tags` = raw OSM tag object (minus source*/note*/fixme*/created_by).

`data/places.json` (built by `tools/build-places.mjs`, OSM/ODbL) = `{ generated, source, bbox: "S,W,N,E", counts: { [group]: { [category]: n } }, items: Place[] }`, `Place = { id: "node/123", lat, lon, group, category, name, brand, operator, address, street, housenumber, postcode, city, phone, email, website, opening_hours, wheelchair, wheelchair_description, toilets_wheelchair, cuisine, diet: {[k]: v}|null, outdoor_seating, takeaway, delivery, payment: {[k]: v}|null, level, internet_access, wikidata, description, check_date, tags?: {raw OSM tags} }`; every field except `id/lat/lon/group/category` may be `null`, `address` is "street housenumber, postcode city". `group` is one of `food_drink | shopping | lodging | attractions_culture | leisure_sport | services | health | worship`; `category` is the raw OSM value (e.g. `restaurant`, `hairdresser`, `hotel`; a few are renamed: `tourist_information`, `coworking`, `embassy`, `recycling_centre`). One category per place (precedence in the script). Named places only, except `parking`, `fuel`, `charging_station`. `tags` is omitted for categories over 1000 items if the file would exceed 15 MB.

`data/official-places.json` (built by `tools/build-official-places.mjs`, official non-OSM data, also used to cross-check OSM) = `{ generated, sources: Source[], items: OfficialPlace[] }`, `Source = { key, name, url, licence, count, fetched_ok, error? }` (a failed source has `fetched_ok: false`, `count: 0`), `OfficialPlace = { id: "<sourceKey>/<native id>", source, lat, lon, category, name, address, opening_hours, wheelchair_or_accessibility, phone, website, email, description, geometry_type, props }`. Every field except `id/source/lat/lon/category/geometry_type/props` may be `null`. Text values are raw German source values (e.g. `wheelchair_or_accessibility` "ja" / "nein" / "unbekannt"). `props` holds every raw source property; polygons are reduced to their centroid with `props.geometry_bbox = [W,S,E,N]`. Sources: Stadt Bern geoportal (`stadtbern.*`, 44 layers), Kanton Bern (`kantonbern.*`: AED, hospitals, elderly and disability care), SBB data.sbb.ch (`sbb.*`), Velospot GBFS (`velospot`, a capacity/vehicle snapshot is in `props.status_snapshot`). Categories include `aed | hospital | elderly_care | disability_services | disabled_parking | acoustic_crossing_signal | tactile_paving | platform_sector_sign | transit_stop | ticket_machine | wifi | bike_share | playground | sports | school | city_office | ...` (list them with `new Set(items.map(i => i.category))`). Bbox 46.9,7.34,46.99,7.5. Licences are per source in `sources[].licence`.


## More datasets (data-gaps branch)

| File | What | Docs |
|---|---|---|
| `data/toilets.json` | 176 toilets merged from OSM, ATLAS station toilets and the city's Nette Toilette partners, with access and wheelchair fields | [data-enrichment.md](data-enrichment.md) |
| `data/places.min.json`, `data/amenities.min.json` | Browser copies without raw tags; addresses filled from the official address register (89% / 70%) | [data-enrichment.md](data-enrichment.md) |
| `data/services.json` | 1,686 canton/federal service points (job centres, KESB, debt collection, childcare, worship, emergency meeting points, asylum centres) | [data-services.md](data-services.md) |
| `data/help.json`, `data/offices.json` | Hand-curated help: food distribution, fridges, day centres, shelters, legal advice, health, hotlines, language courses, discounts | [data-help.md](data-help.md) |
| `data/fares.json` | Libero tickets, prices, where to buy, fines | [data-help.md](data-help.md) |
| `data/bern-stop-accessibility.json`, `data/bern-stop-frequency.json` | Wheelchair verdict, kerb height and departures per hour for 387 Bern stops | [data-transit-access.md](data-transit-access.md) |
| `data/station-lifts.json`, `data/street-slopes.geojson`, `data/construction-sites.geojson`, `data/holidays.json` | Lifts/escalators/ramps near stations, street slope %, current construction sites, public and school holidays | [data-streets.md](data-streets.md) |

Sample check of these files: [verification-2.md](verification-2.md).

## Switzerland-wide basic needs (`data/ch/`)

| File | What | Docs |
|---|---|---|
| `data/ch/toilets-ch.json` | 7,139 toilets merged from OSM, ATLAS station toilets and the official lists of Zürich, Basel, Geneva, Luzern, St. Gallen, Zug; `paid` = free (3,217) / paid (379) / mixed (65) / null (3,478), `price` where known | [data-ch-toilets.md](data-ch-toilets.md) |
| `data/ch/osm-<category>.json` | 94,025 OSM basic amenities in 30 files (drinking water, AED, pharmacy, hospital, shower, playground, ...) with canton | [data-ch-osm.md](data-ch-osm.md) |
| `data/ch/official-ch.json` | 11,991 official points from 29 sources (city toilets and fountains, AED registers, hospitals, BABS emergency meeting points, SBB) | [data-ch-official.md](data-ch-official.md) |
| `data/ch/help-ch.json` | 543 places from national networks (Tischlein deck dich, Caritas-Markt, Madame Frigo, Nette Toilette Basel/Luzern/Solothurn, big-city shelters and soup kitchens) + 10 national hotlines | [data-ch-help.md](data-ch-help.md) |

Addresses are filled from the national address register (`tools/enrich-addresses-ch.mjs`): 20% → 79% overall. Sample check: [verification-ch.md](verification-ch.md).
