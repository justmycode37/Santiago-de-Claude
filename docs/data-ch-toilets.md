# Swiss toilets (`data/ch/toilets-ch.json`) and CH address enrichment

Two steps on top of [data-ch-osm.md](data-ch-osm.md) and [data-ch-official.md](data-ch-official.md). They are the Switzerland-wide
versions of Bern's `tools/build-toilets.mjs` and `tools/enrich-addresses.mjs` (see `docs/data-enrichment.md` on the toilets-ch branch).

## Rebuild order (Node 24, no npm deps, `unzip` on PATH for the first enrichment run)

```sh
node tools/build-amenities-ch.mjs     # data/ch/osm-*.json            (~10 min, Overpass)
node tools/build-official-ch.mjs      # data/ch/official-ch.json      (~30 s, needs data/raw ATLAS CSVs)
node tools/build-toilets.mjs          # data/toilets.json             (Bern; only its Nette Toilette records are used)
node tools/build-toilets-ch.mjs       # data/ch/toilets-ch.json       (<1 s)
node tools/enrich-addresses-ch.mjs    # fills addresses in all of the above data/ch files in place (~40 s)
```

`build-toilets-ch.mjs [out] [bern-toilets.json]` takes the Bern file path as its 2nd argument (default `data/toilets.json`).
Re-running a build step resets the addresses of its output, so run `enrich-addresses-ch.mjs` again afterwards. Running
`build-toilets-ch.mjs` after the enrichment is also fine: it carries `address_source` over, so derived addresses stay marked.

## 1. Merged toilets (`tools/build-toilets-ch.mjs`)

```
{ generated, sources: [{ key, name, url?, licence, count }],
  items: [{ id, lat, lon, name, address, postcode, city, canton, sources[], access, paid, price, wheelchair, toilets_wheelchair,
            eurokey, changing_table, unisex, opening_hours, operator, level, check_date, notes, address_source?, address_distance_m? }] }
```

Every field except `id/lat/lon/canton/sources` may be null (= unknown). OSM `"unknown"` becomes null. Values are OSM-style strings.

### Sources

| key | records | what |
|---|---:|---|
| osm | 6 834 | `amenity=toilets`, `data/ch/osm-toilets.json` (ODbL) |
| zh.zueriwc, bs.wc, ge.wc, lu.wc, sg.wc, zg.stadtmobiliar | 486 | city WC registries from `official-ch.json` (139 / 139 / 78 / 60 / 33 / 37) |
| atlas.toilet | 616 | ATLAS station toilets from `official-ch.json`, CH-wide. The position is the **station centre**. 1 record "Keine Toiletten verfügbar" is dropped. |
| nette | 12 | Stadt Bern "Nette Toilette" restaurants, all records of `data/toilets.json` with a `nette:` source |

### Merge method

- Matching is one-to-one and greedy, best pair first. An OSM toilet absorbs at most one record per group.
  - City WC ↔ OSM toilet within **30 m** (same site): 382 of 486 matched.
  - ATLAS ↔ OSM toilet within **100 m** (ATLAS gives the station centre, its WCs are typically 30–80 m away). An OSM toilet that looks like a station
    toilet (name/operator matches Bahnhof/gare/stazione/SBB/BLS/RhB/…, shares a word with the station name, or has a `level`) gets a 50 m bonus,
    so it wins over a closer anonymous one: 419 of 616 matched (192 within 25 m, 158 within 50 m, 47 within 75 m, 22 within 100 m).
  - Nette ↔ OSM by OSM id when Bern already matched it (8), else within 30 m (0 more).
  - Unmatched records become their own items with their own id (`zh.zueriwc/wc041`, `atlas.toilet/ch:1:sloid:…`, `nette/1`). Unmatched ATLAS
    items say "position is the station centre" in `notes`.
- Precedence: **official city data (incl. Nette) > OSM > none** for `paid`, `price`, `wheelchair`, `toilets_wheelchair`, `eurokey`. A disagreement on
  `paid` or wheelchair is kept in `notes` ("OSM says paid=free"); `yes` and `designated` count as the same. ATLAS only fills gaps (and its
  disagreements are noted as "atlas says …"). OSM wins for `name`, `opening_hours` (city data is free text, OSM is machine-readable), `access`,
  `operator` and the rest; the other source fills nulls.
