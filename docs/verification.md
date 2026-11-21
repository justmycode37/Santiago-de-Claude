# Location verification of gathered POI data (21 Nov 2026)

Seeded random sample (seed 20261121): 48 from data/places.json (6 per group), 30 from data/amenities.json, 40 from data/official-places.json. Checked against independent sources (GWR building register via api3.geo.admin.ch, swisstopo SearchServer, upstream re-query, web, cross-dataset match).

# Verification of 48 sampled POIs from data/places.json (Bern)

Date: 2026-11-21. Sample: `sample-places.json` (6 per group, seeded).
Sources: **GWR** = swisstopo identify on `ch.bfs.gebaeude_wohnungs_register` (official building register, tolerance 10 px, nearest entrance listed); **GEO** = swisstopo SearchServer forward geocode; **WEB** = the item's own website; **WS** = web search (local.ch, insel.ch, bkd/police.be.ch, tierpark-bern.ch, boga.unibe.ch, parkinglist, etc.); **SM** = sharedmobility.ch federal station feed; **DEN** = official Denner store locator (denner.ch/de/filialen, 866 stores parsed); **ZEFIX** = Swiss commercial register; **OSM** = OSM API 0.6 live element.
OSM API check: all 48 elements still exist; every node's live coordinates equal ours (0 m), names unchanged. Distances are from our lat/lon to the independent address point.

