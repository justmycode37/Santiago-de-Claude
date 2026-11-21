# Official (non-OSM) amenity data for Switzerland: `data/ch/official-ch.json`

Rebuild (about 30 s, Node 24, no npm deps; needs `data/raw/actual-date-toilet.csv` and `data/raw/service-point.csv` from `tools/fetch-raw.sh`):

```
node tools/build-official-ch.mts [data/ch/official-ch.json]
```

The file holds official open data that complements and cross-checks OSM (`data/ch/osm-*.json`). If a source fails, it shows up in `sources` with `fetched_ok:false` and an `error`, and the build carries on. The build has self-checks:

- ids are unique;
- every point lies inside CH (lat 45.8–47.9, lon 5.9–10.6);
- `paid` is set only on toilets and showers;
- the fee parser passes its unit cases;
- the LV95→WGS84 formula is checked against 2,500 points published in both systems (ATLAS, Kanton Bern AED). The worst error is 2.6 m;
- the file must stay under 40 MB. It is 8.9 MB now, so it is not split.

## Shape

```
{ generated, sources: [{ key, name, url, licence, count, fetched_ok, error? }],
  items: [{ id: "<source>/<native id>", source, category, lat, lon (6 dp), name, address, postcode, city, canton,
            opening_hours, fee, paid, price, wheelchair, phone, website, props }] }
```

- `wheelchair` is normalised to `yes | limited | no | null`. The raw source value stays in `props`.
- `fee` is the raw fee text. `paid` is `free | paid | null` and `price` is the amount as written (e.g. `Fr. 1.--`). Both are set only for `toilets` and `shower`, and only when the source states a fee. `free` means at least one WC at the site can be used without paying, even if another cabin or time slot costs money. `price` then names that charge, for example Zürich "Behinderten-WC Fr. 1.-- oder Eurokey, Multifunktions-WC gratis". "Free only with Eurokey" and "free pissoir only" do not count as free.
- `props` is the source record, trimmed:
  - blank, `n.a.` and `-` values are removed;
  - strings are cut at 300 characters;
  - geometry duplicates are removed;
  - private data and secrets are always removed: person names (`vorname`, `name` where it is a person, `name_verantw_person`), `mobile`, `editor` (staff login), Geneva AED box unlock codes and contact phones, and Kanton Bern AED host phones.

Categories in this build: toilets 1103, shower 16, drinking_water 1253, fountain 504, aed 2711, hospital 720, hospital_helipad 125, emergency_department 5, emergency_meeting_point 2944, wifi 73, ticket_machine 1347, waiting_room 938, pharmacy 180, post_office 70, library 2. Total: 11,991 items.

`drinking_water` means the source says the water is drinkable. `fountain` means it is unknown or not drinkable.

## Sources (count = items in this build)

