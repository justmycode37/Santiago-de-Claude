# Switzerland basic-needs amenities (OpenStreetMap)

`data/ch/osm-<category>.json`, built by `tools/build-amenities-ch.mts`. Switzerland-wide version of the Bern build
(`tools/build-amenities.mts`): same Overpass tags, same `categorize()` (first match wins, so a library with free wifi stays a library),
same node/way dedupe (same category within ~1 m, or same category + name within 15 m; nodes win over ways).

## Rebuild

```sh
node tools/build-amenities-ch.mts            # writes data/ch/osm-*.json, ~10 min
```

- Source: `https://overpass.osm.ch/api/interpreter` (Swiss instance; overpass-api.de times out from here).
- One query per canton (`area["ISO3166-2"="CH-XX"][admin_level=4]`, 26 queries, 3 s apart). The area filter keeps only points in
  Switzerland (drops Büsingen, Campione, Liechtenstein) and gives every item its `canton` exactly, so no postcode lookup is needed.
  Ways crossing a canton border are returned twice; the first canton wins.
- Each query carries a nonce comment and is retried 6x with growing backoff on HTTP errors, XHTML error pages
  (overload, `duplicate_query`) and any `remark` (timeout / out-of-memory = partial result).
- Self-checks (build fails, nothing written): unique ids, every point inside the CH bbox 45.8,5.95,47.81,10.5, toilets / drinking_water /
  pharmacy non-empty, more than 100 toilets inside the Bern bbox, each file < 40 MB, unit asserts for `paid`.

## File format

```json
{ "generated": "ISO time", "source": "OpenStreetMap contributors via overpass.osm.ch", "licence": "ODbL",
  "category": "toilets", "count": 6834, "items": [ ... ] }
```

Slim items, no raw `tags`, `null` when absent: `id` (`node/123`), `lat`, `lon` (6 dp; way/relation = centre), `name`,
`address` (street + housenumber only), `postcode`, `city`, `canton` (two-letter code), `opening_hours`, `fee`, `access`, `wheelchair`,
`toilets_wheelchair`, `changing_table`, `unisex`, `operator`, `phone`, `website`, `level`, `indoor`, `drinking_water`, `check_date`.

Toilets and showers also have `charge`, `fee_conditional` (`fee:conditional`), `payment_coins` (`payment:coins`) and a normalised
`paid`: `"free"` when fee=no/0 or charge is 0, `"paid"` when fee=yes or charge is non-zero, else `null`. `fee` wins over `charge`.

## Categories (build of 2026-11-21, 94 025 items)

| category | OSM tags | count | raw MB | gzip MB |
|---|---|---:|---:|---:|
| toilets | amenity=toilets | 6 834 | 3.01 | 0.18 |
| drinking_water | amenity=drinking_water; amenity=fountain / man_made=water_tap + drinking_water=yes | 17 902 | 6.53 | 0.34 |
| shower | amenity=shower | 709 | 0.31 | 0.02 |
| pharmacy | amenity=pharmacy | 1 644 | 0.73 | 0.08 |
| hospital | amenity=hospital | 296 | 0.13 | 0.02 |
| clinic | amenity=clinic | 461 | 0.20 | 0.03 |
| doctors | amenity=doctors | 2 378 | 1.02 | 0.13 |
| dentist | amenity=dentist | 784 | 0.34 | 0.04 |
| aed | emergency=defibrillator | 17 443 | 6.94 | 0.60 |
| library | amenity=library | 1 246 | 0.61 | 0.09 |
| community_centre | amenity=community_centre | 1 059 | 0.44 | 0.06 |
| social_facility | amenity=social_facility | 2 291 | 1.00 | 0.13 |
| food_sharing | amenity=food_sharing | 84 | 0.03 | 0.00 |
| give_box | amenity=give_box | 24 | 0.01 | 0.00 |
| public_bookcase | amenity=public_bookcase | 854 | 0.33 | 0.03 |
| police | amenity=police | 614 | 0.27 | 0.04 |
| post_office | amenity=post_office | 1 372 | 0.57 | 0.06 |
| atm | amenity=atm | 2 322 | 0.89 | 0.07 |
| bureau_de_change | amenity=bureau_de_change | 97 | 0.04 | 0.01 |
| money_transfer | amenity=money_transfer | 54 | 0.02 | 0.00 |
| supermarket | shop=supermarket | 4 151 | 1.84 | 0.20 |
| wifi | internet_access=wlan + internet_access:fee=no | 1 040 | 0.46 | 0.07 |
| phone_charging | amenity=device_charging_station | 11 | 0.00 | 0.00 |
| lockers | amenity=locker / lockers / luggage_locker | 151 | 0.06 | 0.00 |
| shelter | amenity=shelter | 7 111 | 2.60 | 0.15 |
| emergency_phone | emergency=phone | 1 579 | 0.58 | 0.03 |
| elevator | highway=elevator | 1 359 | 0.50 | 0.03 |
| disabled_parking | parking_space=disabled; amenity=parking with capacity:disabled > 0 | 5 229 | 1.92 | 0.11 |
| bicycle_repair_station | amenity=bicycle_repair_station | 406 | 0.15 | 0.01 |
| playground | leisure=playground | 14 520 | 5.30 | 0.29 |