| id | name | category | our lat/lon | evidence | independent address found | dist m | verdict | note |
|---|---|---|---|---|---|---|---|---|
| node/3108333829 | Il Ristorantino | restaurant | 46.95422, 7.43344 | WS (ISSI restaurant map), GWR, GEO | Gesellschaftsstrasse 49, 3012 Bern | 7 | PASS | source ~2019; no recent closure report found |
| node/13829258198 | Hot Momo | restaurant | 46.95783, 7.49317 | WEB, GWR | Bernstrasse 96b, 3072 Ostermundigen | 4 | PASS | |
| node/6277078905 | Stella | restaurant | 46.94886, 7.42449 | WS (Inselspital site plan), GWR | Wirtschaftsgebäude, Rosenbühlgasse 26 | 25 | PASS | Inselspital staff/visitor restaurant |
| node/2433655016 | Volver | restaurant | 46.94839, 7.45214 | WEB, GWR | Rathausplatz 8, 3011 Bern | 4 | PASS | |
| node/6631310086 | Paninoteca Adriana | fast_food | 46.95713, 7.43709 | WEB, GWR, GEO | Neubrückstrasse 65, 3012 Bern | 5 | PASS | OSM addr = official |
| node/12423233309 | Acai Attendant | cafe | 46.94988, 7.44080 | WEB, GWR | Bollwerk 21 / Aarbergergasse 63 | 9 | PASS | |
| node/2768222100 | Bären | hotel | 46.94752, 7.44315 | WEB, GWR, GEO | Schauplatzgasse 4, 3011 Bern | 8 | PASS | |
| node/11030205393 | Evi's Home | hotel | 46.96570, 7.45532 | WEB, GWR, GEO | Stauffacherstrasse 60, 3014 Bern | 32 | PASS | 60a at 11 m |
| node/3078036623 | Bellevue Palace | hotel | 46.94653, 7.44670 | GWR, GEO | Kochergasse 3/5, 3011 Bern | 21 | PASS | |
| node/6315317662 | B&K am Tavelweg | guest_house | 46.94702, 7.46285 | WEB, GWR | Tavelweg 30, 3006 Bern | 5 | PASS | |
| node/842038851 | Amante | hotel | 46.91408, 7.49985 | WEB, GWR, GEO | Flugplatzstrasse 57, 3123 Belp | 14 | PASS | **OSM addr wrong**: "Flughafenstrasse 57" does not exist; geocoding our address lands 2.1 km off |
| node/6806887790 | Pension HeDa | guest_house | 46.93875, 7.43267 | WS (local.ch), GWR | Mayweg 4, 3007 Bern | 5 | PASS | local.ch lists it as "BeWo Plus ... Pension HeDa" (Heim): may be supported living, not a tourist guesthouse |
| node/3182286254 | Denner | supermarket | 46.93495, 7.48946 | DEN, GWR, GEO, WS | none (nearest Denner: Wittigkofen) | 796 | **FAIL** | not in official Denner locator; building at point is Kranichweg 8 (matches OSM addr) but store likely closed |
| node/3469523939 | Fressnapf | pet | 46.93634, 7.41642 | GWR, WS (job ads "Köniz") | not found (point = Könizstrasse 151, Liebefeld) | - | WARN | brand branch in Köniz confirmed, exact address not |
| node/11218558271 | Piazza | kiosk | 46.94714, 7.42421 | WS (Inselspital site plan), GWR | Shop Piazza, Anna-Seiler-Haus, Freiburgstrasse 20 | 33 | PASS | |
| node/2295323923 | Haupt | books | 46.95107, 7.43617 | WEB, GWR, GEO | Falkenplatz 14, 3012 Bern | 5 | PASS | |
| node/8772367912 | lista office Bern | furniture | 46.93562, 7.41695 | WS (lista-office.com LO Bern), GWR | Könizstrasse 161, 3097 Liebefeld | 14 | PASS | |
| node/8045207018 | Nähatelier Vizlo | tailor | 46.94697, 7.44962 | GWR, WS, ZEFIX | none independent (OSM contact:addr Herrengasse 19 = GWR 3 m) | - | WARN | no web/registry footprint |
| node/9315415160 | Bildungs- und Kulturdirektion | government | 46.94047, 7.44073 | WS (bkd.be.ch docs), GWR | Sulgeneckstrasse 70, 3005 Bern | 17 | PASS | |
| node/13329760680 | Forschungsstelle Jeremias Gotthelf | research | 46.95442, 7.42963 | WEB, GWR | Muesmattstrasse 45, 3012 Bern | 12 | PASS | |
| node/11459791419 | Seepolizei Wohlensee | police | 46.96777, 7.37925 | WS (police.be.ch: base Hinterkappelen), GWR, GEO | Hinterkappelen (no street published) | - | WARN | OSM addr Schulstrasse 2 = GWR 5 m, but not independently confirmed |
| node/5720831969 | Sattler-Gelateria | bicycle_rental | 46.95473, 7.43339 | SM (velospot:1715) | station "Mittelstrasse - Bern" | 1 | PASS | official name differs (sponsor name in OSM) |
| relation/9150198 | Mobiliar | parking | 46.94503, 7.43824 | WS (parkinglist, parking.ch), GEO | Sulgeneckstrasse 18 / Bundesgasse 35 | 59 | WARN | relation centroid of underground garage; entrance ~60 m |
| node/5738643621 | Europaplatz | bicycle_rental | 46.94361, 7.40716 | SM (velospot:1775) | station "Europaplatz Süd - Bern" | 1 | PASS | |
| way/96261447 | Primarschule Stapfenacker | building | 46.94425, 7.38339 | GWR, GEO | Brünnenstrasse 40, 3018 Bern | 40 | PASS | way centroid |
| node/8505073617 | Wisent | attraction | 46.93454, 7.45146 | WS (tierpark-bern.ch Wisentwald), GWR | Tierpark Dählhölzli (Tierparkweg 3t at 23 m) | - | WARN | enclosure confirmed in Dählhölzli forest, exact point not verifiable |
| relation/10868135 | Gemeinschaftsgrab | artwork | 46.94065, 7.38725 | WS (bern.ch Friedhof Bümpliz), GEO | Friedhof Bümpliz, Bottigenstrasse 40 | 74 | WARN | inside cemetery; exact spot unverifiable |
| relation/11965148 | Weibliche und männliche Figur | artwork | 46.95270, 7.47168 | WS, GWR | none | - | WARN | no independent record found |
| node/10293437918 | Trojanisches Pferd | artwork | 46.97775, 7.49476 | WS | none (UniBE caption: Vögeli/Suter 1977-80, no location) | - | WARN | |
| relation/10032656 | ohne Titel | artwork | 46.95088, 7.43698 | WS, GWR | none (point = Falkenplatz 4) | - | WARN | |
| node/13888563934 | Dermatologie am Gurten | doctors | 46.92811, 7.44534 | WEB, GWR, GEO | Gurtenbrauerei 92, 3084 Wabern | 4 | PASS | |
| node/7820239856 | Podologie Länggasse | podiatrist | 46.95337, 7.43287 | WEB, GWR | Mittelstrasse 5, 3012 Bern | 2 (5a) / 21 | PASS | |
| node/14180314998 | Augenärzte Bern - Zentrum Marktgasse | doctors | 46.94803, 7.44695 | WEB, GWR | Marktgasse 6, 3011 Bern | 5 | PASS | |
| node/7858535249 | Hausärzte Länggasse | doctors | 46.95283, 7.43243 | WEB, GWR, GEO | Bühlstrasse 59, 3012 Bern | 4 | PASS | |
| node/13115205417 | Orsanic Zahnarzt | dentist | 46.92317, 7.45920 | WEB, GWR, GEO | Seftigenstrasse 358, 3084 Wabern | 19 | PASS | |
| node/1618815843 | Augenoptik & Hörakustik Stahl | doctors | 46.95671, 7.48465 | WS, ZEFIX, GWR | none (point = Bernstrasse 36, Ostermundigen) | - | WARN | no web/registry trace, possibly closed; an optician tagged amenity=doctors |
| way/595819818 | Terrasse Erlacherhof | garden | 46.94716, 7.45376 | WS (bern.ch), GEO | Erlacherhof garden, Junkerngasse 47 | 26 | PASS | city says not publicly accessible except a few days/year |
| node/13459851459 | Mastermind Bern | escape_game | 46.94747, 7.43475 | WEB, GWR, GEO | Laupenstrasse 20, 3008 Bern | 7 | PASS | |
| way/251014961 | Minigolf Waldau | miniature_golf | 46.96569, 7.48180 | WEB, GEO | Bolligenstrasse 111a | 72 | WARN | area centroid vs clubhouse; closed for winter until 13.3.2027 |
| way/337038677 | Freilandsukkulenten | garden | 46.95348, 7.44523 | WS (BOGA garden plan field 16a), GWR | Botanischer Garten, Altenbergrain 21 | 12 | PASS | |
| node/14228098626 | Berne Camping Eichholz 2 | sauna | 46.93359, 7.45497 | WEB, WS, GEO | Camping Eichholz, Strandweg 49, Wabern | 98 | WARN | site says "at Camping Eichholz on the Aare", bookable pop-up; no exact address |
| way/336971327 | Heilpflanzengarten | garden | 46.95301, 7.44463 | WS (BOGA garden plan no. 21), GWR | Botanischer Garten, Altenbergrain 21 | 59 | WARN | area feature inside BOGA grounds; likely fine |
| node/2533438285 | Freie evangelische Gemeinde Bern | place_of_worship | 46.94884, 7.44482 | WEB, GWR, GEO | Zeughausgasse 35, 3011 Bern | 13 | PASS | |
| way/45826647 | Salemkirche | place_of_worship | 46.95195, 7.45536 | GWR, GEO | Schänzlistrasse 27, 3013 Bern | 12 | PASS | |
| way/38351846 | Nydeggkirche | place_of_worship | 46.94883, 7.45736 | GWR, GEO | Nydegghof 2 / Nydeggasse 6 | 12-17 | PASS | |
| node/537538859 | Zentrum Wittigkofen | place_of_worship | 46.93975, 7.48088 | WS (bern.ch, SRF), GWR, GEO | Jupiterstrasse 15, 3015 Bern | 53 | WARN | big complex; SRF: church selling the centre (to Islamic centre), status may change |
| node/8548437677 | FMG Bern | place_of_worship | 46.96016, 7.44530 | WEB, GWR, GEO | Talweg 2, 3013 Bern | 7 | PASS | |
| way/103393125 | Kirche Wabern | place_of_worship | 46.92854, 7.44937 | GWR, GEO | Kirchstrasse 208, 3084 Wabern | 13 | PASS | |

