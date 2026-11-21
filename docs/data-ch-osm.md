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

**Skipped on purpose** (too many, or not a basic need): benches, post boxes, bicycle parking, recycling, waste baskets.
Also not carried over from the Bern build: bank, townhall, place_of_worship, veterinary, telephone, water_point, internet_cafe,
car_sharing, taxi, bicycle_rental, embassy, ev_charging, baby_changing, ticket_machine.

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

## Licence

Data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0, https://www.openstreetmap.org/copyright.
Any app or derived database must show "© OpenStreetMap contributors" and keep derived data under ODbL.
