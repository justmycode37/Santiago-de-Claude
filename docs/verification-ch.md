# Verification of the Switzerland-wide basic-needs data (21 Nov 2026)

Seeded random sample (seed 4242): 20 toilets (stratified by paid value), 8 OSM amenities, 8 official records, 10 help-network items and all 10 hotlines. Result: 2 FAIL (Lausanne Vidy toilet marked paid but the city lists it free; stale Geneva post office). Fixed after review: Zürich WCs with 'Zufahrt erschwert' are now wheelchair=limited; the Tox Info 145 cost is null (no source said free).

# Verification of 36 Swiss-wide records (vs-ch-locations.json)

Checked on 2026-11-21. Raw evidence is in `vc-raw.json`, and the scripts are `vc.mjs` and `vc-ov.mjs`, all in this scratchpad.

**Method.** Each record was checked three ways:

1. **Upstream re-query.** OSM API 0.6, Stadt Zürich WFS (Zueri_WC, Brunnen), data.bs.ch 100031/100019, data.zg.ch 13/105, daten.stadt.sg.ch, the Stadt Luzern GPKGs, the Biel JSON, SITG ArcGIS, geo.admin BAZL, and the geo.admin BAV stops for ATLAS station positions.
2. **Second, independent check.**
   - Second source: the GWR building at the point, swisstopo SearchServer geocoding of the stated address, other datasets within 80 m (all of `data/ch`), Overpass for the area around the point, and the operator or city pages.
   - Paid field: the Lausanne city WC map (KML), the SBB toilet pages, and the Winterthur WC concept.
3. **Verdict per record.** The overall verdict is the worse of *location* and (for toilets) *paid*.

**Verdict rules.**
- **PASS**: independent evidence within 50 m and the facts match.
- **WARN**: 50–150 m, weak evidence, or unverifiable.
- **FAIL**: more than 150 m, wrong, gone, or a wrong paid value with a clear source.

## Result

| file | PASS | WARN | FAIL |
|---|---|---|---|
| toilets-ch.json (20) | 10 | 9 | 1 |
| osm-*.json (8) | 6 | 2 | 0 |
| official-ch.json (8) | 6 | 1 | 1 |
| **total (36)** | **22** | **12** | **2** |

**Source fidelity is perfect.** All 36 stored coordinates match their upstream source:
- OSM records: 0–0.1 m.
- City datasets: ≤1.2 m.
- BAZL: 1.6 m from the LV95 ARP.
- ATLAS station centres: 0 m against the geo.admin BAV stops.

The stored attributes also equal the source. No record is gone upstream. The problems are in the sources themselves, in the merge, and in derived fields.

### Paid field (toilets, n = 20 + 1 ATLAS record in official-ch)