## Summary

| verdict | count |
|---|---|
| PASS | 33 |
| WARN | 14 |
| FAIL | 1 |

Pass rate 33/48 = **69 %**; PASS+WARN 47/48 = 98 %. No item was found at a wrong place: every item with an independent location lies within 100 m of it, 32 of them within 35 m. The one FAIL is a shop that is probably closed, not a coordinate error.
Most WARNs are artworks, area features and tiny shops that cannot be checked from outside OSM, not wrong coordinates.

### Systematic findings
1. **No coordinate bug in `build-places.mts`.** All 48 elements are live in OSM with identical node coordinates; lat/lon order and the `out center` handling are correct.
2. **Way/relation centroids sit 40-75 m from the address/entrance** for big features: school, underground garage, minigolf, gardens, cemetery. That is fine for map pins but not for "walk me to the door". Suggestion: for ways/relations, prefer an `entrance=*` node or the GWR address point when one exists.
3. **Address missing on 26/48 items**, yet the GWR building at the point gives the correct published address in almost every business case (e.g. Volver 4 m, Podologie 2 m, Hot Momo 4 m, lista 14 m). Suggestion: backfill `address` from the nearest GWR entrance within ~15 m, marked as derived (`address_source: "gwr"`). The script also ignores `contact:addr` (Vizlo).
4. **Wrong address tags exist.** Amante's `addr:street` "Flughafenstrasse" should be "Flugplatzstrasse", so forward geocoding it lands 2.1 km off. Suggestion: check `addr:street` against GWR street names at build time and flag mismatches.
5. **Stale chain stores.** All 24 Denner in places.json were cross-checked against the official locator: 21 match within 50 m, and 3 have no store nearby (Kranichweg Muri 796 m, node/2674509977 524 m, node/7640147839 174 m). Suggestion: cross-check big brands (Denner/Migros/Coop) against their locators, and show "unverified" when there is no recent `check_date`.
6. **Semantics/access** (not location): an optician is tagged `amenity=doctors`; PubliBike/Velospot stations carry sponsor names instead of the official station names; the Erlacherhof terrace is listed as a garden but is closed to the public; seasonal or pop-up venues are included (minigolf winter break, sauna).

