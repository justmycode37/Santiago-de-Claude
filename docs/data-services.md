# Service locations for newcomers (canton Bern)

`data/services.json`: official locations of public services a newcomer or refugee in Bern needs (municipal office,
job centre, career centre, childcare, conciliation for rent/work disputes, debt collection office, KESB, asylum centre,
emergency meeting points, places of worship). Whole canton Bern; `in_bern_bbox` flags items inside 46.9,7.34,46.99,7.5.
Not wired into the UI.

Rebuild (Node 24, no npm deps, about 1 minute, about 400 HTTP requests):

```
node tools/build-services.mjs            # writes data/services.json (about 1.9 MB)
```

A source that fails is recorded with `fetched_ok: false` and `error`, and the build continues. The script asserts that
ids are unique, coordinates are finite and inside Switzerland (45.8-47.9 / 5.9-10.6), categories are known, no private
contact data from the religion map is present, only Kitas come from KIBEAGS, and its LV95->WGS84 formula agrees with
the geocoder's own pairs (350 points, worst 1.1 m).

## Schema

```
{ generated, sources: Source[], items: Service[] }
Source  = { key, name, url, licence, count, fetched_ok, error?, note? }   // note = addresses that could not be geocoded
Service = { id: "<source>/<native id>", source, category, name, address, postcode, city, lat, lon, phone, email,
            website, opening_hours, languages, description, in_bern_bbox, props }
```

Any field except `id/source/category/lat/lon/in_bern_bbox/props` may be `null`. `address` is the street line only;
`postcode` is a string. `opening_hours` is always null (no source publishes it). `languages` is only set to `["fr"]` for
the French-speaking SPE family counselling offices. `props` holds the raw source attributes, plus `lv95` for point
sources, or `point_is`, `geocode` and `region_bbox_lv95` for region sources (see below).

## Sources and counts (build of 2026-11-21)

| key | category | items | in bbox | source |
|---|---|---|---|---|
| `babs.notfalltreffpunkte` | `emergency_meeting_point` | 217 | 15 | BABS, STAC `ch.babs.notfalltreffpunkte` geojson, filtered `kanton = BE` |
| `sem.sachplan-asyl` | `federal_asylum_centre` | 3 | 1 | SEM Sachplan Asyl, geo.admin layer `ch.sem.sachplan-asyl_kraft` (Bern, Kappelen, Lyss) |
| `kantonbern.religion_relstaet` | `place_of_worship` | 648 | 117 | Kanton Bern `RELIGION` |
| `kantonbern.kibeags_betrstd` | `childcare` | 357 | 127 | Kanton Bern `KIBEAGS` (Kitas in the voucher system) |
| `kantonbern.admrav_ravzp` | `job_centre` | 7 | 2 | Kanton Bern `ADMRAV` (RAV/AVA offices) |
| `kantonbern.admbiz_bizp` | `career_info_centre` | 8 | 1 | Kanton Bern `ADMBIZ` (BIZ career guidance centres) |
| `kantonbern.admeb_ebp` | `family_counselling` | 13 | 3 | Kanton Bern `ADMEB` (Erziehungsberatung) |
| `kantonbern.admrsb_rsb` | `conciliation_office` | 5 | 1 | Kanton Bern `ADMRSB` (Schlichtungsbehörden) |
| `kantonbern.admbaka_bads` | `debt_collection_office` | 8 | 1 | Kanton Bern `ADMBAKA` (Betreibungsamt service points) |
| `kantonbern.admbaka_kads` | `bankruptcy_office` | 5 | 1 | Kanton Bern `ADMBAKA` (Konkursamt service points) |
| `kantonbern.admrsta_rsta` | `district_office` | 10 | 1 | Kanton Bern `ADMRSTA` (Regierungsstatthalterämter) |
| `kantonbern.admkesb_kreis` | `child_adult_protection` | 11 | 1 | Kanton Bern `ADMKESB` |
| `kantonbern.nffs_sozd` | `social_services_area` | 64 | 4 | Kanton Bern `NFFS` (Sozialdienst service areas) |
| `kantonbern.admgde_gdedat` | `municipal_office` | 330 | 8 | Kanton Bern `ADMGDE` (Gemeindeverwaltungen, where you register on arrival) |
| **total** | | **1,686** | **283** | |