| stored `paid` | n | confirmed by independent source | contradicted | unverifiable |
|---|---|---|---|---|
| free | 5 | 1 (#0 bs.ch "kostenlos" + OSM fee=no) | 0 | 4 (OSM fee=no only) |
| paid | 5 | 1 (#8 Arth-Goldau; SBB: WC-Center CHF 1.50 = stored price) | **1 (#9 Lausanne: city map says "Gratuit")** | 3 (#5 conflicting, #6 weak, #7 none) |
| mixed | 3 | 3 (ZüriWC: free multifunction WC + CHF 1 wheelchair WC) | 0 | 0 |
| null (unknown) | 7 | n/a | 0 | 7 (#15 is likely free: an OSM node 5 m away says fee=no) |

- **Agreement where any independent source exists: 5/6 (83%).**
  - free: 1/1.
  - paid: 1/2.
  - mixed: 3/3.
- **Unverifiable: 7 of the 13 non-null values.**
- "mixed" is used correctly: all three are sites with a free WC and a paid WC.

## Per-record table

| # | file / id | location evidence | paid / attributes | verdict |
|---|---|---|---|---|
| 0 | toilets / node/2398188047 Basel Bäumlihofstr. 151 | OSM 0 m; bs.wc/9 1.2 m; GWR "Unterstand" Bäumlihofstr. 151 at 2 m | free = bs.wc "kostenlos" = OSM fee=no. Wheelchair yes (bs.wc typ rollstuhlgängig; OSM says no, noted) | PASS |
| 1 | toilets / node/354536218 Uster Seestr. 1 | OSM 0 m; derived address = GWR building at 24 m, which is a **hotel** (gklas 1211). No public-WC source; access null | free: OSM only | WARN |
| 2 | toilets / node/4718543349 Friedhof Baar | OSM 0 m; GWR cemetery chapel (gklas 1272) "Altgasse 11.1" at 7 m | free: OSM only | WARN (paid unverified) |
| 3 | toilets / node/12772951681 SG (Artilleriewerk Schollberg) | OSM 0 m; no GWR building within ~37 m; **second OSM toilet node/13399576334 12 m away** (separate item) | free: OSM only | WARN |
| 4 | toilets / node/3445437608 Trubschachen (Kambly Erlebniswelt) | OSM 0 m; Kambly building 17 m; official kantonbern.aed "Kambly Erlebniswelt" 15 m | free: OSM only | WARN (paid unverified) |
| 5 | toilets / node/1298772399 Oberwinterthur station | OSM 0 m; GWR station building (gklas 1241) at 13 m; SBB waiting room 11 m | paid: OSM fee=yes. Winterthur lists "Bahnhof Oberwinterthur" among its city WCs, and city WCs are free, but the neighbourhood stations' WCs were handed to SBB (SBB module WC CHF 1). Unresolved | WARN |
| 6 | toilets / node/1315431066 Raststätte Gunzgen Süd | OSM 0 m; GWR "Restaurant Windrose" 15 m; Marché 9 m | paid (Marché indoor WC) is plausible, but **free OSM toilet block way/479570258 is 48 m away**, so the site is arguably mixed. No price source found | WARN |
| 7 | toilets / node/9734478039 Wilderswil Gsteigstr. 6 | OSM 0.1 m; Shell station shop (GWR gklas 1230) at 9 m | paid: OSM fee=yes only | WARN (paid unverified) |
| 8 | toilets / node/1397405341 WC Bahnhof Arth-Goldau | OSM 0.1 m; ATLAS station 10 m (BAV stop = ATLAS, 0 m); GWR Bahnhofstr. 1 at 7 m | paid CHF 1.50 = SBB WC-Center price; OSM check_date 2026-08-30. Wheelchair yes = ATLAS YES | PASS |
| 9 | toilets / way/339564981 Lausanne Promenade de Vidy | OSM 0 m; **Lausanne city WC map "Toilettes Parc Bourget" 4 m**; GWR Promenade de Vidy 1.1 at 0.1 m | **stored paid; the city says "statut: Gratuit"**. The city also says handicap Oui and eurokey Oui, but the record has wheelchair/eurokey null | **FAIL** |
| 10 | toilets / node/342466969 Klusplatz | OSM 0 m; zh.zueriwc/wcr058 3.3 m; GWR Witikonerstr. 2 at 0.2 m | mixed = city ("Behinderten-WC Fr. 1.-- oder Eurokey, Multifunktions-WC gratis"). Wheelchair yes from the city category, although the city field `hindernisfreiheit` = "0__" and OSM says no | PASS |
| 11 | toilets / node/5283725450 Stauffacher | OSM 0 m; wcr6098 1.4 m; GWR Lutherstr. 5 at 1.6 m | mixed = city ("Gebührenfrei. Behinderten WC Fr. 1.- oder Eurokey"). Address keeps the junk suffix "(erst.)" | PASS |
| 12 | toilets / node/4851815303 Artergut | OSM 0 m; wcr056 3.5 m; GWR Klosbachstr. 19 at 4.7 m | mixed = city. Wheelchair yes, but the city says "Zufahrt Rollstuhl wegen Kiesfläche erschwert" and `hindernisfreiheit` "0__", so "limited" would be more accurate | PASS |
| 13 | toilets / node/13993510731 Scuol Motta Naluns | OSM 0 m; GWR Motta Naluns 943 at 22 m (summit-station area, restaurant 27 m); another OSM toilet 46 m | null | PASS |
| 14 | toilets / node/440670659 Bad Ragaz | OSM 0 m; **GWR building named "WC-ANLAGE"** at 1.5 m; **duplicate OSM way/1253361121 1 m away** (separate item) | null | PASS |
| 15 | toilets / node/6915686591 Bern Manuelstr. 107 | OSM 0 m; GWR "Bus Haltestelle" at 6.7 m | null, but neighbour OSM node/539180396 5 m away is fee=no, wheelchair, Eurokey (separate item) | PASS |
| 16 | toilets / zg.stadtmobiliar 4476 Zug Alpenquai | upstream 0 m; GWR small building Alpenquai 1.1 at 1.5 m (next to the Schifflände pavilion) | null (no fee in source) | PASS |
| 17 | toilets / lu.wc Schulhaus Staffeln | upstream GPKG 0.6 m; GWR school complex (Obermättlistr. 42 "Betreuungshaus", 44 "Schulhaus") | null. Wheelchair no = HINDERNISFREI 0 | PASS |
| 18 | toilets / sg.wc/11 Burgweiher | export row 11 matches at 0 m, but the **source row has no name or address**; GWR "other building" (1278) at 24 m by the Burgweier pond. In the records API this WC is row 21, not 11 | null | WARN |
| 19 | toilets / atlas.toilet Allmend (WAB) | station centre 0 m from BAV stop; kantonbern.aed "Bahnhof WAB Allmend" 1 m; toilet position itself unknown (by design) | null. toilets_wheelchair no = ATLAS NO | WARN |
| 20 | osm-drinking_water / node/3157360415 Zürich Goldackerweg | OSM 0 m (unchanged since 2017); inside the Israelitischer Friedhof Agudas Achim; **no zh.brunnen record within 80 m** (city list excludes private fountains). Likely a private cemetery tap | – | WARN |
| 21 | osm-aed / node/13797870501 Biel MPS | OSM 0 m; GWR industrial building Chemin du Long-Champ 95 at 12 m (operator's address) | – | PASS |
| 22 | osm-pharmacy / node/3288706425 TopPharm Münchenstein | OSM 0 m; **bl.apotheken "Zollweiden Apotheke AG" 0 m** (website matches /zollweiden); GWR Baselstr. 71 at 18 m | – | PASS |
| 23 | osm-hospital / way/37277021 Klinik Waldhaus Chur | OSM 0.1 m (bbox centre); GWR campus building 22 m | derived address "Loëstrasse 224" is "Haus P (Personalhaus)"; the clinic's address Loëstrasse 220 is ~90 m away | WARN (address) |
| 24 | osm-shower / node/8307144212 Hofen SH | OSM 0 m; GWR "Schwimmbad" at 19 m; duplicate OSM shower 3 m | – | PASS |
| 25 | osm-supermarket / node/13960858595 Migros Acacias | OSM 0 m; **ge.aed "Migros Carouge - Acasias" 10 m**; GWR Route des Acacias 18 at 10 m (status "under construction" in GWR) | – | PASS |
| 26 | osm-library / node/5867564893 Cadenazzo | OSM 0 m; GWR "Struttura scolastica" Via Prati Grandi 2 at 22 m | – | PASS |
| 27 | osm-police / node/5456977049 Schwanden GL | OSM 0 m; **GWR building named "Polizei"** Sernftalstr. 2 at 14 m | – | PASS |
| 28 | official / bazl.spitallandeplaetze/2141 La Lignère | geo.admin feature 1.6 m from stored point; OSM "Clinique La Lignière" 89 m, hospital buildings 82 m; no OSM helipad found | name is misspelled upstream ("Lignère"). It is a rehabilitation clinic, so a poor proxy for an emergency hospital | WARN |
| 29 | official / biel.brunnen/498 | upstream LV95 0.8 m; GWR Chemin du Clos 22 (Kinderspital) at 9 m; Kantonsspital Ambulatorium 41 m | potable 0 → fountain, correct | PASS |
| 30 | official / atlas.toilet Wald ZH | station centre 0 m from BAV stop; **OSM toilet node/13991662844 3 m** (paid, wheelchair) | wheelchair yes = OSM | PASS |
| 31 | official / bs.aed/519 | upstream 0 m; **OSM AED 14 m**; GWR Gartenstr. 69 at 9 m | 24/365 = source | PASS |
| 32 | official / ge.poste/66 "Petit-Lancy 2 Place des Ormeaux" | SITG 0 m, GWR Place des Ormeaux 1 at 0.5 m; **no OSM post office within 120 m; Swiss Post lists "Petit-Lancy 2 Les Marbriers" at Chemin Daniel-Ihly 10, ~750 m away** | the office has moved; SITG layer is stale | **FAIL** |
| 33 | official / lu.bibliothek Stadtbibliothek | GPKG 0.6 m; GWR Löwenplatz 10 (Bourbaki building) at 21 m; OSM AED "Bourbaki Panorama" 9 m | – | PASS |
| 34 | official / zh.brunnen/293 Bäckeranlage | WFS 0 m; **OSM drinking_water 0 m**; ZüriWC mobile WC Bäckeranlage 8 m | Quellwasser → drinking_water, correct | PASS |
| 35 | official / ge.pharmacies/23 Pharmacie Bleue | SITG 0 m; **OSM "Pharmacie Bleue" 14 m**; GWR Route de Thonon 60b at 0 m | address contains ", 1222 Vésenaz" | PASS |

## Systematic issues and fixes

1. **OSM `fee` overrides missing city data, and is wrong in Lausanne (#9).** Lausanne publishes all 37 city WCs on a Google My Maps map. Each entry has `statut` (Gratuit, Gratuit/payant, …), `handicap` and `eurokey`, and the map can be exported as KML: `https://www.google.com/maps/d/kml?mid=1729ii2aNgl_iZjCDe0vGCVgBqfVyqjw_&forcekml=1`.
   - **Fix:** add a `vd.lausanne.wc` source in `tools/build-official-ch.mts` and map Gratuit → free, Gratuit/payant → mixed. Its "official wins" merge in `tools/build-toilets-ch.mts` already handles the rest.
   - The licence is unstated, so ask the Service de la propreté urbaine. Otherwise use the map only as a verification list.
2. **OSM↔OSM near-duplicates are never merged** in `tools/build-toilets-ch.mts`. Matching is only city↔OSM, ATLAS↔OSM and Nette↔OSM.
   - In the sample, 3 of 16 OSM toilets have a second OSM toilet within 12 m (#3 12 m, #14 node+way 1 m, #15 5 m). The shower in #24 has one at 3 m.
   - Across the file there are at least 333 toilet pairs under 15 m (lower bound out of 7,139 items).
   - **Fix:** add an OSM self-merge pass.
     - Merge a node into a way within 10 m, or two nodes within 5 m when their tags don't conflict.
     - When one is free and the other paid, or one is a wheelchair-only cabin, combine them into one item with `paid` = mixed.
     - Otherwise, write `possible_duplicate_of` into `notes`.
3. **Zürich wheelchair flag is too optimistic** (`zhWc()` in `tools/build-official-ch.mts`). `wheelchair: "yes"` comes from `kategorie` "(rollstuhlgängig)" even when `hindernisfreiheit` = "0__" or the text says "Zufahrt Rollstuhl … erschwert" (#12).
   - **Fix:** set "limited" when `kommentar` or `infrastruktur` matches /erschwert|eingeschränkt/.
4. **Address clean-up in the official sources** (`tools/build-official-ch.mts`).
   - `zhPoi()`: strip "(erst.)" from `adresse` (12 items).
   - `ge.pharmacies` mapper: split "Route de Thonon 60B, 1222 Vésenaz" into address, postcode and city. All 132 of 132 affected; 149 items CH-wide have ", NNNN City" in `address`.
5. **Derived GWR addresses with sub-numbers** (`tools/enrich-addresses-ch.mts`). 14,448 of 66,628 derived addresses (21.7%) end in a register sub-number, e.g. "Altgasse 11.1", "Alpenquai 1.1", "Burgweiherweg 23.02", "Bahnhofstrasse 12a.1".
   - These are real register entries for outbuildings and they geocode, but people don't use them.
   - **Fix:** keep `address` but add the parent number (strip `\.\d+$`) as the display address, or prefer a main-number entrance within the same 25 m.
   - For OSM ways (hospital campus #23), derive from the way's own `addr:*` or from the main building's address rather than the entrance nearest the centroid.
6. **Stale SITG post-office layer** (#32). `GEO_POSTE_PT` still has "Petit-Lancy 2 Place des Ormeaux", but Swiss Post has moved it to Chemin Daniel-Ihly 10.
   - **Fix:** in `tools/build-official-ch.mts`, replace `ge.poste` with Swiss Post's own open data for locations and opening hours, which is maintained and covers all of Switzerland. Or drop `ge.poste` and rely on OSM.
7. **`sg.wc` ids are row numbers in the export order.** This is already a `shortcut:`, and it is confirmed fragile: the ODS records API returns the same WC as row 21, not 11. One of the 33 rows has no `bezeichnun`.
   - **Fix:** build the id from rounded LV95 coordinates (e.g. `sg.wc/2746…_1254…`).
8. **The BAZL helipad as a hospital proxy** includes non-emergency clinics (La Lignière is a rehabilitation clinic), and the upstream name is misspelled. Document this in `docs/data-ch-official.md`, or join helipads to hospitals that have an emergency department before using them as "emergency hospital".
9. **No source for the price of station and rest-stop toilets.** SBB publishes national prices: WC-Center/Hygienecenter CHF 1.50, module WC CHF 1.00. `fromOfficial()` in `tools/build-toilets-ch.mts` could set `paid`/`price` for ATLAS toilets of operator SBB when OSM is silent. That would only be a heuristic, and must be noted as such.

## Not checked or weak

- 7 of the 13 non-null paid values have only OSM as a source. Searches found no city WC data for Uster, Baar, Trubschachen, Wilderswil, St. Gallen or Zug.
- The TCS 2024 rest-stop report (PDF) could not be text-extracted here, because there is no PDF tool.
- No photos or reviews were used.

# Verification: help-ch.json sample (10 items + 10 hotlines)

Checked 2026-11-21. Each address was geocoded with the swisstopo SearchServer; "dist" is the distance from the stored lat/lon to the swisstopo result.
The Tischlein entries were compared field by field against the live feed `kkonlinerestapi.tischlein.ch/abgabestelle` (181 outlets).

## Places

| id | field | stored | found | source URL | verdict | note |
|---|---|---|---|---|---|---|
| luzern-gassechuchi | address / geo | Geissensteinring 24, 6005 Luzern | same; dist 0 m | https://www.tragwerk-luzern.ch/angebote/gassechuchi_ka | PASS | |
| luzern-gassechuchi | phone | 041 252 26 40 | 041 252 26 40 (K+A: 041 252 26 50) | same | PASS | |
| luzern-gassechuchi | hours | Mon,Wed-Fri 09:30-17:00; Tue 10:30-17:00; Sat-Sun 10:00-16:45; lunch 12:00-13:30 | identical (Tue: back yard from 10:00) | same | PASS | |
| luzern-gassechuchi | cost / who_for | lunch CHF 5; addiction & poverty | "5 Franken"; "sucht- und armutsbetroffene Menschen" | same | PASS | |
| luzern-gassechuchi | website | null | tragwerk-luzern.ch page exists | same | WARN | website could be filled with source_url. No second source found in a web search. |
| tdd-bern-st-marien | all | Wylerstrasse 26, 3014 Bern; Tue 15:00-16:00; no phone | feed rowid 173948 identical; dist 0 m | tdd feed | PASS | |
| tdd-bischofszell-tg | all | Alte Niederbürerstrasse 2, 9220; Mon 15-16; 071 422 52 04 | feed rowid 21678 identical; dist 0 m | tdd feed | PASS | |
| tdd-uster | all | Bahnstrasse 31, 8610; Tue 10-11; 044 940 12 43 | feed rowid 16174 identical (phone is `telefon_direkt`); dist 0 m | tdd feed | PASS | |
| tdd-immensee | all | Im Bethlehem 3, 6405; Wed 17-18 | feed rowid 167101 identical; dist 0 m | tdd feed | PASS | |
| tdd-siebnen | all | Fabrikstrasse 2a, 8854; Tue 14:30-15:30 | feed rowid 6629 identical; dist 0 m | tdd feed | PASS | |
| tdd-frick | all | Mühlerain 10, 5070; Mon 14:30-15:30 | feed rowid 12032 identical; dist 0 m | tdd feed | PASS | |
| tdd-* (6) | who_for / cost / notes | card from social agency, 1 yr; CHF 1; own bag; one point | card from a Sozialfachstelle after a financial-need check, valid 1 yr, per person/household; "einen symbolischen Franken" per pickup; bring cool and carrier bags; one pickup a week at the chosen point | https://www.tischlein.ch/de/lebensmittel-erhalten | PASS | The CHF 1 is now confirmed on tischlein.ch itself, so the "not stated in the feed" caveat can cite this page instead. |
| frigo-1674 | name / address / geo | Kalkbreite, Kalkbreitestrasse 2, 8003 | listed (ID 1674); org pin 47.374369, 8.521142, about 4 m off; swisstopo dist 0 m | https://www.madamefrigo.ch/de/standorte/ | PASS | No hours on the org page, so null is correct. No independent second source checked. |
| nette-toilette-luzern-bacio-della-mamma | address | Seidenhofstrasse 5, 6003 | flyer: Seidenhofstrasse 5; swisstopo 6003, dist 0 m; MySwitzerland: 6002 (AMERON Hotel Flora) | flyer PDF (source_url); https://www.myswitzerland.com/en/experiences/food-wine/restaurant/ameron-luzern-hotel-flora-restaurant-bacio-della-mamma/ | PASS | 6002 is the hotel's postal code; 6003 is the building-register code. Both work. |
| nette-toilette-luzern-bacio-della-mamma | hours | daily 08:00-22:00 | flyer: "täglich 08.00-22.00 Uhr"; MySwitzerland: Sun-Thu 07:00-22:00, Fri-Sat until 23:00 | as above | WARN | Matches the 2025 flyer, but a second source gives different hours. The restaurant is inside the AMERON Hotel Flora (worth adding to the name or notes). Wheelchair icon not checkable (no text in the PDF). |
| frigo-3931 | address / geo | Genossenschaft bainviver, Planaterrastrasse 11, 7000 Chur | listed (ID 3931); org address block: Planaterrastrasse 11; org map pin: "Hofgraben 11" at 46.850825, 9.535072 (35 m off); swisstopo Planaterrastrasse 11 dist 0 m | https://www.madamefrigo.ch/de/standorte/ ; https://www.gr.ch/DE/institutionen/verwaltung/diem/hba/aktuelles/Documents/190829_Nutzungskonzept_Planaterra_11_Igsennhof_bainviver.pdf | PASS | The second source (canton GR, 2019) ties bainviver to the Planaterra 11 project. The Hofgraben pin on the org's map is the org's own mismatch. The stored value is the better one. |

## Hotlines

| id | field | stored | found | source URL | verdict | note |
|---|---|---|---|---|---|---|
| hotline-112 | number / purpose | 112, general, handled by police | TG card: "112 Allgemeiner Europäischer Notruf"; ch.ch: connects to the police alarm centre | stored PDF; https://www.ch.ch/de/brand | PASS | |
| hotline-117 | number | 117 Police | "117 Polizei" | stored PDF | PASS | |
| hotline-118 | number | 118 Fire | "118 Feuerwehr" | stored PDF | PASS | |
| hotline-144 | number | 144 Ambulance | "144 Sanität" | stored PDF | PASS | |
| hotline-145 | number / hours | 145 poisoning, 24/7 | "Vergiftungsnotruf 145 (24h)"; answered by physicians (Tox Merkblatt 2024) | https://toxinfo.ch/notruf-145 | PASS | |
| hotline-145 | cost | "free" | not stated on toxinfo.ch home or notruf-145 page | same | WARN | Unconfirmed. Set it to null or find a source for it. |
| hotline-1414 | number / purpose | 1414 air rescue; hours null | "medizinische Hilfe aus der Luft … 1414"; "rund um die Uhr"; from abroad +41 333 333 333 | https://www.rega.ch/alarm-1414 | PASS | hours could be "24/7"; the abroad number could go in notes. |
| hotline-143 | number / purpose / notes | 143; phone, chat, mail; English 0800 143 000 18:00-23:00 | same; "Call 0800 143 000 from 6-11 pm"; no cost or hours on the page | https://www.143.ch/ | PASS | |
| hotline-147 | all | phone 24/7, WhatsApp 07:30-22:00, free, not on bill, email, peer chat Mon-Thu 19-22 | all identical verbatim | https://www.147.ch/de/ | PASS | |
| hotline-142 | all | violence victims, not an emergency number, free and anonymous, nationwide since 1 May 2026 | identical; year 2026 confirmed by the BJ and Beobachter | https://www.opferhilfe-schweiz.ch/de/ ; https://www.bj.admin.ch/de/opferhilfe | PASS | |
| hotline-0800222210 | all | free; Mon-Fri 10:30-20:00, Sat-Sun 15:00-20:00 | "0800 22 22 10 (appel gratuit)"; same hours | stored geneve.ch page | PASS | The page calls it the intercommunal system ("dispositif intercommunal"). "Ville de Genève" is slightly narrow. |

## Safety
- No domestic-violence shelter in the sample. A keyword scan of all 543 entries (Frauenhaus / Gewalt / violence / Schutzhaus / refuge) found none.
- No private person's data: all phone numbers belong to organisations or churches, and there are no named individuals.

## Summary
- Rows: 25. Items: PASS 9, WARN 1 (Bacio della Mamma, hours). Hotlines: PASS 10 overall, with 1 field-level WARN (145 cost).
- Field-level WARNs: 3 (Gassechuchi website null, Bacio hours, 145 cost "free"). FAIL: 0.
- Systematic issues:
  1. Coordinates are swisstopo address points (dist 0 m everywhere). That is good, but it means an operator's map pin can disagree with the address, as with frigo-3931 (Hofgraben pin).
  2. Values were sometimes filled in without a source: 145 cost "free". The docs say cost is null when unstated, but this one breaks that rule.
  3. The Nette Toilette flyers (2024/25) are the only source for venue hours. The venues' own current hours can differ, so "medium" confidence is right.
  4. Fields left empty that the source does give: Gassechuchi website, 1414 hours "24/7".