# Verification: OSM amenities + official places sample (70)

Generated 2026-11-21 by scratchpad/v.mjs, v2/v3/v4.mjs, mk.mjs. Raw evidence: verify-raw.json.

Methods: (1) cross-source nearest match (OSM ↔ official, same kind); (2) upstream re-query of every official item (map.bern.ch ArcGIS by Objectid in LV95 → swisstopo REFRAME; data.sbb.ch records by id; Velospot GBFS station_information; Kanton AED publisher lat/long + REFRAME); live OSM API 0.6 for all 30 OSM ids; (3) swisstopo SearchServer forward geocode + GWR identify for every address; BAV DiDok (ch.bav.haltestellen-oev) for stops/stations; Overpass (OSM) for tactile/acoustic/platform items; (4) web search for named POIs (Vietnam embassy, SUVA, Logistik Bern, Kitas, Postomat, AED).

## Summary

| src | PASS | WARN | FAIL |
|---|---|---|---|
| amenities | 13 | 17 | 0 |
| official | 40 | 0 | 0 |

### Findings
- **No CRS / conversion bug.** All 33 Stadt Bern items: our lat/lon vs the layer's native LV95 transformed by swisstopo REFRAME differ by 0.05 m (constant; the server-side outSR=4326 reprojection). SBB geopos Δ ≤ 0.01 m; the two billetautomat records' own LV95 e/n via REFRAME Δ ≤ 0.02 m. Kanton AED Δ 0.45 m vs publisher lat_deg/long_deg and vs REFRAME. Velospot Δ 0.00 m. No swapped coordinates in our output.
- **Upstream lat/lon swap (SBB mobiliar-im-bahnhof) is real and correctly handled**: upstream geopos has lon=46.94, lat=7.40; our un-swapped point is 1 m from BAV DiDok Bern Bümpliz Süd. The `lat < lon` heuristic is safe inside Switzerland.
- **No stale data in the sample**: all 40 official ids still exist upstream; all 30 OSM ids still exist in live OSM at identical coordinates.
- **Upstream text typos** (coordinates fine): "Freidheimweg 18" (real Friedheimweg), "Jubiläumstrasse 95" (Jubiläumsstrasse), "Logisik Bern" (Logistik). Anything that geocodes or string-matches these addresses will miss. Fix: optionally normalise against GWR (swisstopo SearchServer) at build time and keep the raw value in props.
- **OSM-only items are the weak spot**: 12/30 OSM items are benches/post boxes/a shower with no independent dataset in Bern (opendata.swiss has bench layers for Luzern/Winterthur/Biel, not Bern). 4 OSM bike-parking items have no official counterpart (2 are in Köniz, outside the Stadt Bern layer; 2 are covered/private-looking). 1 indoor OSM AED (node/14279906421) is not in the cantonal firstresponder registry. Fix: carry a `confirmed_by` / confidence field (e.g. set when an official item of the same kind is within 50 m) and, for AEDs, prefer kantonbern.aedsto and label OSM-only AEDs "unconfirmed, check on site".
- **Station-level SBB items** sit on the platform (≤ 8 m from the OSM platform polygon) but 115 m from the DiDok station centroid at Bern Wankdorf; do not validate these against station centroids.
- **Polygon centroids**: no problem seen (all sampled official items are Point geometries; OSM ways match their counterparts within 0–10 m). Botanischer Garten point is 84 m from its postal address (entrance building), which is fine for a 2.5 ha garden.