Kanton Bern files come from `https://geofiles.be.ch/geoportal/pub/download/<CODE>/<code>.gpkg.zip` (GeoPackage, LV95).
To find a code, search the opendata.swiss organisation `amt-fuer-geoinformation-des-kantons-bern` (the CKAN resource URLs
contain it).

## Licences

- Kanton Bern: opendata.swiss `terms_open`; `terms_of_use_de.pdf` ships inside each zip.
- BABS and SEM (geo.admin.ch): federal geodata, free to use with source attribution
  (https://www.geo.admin.ch/en/general-terms-of-use-fsdi). The BABS STAC collection says `license: "proprietary"`,
  which on geo.admin.ch means "see the FSDI terms", not "closed".
- Geocoding uses the geo.admin.ch SearchServer (official building address register), under the same terms.

## Privacy

Organisations only. Two filters keep private people out:

- **KIBEAGS:** only `art_code = "kita"`. The 20 `tfo` rows (Tagesfamilienorganisationen, day-family agencies) are
  dropped, because several give a mobile number, a personal e-mail and what looks like a coordinator's home address.
  The dataset has no individual day families.
- **RELIGION:** 44 sites have `kontakt = "privat"`, meaning the contact is a private person (mobile number, personal
  e-mail, "c/o <name>" address). For these, `phone`, `email` and the raw `telefon`, `email`, `adresse_k` and
  `plz_ort_k` are removed. The site address and website stay.

## Quirks

- **Region tables.** ADMRSB, ADMBAKA, ADMRSTA, ADMKESB and ADMGDE store each office as its region polygon plus an
  address in text. The point is that address, geocoded (`props.point_is = "geocoded office address"`, `props.geocode`
  holds the query and the matched address). A match must be in canton BE and have either our postcode plus the same
  house number or street word, or the same house number in the same town. The second rule is needed because many
  offices publish a Postfach postcode (3071 Ostermundigen, 2501 Biel, 3602 Thun). Some matches are close but not exact:
  Eckweg 8D matches Eckweg 8, and "Amthaus, Frutigen" matches Amthausgasse 1.
  Not geocoded, so missing (listed in `sources[].note`): Gemeindeverwaltung Hagneck (no street), Rebévelier,
  Schangnau, and Tramelan ("Hôtel de Ville", no number).
- **NFFS has no office addresses.** It only gives service areas (name and municipalities). The point is the centre of
  the area's bounding box (`props.point_is` says so), and the category is `social_services_area`, not an office. Do
  not show it as a door to walk to.
- **Duplicates across tables.** ADMRAV, ADMBIZ and ADMEB each ship a polygon table and a point table with the same
  offices. Only the point tables (`*_ravzp`, `*_bizp`, `*_ebp`) are used. `admbaka_baka_vw` (head offices) is skipped
  because those offices are already in the Betreibungsamt and Konkursamt service-point tables. Several offices share
  a building (Poststrasse 25 Ostermundigen houses the Betreibungsamt, Konkursamt and Regierungsstatthalteramt), so
  their points coincide.
- **Bern's municipal office** is listed in ADMGDE as "Stadtkanzlei Bern, Junkerngasse 47", which is the city
  chancellery, not the residents' office. For Stadt Bern counters (Einwohnerdienste, Migration), use the
  `stadtbern.Stadtverwaltungen` layer in `data/official-places.json`.
- **SEM points** are sites from the federal sectoral plan, with their planning status in `description`. They are not
  visitor addresses. All federal records also include planned or rebuilt sites (`Anpassung/Umnutzung`, `Neubau`). The
  canton filter checks each point against `ch.swisstopo.swissboundaries3d-kanton-flaeche.fill`.
- **Not found as open data:** Zivilstandsämter, Steuerverwaltung offices, Mütter- und Väterberatung, cantonal asylum
  accommodation, and the Migrationsdienst have no canton or federal location layer. The KJSA layer (child and youth
  welfare providers) is skipped: it is specialised, and its ambulant providers include sole traders with mobile
  numbers.