- Address is merged as one unit (`address, postcode, city, address_source, address_distance_m`): a stated address beats one derived from the
  register, and OSM's stated address beats the other source's.
- `sources`: `osm:<osm id>`, `<official id> (d m)`, `nette/<n> (d m)`, `osm-place:<id>` (restaurant record Bern used for a Nette Toilette).
- `toilets_wheelchair`: a wheelchair-accessible WC exists. OSM: `toilets:wheelchair`, else `wheelchair` (on a standalone toilet it describes the
  toilet). Official: the source's normalised wheelchair value. `wheelchair` = step-free access to the place (not set from ATLAS).
- `eurokey = "yes"`: OSM `centralkey=eurokey` (only known for Bern, via `data/toilets.json`; the slim CH OSM files dropped that tag) or
  `access=centralkey`; Basel `eurokey`, Luzern `EUROKEY`, or "Eurokey" in a Zürich fee text. null = unknown, not "no".
- **Nothing is excluded.** Customers-only, private, permit etc. stay and are flagged by `access` (official city WCs get `access=yes`,
  ATLAS null). For a "public toilets" filter use `access` ∈ null | yes | permissive (6 548 items).

### Paid semantics (filter: paid vs not paid)

`paid` ∈ `"free" | "paid" | "mixed" | null`:

- `free`: usable without paying. OSM `fee=no` / `charge=0`, `fee=donation`; city text "Gebührenfrei", "kostenlos", "gratuit"; all Nette Toilette
  (Bern and Luzern `ART=Nette Toilette`).
- `paid`: you pay to use it. OSM `fee=yes` / non-zero `charge`; city text with a price or "kostenpflichtig". "Eurokey gratis" or "Pissoir gratis"
  alone does not make it free.
- `mixed`: the site has both a free and a paying WC, by cabin or by time of day. Re-derived from the raw fee text (`official-ch.json` `fee` =
  Zürich `gebuehren`), because `build-official-ch.mjs` calls these `free`. Examples: "Behinderten-WC Fr. 1.-- oder Eurokey, Multifunktions-WC
  gratis", "Gebührenfrei. Behinderten-WC mit Eurokey oder Fr. 1.--", "06:00-22:00 Gratis. Nachts 1.- oder Eurokey", Geneva "Gratuit de 8h à 20h,
  payant de 20h à 8h". Typically the accessible WC costs CHF 1 (free with Eurokey) and the standard one is free.
- null: unknown.

`price` is `"CHF 1.00"` style (`EUR` only when no CHF amount is given), set for `paid`/`mixed` when an amount is known (211 items: CHF 1.00 191,
CHF 0.50 8, CHF 1.50 8, CHF 2.00 3, EUR 1.00 1). The raw fee text is kept in `notes` when it says more than free/paid.

### Counts (build of 2026-11-21)

**7 139 toilets** = 6 834 OSM + 486 city + 616 ATLAS + 12 Nette − 809 matched. 309 disagreements noted.

| | free | paid | mixed | unknown |
|---|---:|---:|---:|---:|
| all | 3 217 | 379 | 65 | 3 478 |

Per source (items that contain the source, final `paid` value) and wheelchair coverage (`toilets_wheelchair` known):

| source | items | free | paid | mixed | unknown | wheelchair known |
|---|---:|---:|---:|---:|---:|---:|
| osm | 6 834 | 3 182 | 375 | 59 | 3 218 | 52 % |
| atlas.toilet | 616 | 187 | 133 | 3 | 293 | 98 % |
| zh.zueriwc | 139 | 35 | 22 | 64 | 18 | 100 % |
| bs.wc | 139 | 134 | 5 | 0 | 0 | 100 % |
| ge.wc | 78 | 45 | 2 | 1 | 30 | 100 % |
| lu.wc | 60 | 47 | 0 | 0 | 13 | 98 % |
| sg.wc | 33 | 23 | 0 | 0 | 10 | 79 % |
| zg.stadtmobiliar | 37 | 18 | 0 | 0 | 19 | 49 % |
| nette | 12 | 12 | 0 | 0 | 0 | 33 % |