## Per-item table

| src | id | category | name | our lat, lon | evidence | dist m | verdict | upstream / note |
|---|---|---|---|---|---|---|---|---|
| amenities | node/9426611866 | bench |  | 46.9527518, 7.3912497 | none | – | WARN | live OSM API: present, unmoved; unverifiable street furniture (OSM-only; no official Bern bench/post-box/shower layer) |
| amenities | node/12040756329 | bench |  | 46.9447042, 7.416232 | none | – | WARN | live OSM API: present, unmoved; unverifiable street furniture (OSM-only; no official Bern bench/post-box/shower layer) |
| amenities | node/11553697013 | bench |  | 46.9174231, 7.4384522 | none | – | WARN | live OSM API: present, unmoved; unverifiable street furniture (OSM-only; no official Bern bench/post-box/shower layer) |
| amenities | node/8551577097 | bench |  | 46.9752784, 7.4027777 | none | – | WARN | live OSM API: present, unmoved; unverifiable street furniture (OSM-only; no official Bern bench/post-box/shower layer) |
| amenities | node/6326274270 | bench |  | 46.9469177, 7.4335008 | none | – | WARN | live OSM API: present, unmoved; unverifiable street furniture (OSM-only; no official Bern bench/post-box/shower layer) |
| amenities | node/13799545670 | bench |  | 46.921564, 7.4891748 | none | – | WARN | live OSM API: present, unmoved; unverifiable street furniture (OSM-only; no official Bern bench/post-box/shower layer) |
| amenities | way/549282950 | shelter |  | 46.9415446, 7.4255886 | GWR building Pestalozzistrasse 5a at point; swisstopo geocode; stadtbern Haltestelle Cäcilienstrasse 3 m | 1 | PASS | live OSM API: present, unmoved; bus shelter |
| amenities | node/6433775710 | bicycle_rental | Stauffacherstrasse | 46.9662352, 7.4558762 | velospot Stauffacherstrasse | 4 | PASS | live OSM API: present, unmoved |
| amenities | node/3263684586 | post_box |  | 46.9665351, 7.3723657 | none | – | WARN | live OSM API: present, unmoved; unverifiable street furniture (OSM-only; no official Bern bench/post-box/shower layer) |
| amenities | node/5745409047 | bicycle_rental | Statthalterstrasse | 46.9393797, 7.3863959 | velospot Statthalterstrasse | 3 | PASS | live OSM API: present, unmoved |
| amenities | node/11018490962 | bench |  | 46.9517936, 7.4605967 | none | – | WARN | live OSM API: present, unmoved; unverifiable street furniture (OSM-only; no official Bern bench/post-box/shower layer) |
| amenities | node/1617686019 | atm |  | 46.9560425, 7.4830591 | GWR bldg Bernstrasse 28 (Post branch Ostermundigen 1, web: places.post.ch) | 12 | PASS | live OSM API: present, unmoved; Postomat at the post office; OSM address has no house number (street-only geocode lands 481 m away, meaningless) |
| amenities | way/331749772 | bicycle_parking |  | 46.9462915, 7.4392332 | stadtbern Veloabstellplatz Bundesgasse 30 | 0 | PASS | live OSM API: present, unmoved |
| amenities | node/11381449462 | bicycle_parking |  | 46.9553487, 7.4280084 | stadtbern Veloabstellplatz Länggassstrasse 69 | 1 | PASS | live OSM API: present, unmoved |
| amenities | node/6205651100 | bicycle_parking |  | 46.9428094, 7.408703 | nearest stadtbern Veloabstellplatz Freiburgstrasse 153a | 153 | WARN | live OSM API: present, unmoved; covered, layer=1 (likely in/under a building, not a city rack); no independent evidence, not evidence of error |
| amenities | way/42857955 | bicycle_parking |  | 46.9431824, 7.4749277 | nearest stadtbern Veloabstellplatz Buchserstrasse 30 | 115 | WARN | live OSM API: present, unmoved; covered rack, no counterpart in city layer |
| amenities | node/14118363838 | bicycle_parking |  | 46.9240445, 7.4142397 | nearest stadtbern Veloabstellplatz Martiweg 17 | 1602 | WARN | live OSM API: present, unmoved; in Köniz/Liebefeld, outside Stadt Bern layer coverage; no independent evidence |
| amenities | node/2959892813 | embassy | Botschaft Vietnam | 46.9468187, 7.4288311 | GWR bldg Schlösslistrasse 26 at point (0 m); geocode 12 m; web (EDA list) confirms address | 0 | PASS | live OSM API: present, unmoved |
| amenities | node/5916630685 | bicycle_rental | Cäcilienplatz | 46.9416514, 7.4259964 | velospot Cäcilienplatz | 2 | PASS | live OSM API: present, unmoved |
| amenities | node/12638841604 | bicycle_parking |  | 46.9266008, 7.4313337 | nearest stadtbern Veloabstellplatz Heckenweg 19 | 729 | WARN | live OSM API: present, unmoved; in Köniz/Wabern, outside Stadt Bern layer coverage; no independent evidence |
| amenities | node/3450498093 | bicycle_parking |  | 46.9451985, 7.425675 | stadtbern Veloabstellplatz Effingerstrasse 89 | 48 | PASS | live OSM API: present, unmoved |
| amenities | node/4663324395 | playground |  | 46.9378268, 7.4515628 | stadtbern Spielplatz Thormannstrasse | 5 | PASS | live OSM API: present, unmoved |
| amenities | way/941596264 | bench |  | 46.9461876, 7.3778348 | none | – | WARN | live OSM API: present, unmoved; unverifiable street furniture (OSM-only; no official Bern bench/post-box/shower layer) |
| amenities | way/533590162 | bicycle_parking |  | 46.9584568, 7.4551802 | stadtbern Veloabstellplatz Herzogstrasse 24 | 1 | PASS | live OSM API: present, unmoved |
| amenities | node/8932098333 | shower |  | 46.9662122, 7.4524095 | none | – | WARN | live OSM API: present, unmoved; unverifiable street furniture (OSM-only; no official Bern bench/post-box/shower layer) |
| amenities | node/14279906421 | aed |  | 46.9469499, 7.4346116 | nearest kantonbern AED: Securitas, Seilerstrasse 7 | 88 | WARN | live OSM API: present, unmoved; indoor AED, OSM-only; not in the cantonal firstresponder registry; web search found nothing |
| amenities | node/8747356947 | bicycle_rental | Jubiläumsplatz | 46.9400864, 7.4530184 | velospot Jubiläumsplatz | 10 | PASS | live OSM API: present, unmoved |
| amenities | node/13626520301 | aed |  | 46.9673748, 7.4968799 | kantonbern AED Tennisclub Bolligen | 15 | PASS | live OSM API: present, unmoved |
| amenities | node/9770451490 | bench |  | 46.9677076, 7.46534 | none | – | WARN | live OSM API: present, unmoved; unverifiable street furniture (OSM-only; no official Bern bench/post-box/shower layer) |
| amenities | node/2368129767 | post_box |  | 46.9411326, 7.3907273 | none | – | WARN | live OSM API: present, unmoved; unverifiable street furniture (OSM-only; no official Bern bench/post-box/shower layer) |
| official | stadtbern.akustisches_Uebergangssignal/74062 | acoustic_crossing_signal | akustisches Uebergangssignal 15 | 46.9443168, 7.4323996 | OSM signal crossing node/665097866 (button_operated) | 1 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Veloabstellplatz/6781 | bicycle_parking | Hilfikerstrasse 3b | 46.9687227, 7.4634326 | geocode Hilfikerstrasse 3b; OSM bicycle_parking 50 m | 12 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Spielplatz/4072 | playground | Spitalacker Schule | 46.955336, 7.4539918 | OSM school 'Schulhaus Spitalacker' (polygon centroid); OSM playground 94 m | 49 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m; school-ground playground; borderline distance |
| official | stadtbern.Haltestelle/505 | transit_stop | Lerbermatt | 46.9308254, 7.4359885 | BAV DiDok platform sloid:90100:0:2 (stop 14 m) | 6 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.TVM_Feld/128 | tactile_paving | Blindenquadrat | 46.9500046, 7.4248773 | OSM bus_stop Bremgartenfriedhof node/7086937625 | 3 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m; Blindenquadrat = boarding marker at stop |
| official | stadtbern.Bundesverwaltung/8562 | federal_office | Schweizerische Unfallversicherungsanstalt/ SUVA | 46.9470672, 7.4360053 | geocode Laupenstrasse 11; web suva.ch agency list | 3 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Stimmlokal/10357 | polling_station | Erlacherhof | 46.9473836, 7.4537412 | geocode Junkerngasse 47; GWR 7 m | 4 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Haltestelle/142 | transit_stop | Brunnadernstrasse | 46.9407338, 7.4632345 | BAV DiDok platform sloid:7061:0:4 (stop centroid 62 m) | 12 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Haltestelle/274 | transit_stop | Galgenfeld | 46.952499, 7.4671527 | BAV DiDok stop 8590049 | 14 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.TVM_Feld/12977 | tactile_paving | Aufmerksamkeitsfeld | 46.9432954, 7.4355261 | OSM kerb tactile_paving=yes node/5353347335 | 0 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Kunst_im_oeffentlichen_Raum/779390 | public_art | Junges Mädchen mit Muschel / Stehendes Mädchen mit Schale | 46.948344, 7.4503515 | geocode of record's Standort 'Kramgasse 36' (Konservatorium terrace) | 28 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | sbb.mobiliar-im-bahnhof/8504106 | station_inventory | Bern Bümpliz Süd (SBB station furniture) | 46.9374875, 7.395238 | BAV DiDok station Bern Bümpliz Süd | 1 | PASS | upstream data.sbb.ch geopos Δ 0.00 m (upstream geopos has lat/lon swapped; build un-swaps); upstream geopos lat/lon swapped; build's un-swap is correct |
| official | stadtbern.Veloabstellplatz/6909 | bicycle_parking | Bubenbergplatz 15 | 46.9472405, 7.4391266 | geocode Bubenbergplatz 15; OSM bicycle_parking 18 m | 10 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | sbb.billetentwerter/15622599 | ticket_validator | Billetentwerter Bern Wankdorf | 46.9668047, 7.4653331 | on OSM platform way/516674907 (≤8 m); OSM ticket_machine 64 m | 8 | PASS | upstream data.sbb.ch geopos Δ 0.01 m; station centroid 115 m (expected for on-platform item) |
| official | stadtbern.Stadtverwaltung/780 | city_office | Logisik Bern | 46.9496049, 7.4459082 | geocode Predigergasse 12; web bern.ch order form | 7 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m; upstream name typo 'Logisik Bern' |
| official | stadtbern.Behindertenparkplatz/509 | disabled_parking | Kasernenstrasse 47 | 46.9581007, 7.4544729 | geocode Kasernenstrasse 47 | 13 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m; no OSM disabled_parking nearby (OSM gap) |
| official | stadtbern.TVM_Feld/4809 | tactile_paving | Aufmerksamkeitsfeld | 46.9433787, 7.4695941 | OSM kerb tactile_paving=yes node/12022655377 | 1 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Kunst_im_oeffentlichen_Raum/779017 | public_art | Das Gleichgewicht der Dinge | 46.9462594, 7.442038 | OSM artwork same title relation/10047702 | 1 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Haltestelle/857 | transit_stop | Stampachgasse | 46.9792715, 7.4911653 | BAV DiDok stop 8589016; OSM shelter 6 m | 9 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | sbb.sektortafel/275530999 | platform_sector_sign | Bern Wankdorf Gleis 1 Sektor D/C | 46.9668357, 7.465018 | on OSM platform way/516674907 (≤8 m) | 8 | PASS | upstream data.sbb.ch geopos Δ 0.00 m; station centroid 116 m (expected) |
| official | stadtbern.Veloabstellplatz/6330 | bicycle_parking | Mühlenplatz 2 | 46.9472021, 7.4560418 | OSM bicycle_parking way/546835660; geocode 4 m | 3 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Kunst_im_oeffentlichen_Raum/779101 | public_art | Fassadenmalerei | 46.9479834, 7.4546311 | geocode of Standort 'Junkerngasse 22' | 4 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m; facade painting |
| official | stadtbern.Haltestelle/249 | transit_stop | Fischermätteli | 46.9406458, 7.4184514 | BAV DiDok stop 8590014; OSM shelter 16 m | 15 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.TVM_Feld/7241 | tactile_paving | Aufmerksamkeitsfeld | 46.9582794, 7.4467116 | OSM crossing tactile_paving=yes node/2701286586 | 3 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Kindertagesstaette/18734 | childcare | Kita weissenbühl | 46.9359765, 7.4377161 | OSM childcare 'Kita weissenbühl'; geocode Friedheimweg 18 0 m; web local.ch | 14 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m; upstream street typo 'Freidheimweg' (real: Friedheimweg) |
| official | sbb.billetautomat/07000297 | ticket_machine | Billetautomat Bern | 46.9490795, 7.4397985 | OSM ticket_machine node/14360586261 | 35 | PASS | upstream data.sbb.ch geopos Δ 0.00 m; record's own LV95 e/n via REFRAME Δ 0.02 m; own LV95 e/n via REFRAME Δ 0.02 m |
| official | stadtbern.Sehenswuerdigkeit/8648 | attraction | Botanischer Garten Bern | 46.9528452, 7.4449794 | OSM garden 'Botanischer Garten Bern' | 16 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m; address point Altenbergrain 21 is 84 m (entrance building vs garden point) |
| official | stadtbern.Veloabstellplatz/6842 | bicycle_parking | Hochfeldstrasse 108 | 46.9592117, 7.4341354 | geocode Hochfeldstrasse 108 | 10 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | kantonbern.aedsto_aedsto/1739 | aed | Schulanlage Steinibach | 46.9884433, 7.4551592 | OSM AED node/11483340051; OSM school Steinibach 5 m | 19 | PASS | publisher lat_deg/long_deg Δ 0.45 m; LV95 REFRAME Δ 0.45 m; geocode Aarestrasse 47 is 53 m (AED is at gym, Turnhalle) |
| official | stadtbern.Veloabstellplatz/6718 | bicycle_parking | Rathausgasse 11 | 46.9485271, 7.4515129 | geocode Rathausgasse 11 | 13 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Haltestelle/177 | transit_stop | Bündenackerstrasse | 46.9286332, 7.4230992 | BAV DiDok stop 8502906 | 11 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Parkanlage_Punkt/8382 | park | Friedbühlanlage | 46.947107, 7.4204454 | OSM park 'Friedbühlanlage' | 7 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | velospot/PIB:Station:1911 | bike_share | Statthalterstrasse - Bern | 46.939358, 7.3863864 | OSM bicycle_rental 'Statthalterstrasse'; geocode Freieckweg 2a 16 m | 3 | PASS | upstream GBFS Δ 0.00 m; virtual station |
| official | stadtbern.Spielplatz/14293 | playground | Statthalter Schule | 46.937513, 7.3922348 | OSM playground node/5239665282 | 18 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Kunst_im_oeffentlichen_Raum/779214 | public_art | Wasser ("Wällehuus") | 46.9501588, 7.3869218 | OSM artwork 'Wasser' relation/10073533 | 2 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | sbb.billetautomat/null#4 | ticket_machine | Billetautomat Liebefeld | 46.9303003, 7.4191714 | OSM ticket_machine node/6068183478 | 4 | PASS | upstream data.sbb.ch geopos Δ 0.00 m; record's own LV95 e/n via REFRAME Δ 0.01 m; own LV95 e/n via REFRAME Δ 0.01 m; id is synthetic (id_automat null) |
| official | stadtbern.Behindertenparkplatz/1512 | disabled_parking | Freiburgstrasse 153a | 46.9430291, 7.4068435 | geocode Freiburgstrasse 153a; GWR 29 m | 30 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
| official | stadtbern.Kindertagesstaette/18751 | childcare | Crèche KidsCare Berne-EFIB | 46.9357435, 7.4464557 | OSM childcare 'KidsCare EFIB'; geocode Jubiläumsstrasse 95 0 m | 6 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m; upstream street typo 'Jubiläumstrasse' |
| official | stadtbern.Kunst_im_oeffentlichen_Raum/779295 | public_art | Die Tragödie | 46.949358, 7.4473984 | geocode of Standort 'Kornhausplatz 20' (Stadttheater) | 15 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m; indoor painting (Treppenhaus West) |
| official | stadtbern.Haltestelle/913 | transit_stop | Tillierstrasse | 46.9391156, 7.4475229 | BAV DiDok stop 8590062; OSM shelter 3 m | 14 | PASS | upstream LV95 -> swisstopo REFRAME Δ 0.05 m |