Largest file is 6.9 MB, far below the 40 MB budget. Total about 37 MB raw, 2.9 MB gzipped.

Benches, post boxes, bicycle parking, recycling and the other amenities of the Bern build that are not basic needs are in
`osm-places-amenities.json.gz` ([below](#places-and-the-other-amenities-osm-places-groupjsongz)). Waste baskets are left out.

## Field coverage

Toilets (6 834): fee 53 %, wheelchair 49 %, access 43 %, changing_table 16 %, check_date 11 %, opening_hours 10 %,
address 3 %, postcode 2 %, charge 2.5 %, payment_coins 0.9 %, toilets_wheelchair 2 %.
`paid`: free 3 187, paid 405, unknown 3 242. Showers: free 236, paid 35, unknown 438.

Address (street) coverage per category: high for staffed places (library 80 %, police 75 %, social_facility 71 %, hospital 70 %,
supermarket 62 %, pharmacy 59 %, doctors 59 %), near zero for street furniture (toilets 3 %, drinking_water 0 %, playground 0 %,
aed 10 %). Opening hours: supermarket 76 %, aed 70 %, pharmacy 63 %, others mostly < 45 %.
Missing addresses are meant to be filled later from the official address register.

## Sanity check

Toilets inside the Bern bbox (46.9,7.34,46.99,7.5): 165, same as the Bern build (`data/amenities.json`, 165).

## Places and the other amenities (`osm-places-<group>.json.gz`)

`data/ch/osm-places-<group>.json.gz`, built by `tools/build-places-ch.mts`: everything the Bern map has that the files above lack, for
all of Switzerland. The categorize() of both Bern builds is shared (`tools/osm-categories.mts`), so a place gets the same category as in
Bern.

```sh
node tools/build-places-ch.mts [data/ch] [--cache <dir>]   # ~10 min; --cache keeps each Overpass answer for a re-run
node tools/build-map-places.mts                             # then the map's tiles
```

- Same source, canton areas, nonce, retries and backoff as above. Per canton seven queries, so none times out (two at a time):
  food, shops, culture and lodging, leisure and health and worship, services, the other amenities, benches. Places must have a name,
  except parking (with a name or a capacity), fuel and EV charging, as in the Bern build; the queries ask for named objects only
  where categorize() would drop the unnamed ones anyway.
- Places (`tools/build-places.mts` rules): the same name and category within 25 m (a shop as a point and as its building) is kept once,
  the one with more tags. Amenities (`tools/build-amenities.mts` rules, only the categories the files above lack): same category within
  ~1 m, or same category and name within 15 m; nodes win. An object can be both (a bank: a place in `services` and the amenity `bank`):
  `tools/build-map-places.mts` keeps it once.
- Points whose centre lies outside the CH bbox (7 ways along the border) are dropped.
- Self-checks (nothing written when one fails): unique ids, every point inside the CH bbox, minimum counts (restaurants, cafés, hotels,
  bakeries, hairdressers, schools, places of worship, benches, bike parking, recycling, post boxes, EV charging), and in the Bern bbox
  at least 80 % of the restaurants, cafés and hairdressers of `data/places.json`.

Format: gzipped `{ generated, source, licence, group?, counts: { [category]: n }, count, items }`. Slim items, no raw tags, a field
that is not tagged is **left out**: places have the fields of `data/places.json` (docs/places-data.md: `id, lat, lon, group, category,
name, brand, operator, address` = "street number, postcode city", `street, housenumber, postcode, city, phone, email, website,
opening_hours, wheelchair, wheelchair_description, toilets_wheelchair, cuisine, diet, outdoor_seating, takeaway, delivery, payment,
level, internet_access, wikidata, description, check_date`) plus `canton`; amenities `id, lat, lon, category, canton, name, address,
opening_hours, fee, access, wheelchair, website, operator, phone, level, description, changing_table, covered, backrest, capacity,
check_date`.

Build of 2026-11-28:

| file | items | raw MB | gzip MB |
|---|---:|---:|---:|
| osm-places-food_drink | 34 306 | 10.32 | 2.04 |
| osm-places-shopping | 39 485 | 11.11 | 2.10 |
| osm-places-lodging | 7 664 | 2.19 | 0.46 |
| osm-places-attractions_culture | 19 907 | 4.85 | 0.88 |
| osm-places-leisure_sport | 9 552 | 2.01 | 0.41 |
| osm-places-services | 66 671 | 14.57 | 2.76 |
| osm-places-health | 7 207 | 2.14 | 0.42 |
| osm-places-worship | 5 332 | 1.32 | 0.25 |
| osm-places-amenities | 162 363 | 19.00 | 2.68 |

Amenities: bench 106 814, bicycle_parking 16 997, recycling 9 055, post_box 8 409, place_of_worship 6 983, ev_charging 3 697,
ticket_machine 2 911, bank 2 185, car_sharing 1 453, townhall 1 411, bicycle_rental 1 072, veterinary 411, taxi 352, embassy 249,
telephone 184, water_point 178, internet_cafe 2 (no `amenity=changing_table` in Switzerland).

## Licence

Data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0, https://www.openstreetmap.org/copyright.
Any app or derived database must show "© OpenStreetMap contributors" and keep derived data under ODbL.
