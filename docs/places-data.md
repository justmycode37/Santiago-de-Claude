# Places, amenities and official location data (Bern)

Three JSON files in `data/`, all for the bbox S,W,N,E = 46.9, 7.34, 46.99, 7.5 (City of Bern plus edges of Köniz, Muri, Ostermundigen, Ittigen). The map shows them through `map-places.js`, a compact copy built from all three (see [On the map](#on-the-map)).

| File | Items | Source | Refresh (Node 24) |
|---|---|---|---|
| `data/amenities.json` | 7,916 | OpenStreetMap (ODbL) | `node tools/build-amenities.mts` |
| `data/places.json` | 6,685 | OpenStreetMap (ODbL) | `node tools/build-places.mts` |
| `data/official-places.json` | 5,418 | Stadt Bern geoportal, Kanton Bern, SBB, Velospot | `node tools/build-official-places.mts` |

Sources and their quirks: [amenities-sources.md](amenities-sources.md). Random-sample location check: [verification.md](verification.md).

## On the map

`node tools/build-map-places.mts` (run after refreshing any of the three files or the toilet files) writes `map-places.js` (~2.5 MB, ~24,500 places). It sorts every category into one of the groups in `map-layers.js` (toilets, drinking water, health, help, food, shops, money, benches, accessibility, tickets, bikes, kids, schools, sport, culture, places to stay, worship, recycling, other businesses) with an icon and a rank from 1 (hospitals, stations) to 5 (benches, bike racks), keeps OSM objects that appear in both OSM files once, and drops an official item when OSM has the same kind of thing within 25 m (filling in OSM's missing details from it).

Toilets are the exception: they cover all of Switzerland and come from `data/ch/toilets-ch.json` (7,139 toilets: OSM merged with station toilets, six cities' own lists and the Nette Toilette restaurants, see [data-ch-toilets.md](data-ch-toilets.md)), not from the OSM toilets in `amenities.json`. Bern's `data/toilets.json` only adds the notes the Swiss file leaves out, and the build fails if it has a toilet the Swiss file lacks. Who may use a toilet:

- The 88 toilets that are not for the public (`access` private, no, military, employees) are left off the map. Where a city's own list has such a toilet it is shown as public (3), and where only the station list has it, it is shown with the warning below (4).
- Toilets for customers or guests are labelled "Customer toilet", a Nette Toilette "Public toilet (Nette Toilette)". A Nette Toilette is recognised by its source, its notes or its name.
- The card says Key needed (`access` key, centralkey), Permit needed, Wheelchair users only (`access=wheelchair` or `wheelchair=only`) or May be closed or locked. The last one is for toilets whose notes say they are locked or shut ("Der Schlüssel muss am Billettschalter abgeholt werden"), found with a short list of German and French phrases in `build-map-places.mts`, so it misses other wordings.
- A search for the nearest toilet offers none of these restricted ones; "customer toilet" lists those for customers.

The card shows `paid` as Free, Fee (with the price) or Partly free (`mixed`), with the city's own fee text where there is one, and "Free for customers" where OpenStreetMap says so. Online search results (Photon, Google) that lie within 50 m of one of our toilets are dropped as duplicates; other online toilets, for example in Liechtenstein, stay in the list.

In the app, the events button in the ••• menu shows these icons together with the community events, for the groups switched on under Settings › Events and places (community events, toilets and drinking water at first). `map-places.js` is loaded the first time they are shown or the search box is used; the map layer itself is only built once they are shown. The map keeps the same spacing between icons at every zoom: where they would crowd, higher ranks are shown first and the rest appear as you zoom in. Tap an icon for its details (opening hours, fee, wheelchair access, Eurokey, address, website) and directions.

## Place search and Google Places

The search bar works like Google Maps: type a name ("Einstein Kaffee") or what you want ("pizza", "pharmacy open
now", "coffee"); Enter, "See results" or a category chip opens a list (photo, name, rating, price, open or closed
until when, distance, address) with a pin per place, kept in step (`src/app/place-sheet.ts`, loaded on first use).
A row or pin opens the place's card: photos, rating, hours for the week, address, phone, website, reviews where
Google has them, **Directions** (the journey planner) and **Start here**. Parts the data lacks are left out.

**Without a key (default, free):** places come from the Kante engine, swisstopo, `map-places.js` and Photon
(OpenStreetMap); a card adds OpenStreetMap's tags (one OSM API request per type for a whole list) and a Wikidata
photo. "Open now" comes from OSM `opening_hours` (`src/opening-hours.ts`: day ranges, times, past midnight, `off`;
anything else such as `PH` or `sunrise` is shown as mapped, never guessed). No reviews or ratings: OSM has none.

**With `googlePlacesKey` in `config.js`** (`src/places.ts`), Google is asked only for what each step needs, to
stay inside the free monthly caps (since March 2025 per SKU: Essentials 10,000, Pro 5,000, Enterprise 1,000; a
request is billed at the highest SKU of any field it asks for). The app's own limits are per device: only the
project's daily quotas (below) make sure all visitors together stay inside the caps:

| Step | Request | SKU (free/month) | Per device per day |
| --- | --- | --- | --- |
| Typing (from 3 letters, debounced 350 ms) | Autocomplete (New) with a session token; OSM keeps giving the rows with points | Autocomplete Requests, Essentials (10,000): free when the session ends in the Details of a place opened; a session without a pick, one ended by a place already opened on the page, or by a start (Essentials Details: its first 12) is billed per request | 300 |
| Results list | Text Search, Pro fields only (`id, displayName, shortFormattedAddress, location, primaryType(DisplayName), types, businessStatus`) | Text Search Pro (5,000) | 150 |
| Opening a place | Place Details with rating, price, hours, phones, website, photos, reviews, summary | Place Details Enterprise + Atmosphere (1,000) | 30 |
| A prediction picked as the start | Place Details `id,location` | Place Details Essentials (10,000) | 300 |
| Each Google photo shown | Photo media (first photo of a card; the others on tap) | Place Details Photos (1,000) | 30 |
| Google's own card | Maps Embed API iframe, only on tap | free, no limit | — |

- Ratings, price and hours are Enterprise fields, so the list does not ask for them; a place's rating shows in the
  list once you have opened it. List thumbnails are only free photos (OSM, Wikimedia, the engine's).
- Every Google answer is kept in memory for the page's life (the same text from about the same spot, ~1 km, or the
  same place is never asked twice). Nothing of Google's content is stored on the device: Google's terms allow
  storing place IDs (and coordinates for 30 days) only. `localStorage` holds just the day's request counts.
- Over the per-device daily limit (`DAILY` in `places.ts`, about a 31st of each cap; `googleDailyLimits` in
  `config.js` lowers it), or after Google answers 429 (quota) or 403, that kind of request switches to OSM for the
  rest of the day, and a card offers Google's free Embed card instead of Google's details.
- `googlePlacesMode: 'embed'` never calls the Places API: OSM everywhere, Google's Embed card on request. It costs
  nothing at any volume and needs only the Maps Embed API.

### Setting up the key so it can never cost anything

1. Google Cloud console: a project with a **billing account attached** (Google requires one even when usage stays
   within the free caps).
2. APIs & Services → enable **Places API (New)** and **Maps Embed API**.
3. Credentials → API key → restrict it to those two APIs and to the site's HTTP referrers
   (`https://justmycode37.github.io/*`, `http://localhost:8000/*`). The page sends the key from the browser.
4. APIs & Services → **Places API (New)** → **Quotas & System Limits**: set the per-day limits (Edit quota) of
   `SearchText` to 160, `GetPlace` to 32 (it covers both Details SKUs, so this keeps the Enterprise + Atmosphere one
   under 1,000 a month), `AutocompletePlaces` to 320 and `GetPhotoMedia` to 32. Where a method only offers a
   per-minute limit, the Google path cannot be guaranteed free (the per-device limits do not add up across
   visitors: two of them opening 30 places a day pass 1,000 a month): use `googlePlacesMode: 'embed'` instead.
   Over a quota Google answers 429, which the app treats as "OSM for today". These quotas are the only hard stop
   for all visitors together; the device limits spread them out.
5. Billing → Budgets & alerts: a budget of 1 CHF with an alert, to hear of any charge at once (a budget alone does
   not stop spending).

Rough cost beyond the caps (USD per 1,000, first tier): Autocomplete 2.83, Text Search Pro 32, Place Details
Enterprise + Atmosphere 25, Place Details Essentials 5, photos 7. With the quotas above none of it is reached.

**Terms:** Google's Maps Platform terms restrict showing Places API content (names, ratings, reviews, photos) on or
next to a non-Google map, which the MapLibre map is (`googlePlacesKey` has done this since the first Google
search). Check the terms for your billing country before publishing with a key. The Maps Embed card (Google's own
map) and the OSM data are not affected: `googlePlacesMode: 'embed'` is the safe choice for a public site.

## Schemas

`data/amenities.json` = `{ generated, source, items: Amenity[] }`, `Amenity = { id: "node/123", lat, lon, category, name: string|null, opening_hours: string|null, fee: string|null, wheelchair: string|null, website: string|null }`, with `category` in `toilets | drinking_water | pharmacy | hospital | clinic | doctors | library | wifi | atm | supermarket | community_centre`; additive categories (renderers skip unknown ones): `bench | shelter | shower | lockers | post_office | post_box | bank | bureau_de_change | money_transfer | police | townhall | embassy | social_facility | food_sharing | give_box | place_of_worship | dentist | veterinary | aed | emergency_phone | phone_charging | telephone | public_bookcase | internet_cafe | bicycle_repair_station | bicycle_parking | bicycle_rental | recycling | playground | baby_changing | water_point | ticket_machine | ev_charging | car_sharing | taxi | disabled_parking | elevator`. Additive optional fields on every item (string|null, raw OSM values): `address, level, access, operator, phone, description, changing_table, unisex, male, female, toilets_wheelchair, toilets_disposal, drinking_water, covered, backrest, capacity, indoor, check_date`, plus `tags` = raw OSM tag object (minus source*/note*/fixme*/created_by).

`data/places.json` (built by `tools/build-places.mts`, OSM/ODbL) = `{ generated, source, bbox: "S,W,N,E", counts: { [group]: { [category]: n } }, items: Place[] }`, `Place = { id: "node/123", lat, lon, group, category, name, brand, operator, address, street, housenumber, postcode, city, phone, email, website, opening_hours, wheelchair, wheelchair_description, toilets_wheelchair, cuisine, diet: {[k]: v}|null, outdoor_seating, takeaway, delivery, payment: {[k]: v}|null, level, internet_access, wikidata, description, check_date, tags?: {raw OSM tags} }`; every field except `id/lat/lon/group/category` may be `null`, `address` is "street housenumber, postcode city". `group` is one of `food_drink | shopping | lodging | attractions_culture | leisure_sport | services | health | worship`; `category` is the raw OSM value (e.g. `restaurant`, `hairdresser`, `hotel`; a few are renamed: `tourist_information`, `coworking`, `embassy`, `recycling_centre`). One category per place (precedence in the script). Named places only, except `parking`, `fuel`, `charging_station`. `tags` is omitted for categories over 1000 items if the file would exceed 15 MB.

`data/official-places.json` (built by `tools/build-official-places.mts`, official non-OSM data, also used to cross-check OSM) = `{ generated, sources: Source[], items: OfficialPlace[] }`, `Source = { key, name, url, licence, count, fetched_ok, error? }` (a failed source has `fetched_ok: false`, `count: 0`), `OfficialPlace = { id: "<sourceKey>/<native id>", source, lat, lon, category, name, address, opening_hours, wheelchair_or_accessibility, phone, website, email, description, geometry_type, props }`. Every field except `id/source/lat/lon/category/geometry_type/props` may be `null`. Text values are raw German source values (e.g. `wheelchair_or_accessibility` "ja" / "nein" / "unbekannt"). `props` holds every raw source property; polygons are reduced to their centroid with `props.geometry_bbox = [W,S,E,N]`. Sources: Stadt Bern geoportal (`stadtbern.*`, 44 layers), Kanton Bern (`kantonbern.*`: AED, hospitals, elderly and disability care), SBB data.sbb.ch (`sbb.*`), Velospot GBFS (`velospot`, a capacity/vehicle snapshot is in `props.status_snapshot`). Categories include `aed | hospital | elderly_care | disability_services | disabled_parking | acoustic_crossing_signal | tactile_paving | platform_sector_sign | transit_stop | ticket_machine | wifi | bike_share | playground | sports | school | city_office | ...` (list them with `new Set(items.map(i => i.category))`). Bbox 46.9,7.34,46.99,7.5. Licences are per source in `sources[].licence`.


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

Of these, only the toilets are on the map so far (see [On the map](#on-the-map)): `toilets-ch.json`, plus `osm-toilets.json` for websites and phone numbers. The other files are not used by the app yet.

Addresses are filled from the national address register (`tools/enrich-addresses-ch.mts`): 20% → 79% overall. Sample check: [verification-ch.md](verification-ch.md).