Per canton:

| canton | items | free | paid | mixed | unknown | wheelchair known |
|---|---:|---:|---:|---:|---:|---:|
| AG | 273 | 100 | 22 | 0 | 151 | 53 % |
| AI | 30 | 18 | 0 | 0 | 12 | 57 % |
| AR | 39 | 19 | 0 | 0 | 20 | 59 % |
| BE | 1 031 | 424 | 42 | 0 | 565 | 51 % |
| BL | 100 | 33 | 10 | 0 | 57 | 41 % |
| BS | 224 | 180 | 6 | 0 | 38 | 94 % |
| FR | 168 | 80 | 2 | 0 | 86 | 46 % |
| GE | 196 | 92 | 5 | 1 | 98 | 67 % |
| GL | 63 | 25 | 2 | 0 | 36 | 48 % |
| GR | 591 | 269 | 29 | 0 | 293 | 47 % |
| JU | 48 | 14 | 0 | 0 | 34 | 38 % |
| LU | 296 | 121 | 6 | 0 | 169 | 55 % |
| NE | 132 | 65 | 8 | 0 | 59 | 48 % |
| NW | 95 | 58 | 0 | 0 | 37 | 52 % |
| OW | 93 | 45 | 4 | 0 | 44 | 48 % |
| SG | 494 | 232 | 28 | 0 | 234 | 50 % |
| SH | 75 | 39 | 5 | 0 | 31 | 63 % |
| SO | 96 | 31 | 12 | 0 | 53 | 55 % |
| SZ | 171 | 85 | 12 | 0 | 74 | 62 % |
| TG | 210 | 89 | 13 | 0 | 108 | 48 % |
| TI | 349 | 167 | 25 | 0 | 157 | 48 % |
| UR | 134 | 67 | 9 | 0 | 58 | 55 % |
| VD | 663 | 277 | 24 | 0 | 362 | 50 % |
| VS | 488 | 196 | 12 | 0 | 280 | 36 % |
| ZG | 141 | 59 | 4 | 0 | 78 | 57 % |
| ZH | 939 | 432 | 99 | 64 | 344 | 63 % |

Wheelchair: `toilets_wheelchair` known for 3 803 (53 %): yes 2 137, designated 95, limited 241, no 1 327, only 3. Free or mixed **and**
wheelchair-accessible: 1 392. `eurokey=yes`: 144.

Self-checks (build fails, nothing written): fee parser and price unit cases (Zürich mixed texts, Eurokey/pissoir exceptions, time-of-day), unique
ids, every point inside CH, `paid` in the allowed set, `price` format and never on a free toilet, canton on every item, item count =
inputs − matches, at least 30 mixed sites, file < 40 MB (it is 3.3 MB).

## 2. Address enrichment (`tools/enrich-addresses-ch.mjs`)

Source: swisstopo *Amtliches Gebäudeadressverzeichnis*, national CSV in LV95, `data/raw/gebaeudeadressen_ch.csv.zip` (469 MB unzipped).
Licence: open government data, free use with attribution ("Source: swisstopo / Amtliches Gebäudeadressverzeichnis").

- The first run streams the zip through `unzip -p` and caches a compact extract, `data/raw/gebaeudeadressen-ch.csv.gz` (61.5 MB, columns
  `E;N;street;nr;ZIP_LABEL`, 3 184 090 addresses with `ADR_STATUS=real`, a street and a number; 4 rows with a `;` inside a field are skipped).
  Delete it to re-read the zip.
- Each run loads the target files, collects the 50 m LV95 grid cells (plus neighbours) around items that need an address, then streams the
  cache and keeps only addresses in those cells (778 k).