Licence keys: **open** is [opendata.swiss terms_open](https://opendata.swiss/terms-of-use#terms_open), **by** is terms_by (cite the source), **by_ask** is terms_by_ask (commercial use needs the publisher's permission), and **geo.admin** is the [FSDI terms](https://www.geo.admin.ch/en/general-terms-of-use-fsdi).

| key | what | URL | licence | count | quirks |
|---|---|---|---|---|---|
| atlas.toilet | ATLAS station toilets, all of CH | [toilet-v2](https://opentransportdata.swiss/de/dataset/toilet-v2) joined to service-point (local CSVs) | opentransportdata.swiss ToU | 617 | Only versions valid today are kept, for both toilets and service points. Rows saying "Keine Toiletten verfügbar" are dropped. The position is the **station centre**. There is no fee field, so `paid` is null. `wheelchairToilet` maps YES→yes, PARTIALLY→limited, NO→no, NOT_APPLICABLE→null. |
| zh.zueriwc | Stadt Zürich Züri WC (fixed + mobile) | WFS `ogd.stadt-zuerich.ch/wfs/geoportal/Zueri_WC`, layers `poi_zueriwc_{,rs_,mobil_,mobil_rs_}view` | open | 139 | The CKAN "JSON" download links return an HTML SPA, so the build uses the WFS with `outputFormat=GeoJSON&srsName=EPSG:4326`. Wheelchair comes from `kategorie`. The fee comes from `gebuehren`. Mobile WCs have no fee text. |
| bs.wc | Basel-Stadt Sanitäre Anlagen | [data.bs.ch 100031](https://data.bs.ch/explore/dataset/100031/) | CC BY | 155 (139 toilets + 16 showers) | `typ=Dusche` becomes **shower**. Closed rows (`status=geschlossen`) are dropped. Seasonally closed rows are kept, with a note in `opening_hours`. `gebuehr` is kostenlos or kostenpflichtig. Pissoirs get wheelchair=no. |
| ge.wc | Ville de Genève WC publics | SITG `VDG_WC_PUBLIC` ArcGIS REST | open | 78 | Wheelchair is yes when `USAGER` lists "Handicapés". Only one record states a fee. |
| lu.wc | Stadt Luzern WC-Anlagen | `map.stadtluzern.ch/.../toilette_gpkg.zip` | open | 60 | GPKG in LV95. `IN_BETRIEB=1` only. Includes "Nette Toilette" restaurants (`ART_resolved`). There is no fee field. The dataset was last updated in 2022. |
| sg.wc | Stadt St.Gallen POI "Öffentliche WC" | [daten.stadt.sg.ch points-of-interest-](https://daten.stadt.sg.ch/explore/dataset/points-of-interest-/) | CC BY | 33 | Names only: no address, wheelchair or fee data (`iv_grad` is empty). There is no id, so ids are row numbers. |
| zg.stadtmobiliar | Stadt Zug street furniture: WC-Anlagen (37) + Wasserzapfstellen und Brunnen (90) | `data.zg.ch/store/13/resource/105` | by | 127 | Only a category and an inventory number, with no attributes. Water points are `fountain` because potability is not stated. |
| zh.brunnen | Stadt Zürich Wasserversorgung Brunnen | WFS `.../Brunnen`, layer `wvz_brunnen` | open | 1030 | `art=privat` is dropped. Züriwasser and Quellwasser are `drinking_water`; other water sources are `fountain`. `abgestellt=ja` (for example the winter shut-off) goes into `opening_hours`. `foto` is dropped because it points to an intranet host. |
| bs.brunnen | Basel Bade-, Trinkwasser- und Zierbrunnen | [data.bs.ch 100008](https://data.bs.ch/explore/dataset/100008/) | **by_ask** | 305 | There is no potable flag and no id. The data mixes drinking fountains, decorative fountains and paddling pools, so everything is `fountain`. Ids are row numbers. |
| sg.brunnen | St.Gallen Brunnenkataster | [daten.stadt.sg.ch brunnenkataster](https://daten.stadt.sg.ch/explore/dataset/brunnenkataster/) | CC BY | 110 | `trinkwasse=Ja` means `drinking_water`. |
| biel.brunnen | Biel/Bienne Brunnen / Fontaines | `sig.biel-bienne.ch/datastore/E322_Brunnen-Fontaines/e322_brunnen.json` | open | 222 | GeoJSON in LV95, wrapped as `{brunnen: FC}`. `potable=1` means `drinking_water`. `gourde` (bottle-fillable) is kept in props. |
| kantonbern.aed | Kanton Bern AED-Standorte, whole canton | `geofiles.be.ch/.../AEDSTO/aedsto.gpkg.zip` | open | 1906 | `telefon` is dropped. |
| bs.aed | Basel-Stadt Defibrillatoren | [data.bs.ch 100019](https://data.bs.ch/explore/dataset/100019/) | CC BY | 235 | |
| ge.aed | Canton de Genève défibrillateurs en libre accès | SITG `DEAS_144_DEFIBRILLATEURS` | open | 570 | The **box unlock codes** and contact phones in the source are dropped. `H24=OUI` becomes `opening_hours: 24/7`. |
| so.spitalstandorte | Hospital and clinic sites, **all cantons** (Kanton Solothurn reachability analysis, Nov 2023) | `files.geo.so.ch/ch.so.gesa.leistungserbringerstandorte_erreichbarkeitsanalyse/...gpkg.zip` | open | 447 | The best national hospital point list found (276 institutions). It has no emergency flag. `leistungen` is ambulant, stationaer or ambulant_stationaer. |
| bazl.spitallandeplaetze | BAZL hospital helipads, all CH | geo.admin identify `ch.bazl.spitallandeplaetze` | geo.admin | 125 | Category `hospital_helipad`, used as a **proxy for hospitals with emergency/trauma capability**. The point is the helipad, not the entrance. FL is dropped. |
| kantonbern.spital | Kanton Bern Spitäler und Kliniken, whole canton | `geofiles.be.ch/.../SPITAL/spital.gpkg.zip` | open | 72 | `akut`/`geburt`/`psychklin`/`rehaklin` flags, summarised in `props.types`. |
| zh.spital | Stadt Zürich Spital POIs | WFS `.../Spital` | open | 148 | One row per department, not per hospital. `hindernisfreiheit` starting with `1_` means wheelchair=yes. |
| zh.spitalnotaufnahme | Stadt Zürich emergency departments | WFS `.../Spitalnotaufnahme` | open | 5 | Category `emergency_department`. |
| bs.spital | Basel-Stadt Spitäler | `api.geo.bs.ch/stac/v1/download/SPTL/latest/geojson` (zip64) | by | 13 | `props.emergency_department` = `Notfallstation`. |
| ge.hopitaux | Canton de Genève hôpitaux et cliniques | SITG `DAS_HOPITAUX_CLINIQUES` | open | 40 | |
| babs.notfalltreffpunkte | BABS emergency meeting points, all cantons | STAC `ch.babs.notfalltreffpunkte` | geo.admin | 2944 | LV95. FL (13) and DE (1) are dropped. AI has no entries. |
| sbb.wifistation | SBB Wifi@Station | data.sbb.ch `wifistation` | data.sbb.ch licence | 73 | 6 rows have no geopos and are skipped. |
| sbb.billetautomat | Ticket machines | data.sbb.ch `billetautomat` | data.sbb.ch licence | 1347 | Repeated ids get a `#n` suffix. |
| sbb.haltestelle-wartehallen | Waiting rooms | data.sbb.ch `haltestelle-wartehallen` | opentransportdata.swiss | 938 | |
| bl.apotheken | Basel-Landschaft pharmacies with an operating licence | [data.bl.ch 10320](https://data.bl.ch/explore/dataset/10320/) | by | 48 | The responsible pharmacist's name is dropped. |
| ge.pharmacies | Geneva pharmacies that vaccinate | SITG `GEO_SANTE_VACCINATION_PHARM` | open | 132 | Only the subset of pharmacies that vaccinate. |
| ge.poste | Geneva post offices | SITG `GEO_POSTE_PT` | open | 70 | |
| lu.bibliothek | Stadt Luzern libraries | `map.stadtluzern.ch/.../citymaps_bibliothek_gpkg.zip` | open | 2 | |

### Toilets: free / paid / unknown

| source | free | paid | unknown |
|---|---|---|---|
| atlas.toilet | 0 | 0 | 617 |
| zh.zueriwc | 94 | 21 | 24 |
| bs.wc (toilets) | 134 | 5 | 0 |
| bs.wc (showers) | 16 | 0 | 0 |
| ge.wc | 1 | 0 | 77 |
| lu.wc, sg.wc, zg.stadtmobiliar | 0 | 0 | 60 / 33 / 37 |

## Checked and not used

- **Zentralschweiz AED** (`daten.geo.lu.ch` DEFIBRIL_DS_V2, 2,493 points) is an OSM export: every `STATION_ID` is `node/…`. It is not official data, and it is ODbL. The **Schwyz AED WFS** (`aed-standorte1`) links to the OSM copyright, so it is the same story. Both are left out because OSM is already covered.
- There is **no national open AED register**. First Responder and Swiss AED registries are not open data.
- **BAG Kennzahlen / hospital list** (`opendata.bagnet.ch`) returned HTTP 500 on 2026-11-21. It has no coordinates and is terms_by_ask, so `so.spitalstandorte` and the BAZL helipads cover hospitals instead. No federal geo.admin layer has hospitals with an emergency flag.
- **Swiss Post** has closed its open data portal, so there is no national post office list. Only Geneva (SITG) is included.
- **No official open toilet or fountain data was found** for Bern city, Winterthur (only a PDF WC concept), Lausanne (city map only, 37 WCs), Lugano or Geneva fountains (SITG has only historical "points d'eau").
- **Glarus Barrierefreiheit** (Rollstuhl-WC, 2021) is Shapefile only and was skipped.
- **Jura "institutions de soins"** is a Shapefile zip and was skipped.
- **Libraries**: no national open location dataset was found on opendata.swiss. Bibliosuisse was not checked further.

## Refresh notes

- The ATLAS CSVs are local, so run `tools/fetch-raw.sh` first for fresh toilets.
- `bs.brunnen` and `sg.wc` ids are row numbers and can shift between builds.