- Every item with `address == null` (or with an address derived on an earlier run, which is redone, so the script is idempotent) takes the
  nearest register address within **25 m**: `address = "Street Nr"`, `postcode`, `city` (locality from `ZIP_LABEL`, e.g. "3032 Hinterkappelen"),
  `address_source = "derived:gwr"`, `address_distance_m`. Postcode and city are overwritten with the register's so they match the address.
  Nothing else in the files changes. Stated addresses are not checked against the register here (the Bern script's `street_mismatch` check is not
  ported).
- Self-checks: LV95 conversion, cache size, every derived address within 25 m with a 4-digit postcode, grid lookup = brute force for samples.

Address coverage, run of 2026-11-21 (median = distance to the derived address):

| file | items | before | after | derived | median m |
|---|---:|---:|---:|---:|---:|
| osm-aed | 17 443 | 10.1 % | 88.3 % | 13 650 | 8.5 |
| osm-atm | 2 322 | 4.5 % | 91.5 % | 2 021 | 8.0 |
| osm-bicycle_repair_station | 406 | 1.7 % | 70.0 % | 277 | 12.9 |
| osm-bureau_de_change | 97 | 39.2 % | 91.8 % | 51 | 7.0 |
| osm-clinic | 461 | 60.5 % | 97.0 % | 168 | 9.8 |
| osm-community_centre | 1 059 | 57.3 % | 96.9 % | 419 | 7.9 |
| osm-dentist | 784 | 47.4 % | 98.1 % | 397 | 6.6 |
| osm-disabled_parking | 5 229 | 1.5 % | 64.1 % | 3 274 | 15.8 |
| osm-doctors | 2 378 | 58.6 % | 98.6 % | 952 | 7.1 |
| osm-drinking_water | 17 902 | 0.1 % | 71.8 % | 12 830 | 12.6 |
| osm-elevator | 1 359 | 0.2 % | 75.9 % | 1 029 | 6.4 |
| osm-emergency_phone | 1 579 | 0.0 % | 8.9 % | 141 | 17.0 |
| osm-food_sharing | 84 | 26.2 % | 94.0 % | 57 | 9.0 |
| osm-give_box | 24 | 12.5 % | 87.5 % | 18 | 9.8 |
| osm-hospital | 296 | 69.6 % | 89.5 % | 59 | 12.5 |
| osm-library | 1 246 | 79.5 % | 97.8 % | 227 | 8.4 |
| osm-lockers | 151 | 0.0 % | 72.2 % | 109 | 11.9 |
| osm-money_transfer | 54 | 31.5 % | 94.4 % | 34 | 7.9 |
| osm-pharmacy | 1 644 | 58.6 % | 96.0 % | 616 | 7.4 |
| osm-phone_charging | 11 | 0.0 % | 81.8 % | 9 | 11.3 |
| osm-playground | 14 520 | 0.5 % | 58.7 % | 8 454 | 17.2 |
| osm-police | 614 | 74.9 % | 97.1 % | 136 | 7.9 |
| osm-post_office | 1 372 | 45.0 % | 98.0 % | 727 | 8.0 |
| osm-public_bookcase | 854 | 1.4 % | 78.9 % | 662 | 11.6 |
| osm-shelter | 7 111 | 15.1 % | 73.4 % | 4 149 | 2.7 |
| osm-shower | 709 | 0.4 % | 50.4 % | 354 | 8.9 |
| osm-social_facility | 2 291 | 70.6 % | 96.8 % | 599 | 10.6 |
| osm-supermarket | 4 151 | 61.6 % | 93.6 % | 1 328 | 9.1 |
| osm-toilets | 6 834 | 3.4 % | 81.1 % | 5 316 | 6.1 |
| osm-wifi | 1 040 | 61.0 % | 93.0 % | 333 | 8.1 |
| official-ch | 11 991 | 67.7 % | 92.5 % | 2 976 | 11.4 |
| toilets-ch | 7 139 | 8.1 % | 81.7 % | 5 256 | 6.3 |
| **total** | 113 155 | 20.2 % | 79.1 % | | |

A derived address is the nearest building entrance, not a verified postal address: for street furniture (fountains, playgrounds, emergency
phones in the mountains) it means "next to this building"; items more than 25 m from any building stay null.
