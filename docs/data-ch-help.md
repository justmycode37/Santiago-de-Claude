# Help data for all of Switzerland (`data/ch/help-ch.json`)

Checked on 2026-11-21. Rebuild with `node tools/build-help-ch.mts`. It needs internet for the 6 live feeds and swisstopo,
and takes about 15 s. If a live feed fails, the build stops so a good file is never overwritten. `ALLOW_PARTIAL=1` writes anyway
and marks the feed `fetched_ok: false`.

Scope: nationwide networks only, plus night shelters and soup kitchens in the 9 largest cities after Bern. Bern's
city-level help (leaflet, legal advice, language courses and so on) stays in `data/help.json` (see `docs/data-help.md`).
Bern-area Tischlein and Madame Frigo points appear in **both** files, with different ids (`tdd-<slug>` / `frigo-<operator ID>` here).

## File shape

`{ generated, note, counts, geocode_unmatched, pin_conflicts, outside_switzerland_dropped, foodsharing_dropped_as_frigo_duplicates, sources, hotlines, items }`

- `items[]`: `id, network, category, name, organisation, address (street line), postcode, city, canton, lat, lon, phone, website,
  opening_hours, who_for, cost, notes, source_url, source_checked, confidence, licence_unclear`. Unknown values are `null`.
- `sources[]`: `key, name, url, licence, method (live|manual), count, fetched_ok`. No source states a licence, so `licence` is always `null`.
  `licence_unclear` is `false` only on items taken from public-authority pages and flyers.
- `hotlines[]`: `id, number, name, purpose, hours, cost, scope, notes, source_url, source_checked`.

Self-checks (asserts): ids are unique; every item has network, category, name, source_url and confidence; points lie inside the
Swiss bounding box and inside a Swiss canton (swissBOUNDARIES3D); no Frauenhaus or other domestic-violence shelter; hotline numbers are unique;
the large feeds stay above their minimum sizes; at most 5% of items lack coordinates; the geocoder's matching rules have unit asserts.

## Coverage: 543 items and 10 hotlines

| network | category | n | source |
|---|---|---|---|
| tischlein-deck-dich | food_distribution | 180 | operator map feed (all CH incl. Ticino "Tavolino magico" and Romandie "Table couvre-toi"; Vaduz FL dropped) |
| caritas-markt | food_distribution | 22 | caritas-markt.ch shop list (2 "Projekte", Genf West and Zürich West, have no address and are left out) |
| essen-fuer-alle | food_distribution | 5 | essenfueralle.org pick-up page (Zürich, Seewen SZ, Chur, Glarus, Biel) |
| madame-frigo | public_fridge | 200 | madamefrigo.ch locations page |
| foodsharing | public_fridge | 8 | foodsharing.de public map API, Swiss points only (see below) |
| heilsarmee-brocki | second_hand | 21 | brocki.ch branch list (paid second-hand shops, not free) |
| nette-toilette | toilets_partner | 60 | flyers for Basel (26, Stand 06/24), Luzern (19, 2025), Solothurn (15, 04.2025) |
| local-zurich | shelter 6 / soup_kitchen 11 | 17 | Heilsarmee Zürich directories (30.06. and 30.09.2026), stadt-zuerich.ch |
| local-geneve | shelter 1 / soup_kitchen 11 | 12 | Ville de Genève leaflet July 2026, Abri PC de Richemont page |
| local-lausanne | shelter 5 / soup_kitchen 1 | 6 | lausanne.ch/hebergement-urgence (25.09.2026), Fondation Mère Sofia |
| local-basel | shelter 2 / soup_kitchen 1 | 3 | bs.ch Notschlafstellen (01.07.2026), gassenkueche-basel.ch |
| local-winterthur | shelter 1 / soup_kitchen 1 | 2 | Heilsarmee directory (Durchgangsheim Anker), Winterthur-Glossar (Shalom) |
| local-luzern | shelter 1 / soup_kitchen 1 | 2 | jobdach.ch, tragwerk-luzern.ch |
| local-st-gallen | shelter 1 / soup_kitchen 1 | 2 | stadt.sg.ch (UFO), stiftung-suchthilfe.ch |
| local-biel-bienne | shelter 1 / soup_kitchen 1 | 2 | sleep-in-biel.ch, gassenkueche-biel.ch |
| local-lugano | soup_kitchen 1 | 1 | fondazionefrancesco.ch (Centro sociale Bethlehem, Porza) |

`counts` in the file has the live numbers by network, category, canton and confidence.

### By canton

| canton | food_distribution | public_fridge | shelter | soup_kitchen | toilets_partner | second_hand | total |
|---|---|---|---|---|---|---|---|
| AG | 16 | 17 | 0 | 0 | 0 | 1 | 34 |
| AR | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| BE | 36 | 49 | 1 | 1 | 0 | 4 | 91 |
| BL | 3 | 7 | 0 | 0 | 0 | 0 | 10 |
| BS | 5 | 7 | 2 | 1 | 26 | 1 | 42 |
| FR | 5 | 7 | 0 | 0 | 0 | 0 | 12 |
| GE | 2 | 0 | 1 | 11 | 0 | 1 | 15 |
| GL | 3 | 0 | 0 | 0 | 0 | 0 | 3 |
| GR | 15 | 2 | 0 | 0 | 0 | 0 | 17 |
| JU | 3 | 4 | 0 | 0 | 0 | 0 | 7 |
| LU | 7 | 18 | 1 | 1 | 18 | 1 | 46 |
| NE | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| NW | 1 | 1 | 0 | 0 | 0 | 0 | 2 |
| OW | 1 | 2 | 0 | 0 | 0 | 0 | 3 |
| SG | 15 | 7 | 1 | 1 | 0 | 2 | 26 |
| SH | 4 | 0 | 0 | 0 | 0 | 1 | 5 |
| SO | 6 | 2 | 0 | 0 | 15 | 2 | 25 |
| SZ | 6 | 2 | 0 | 0 | 0 | 0 | 8 |
| TG | 8 | 4 | 0 | 0 | 0 | 1 | 13 |
| TI | 20 | 3 | 0 | 1 | 0 | 0 | 24 |
| UR | 1 | 1 | 0 | 0 | 0 | 0 | 2 |
| VD | 5 | 1 | 3 | 1 | 0 | 3 | 13 |
| VS | 0 | 1 | 0 | 0 | 0 | 0 | 1 |
| ZG | 4 | 6 | 0 | 0 | 0 | 1 | 11 |
| ZH | 37 | 67 | 7 | 12 | 0 | 3 | 126 |
| no coordinates | 1 | 0 | 2 | 0 | 1 | 0 | 4 |

AI has no items and AR has 1. VS (1) and NE (2) are thin: there are no Tischlein points in NE and no Caritas-Markt in VS or TI.

### Hotlines (`hotlines[]`)

112, 117, 118, 144 (Kapo Thurgau emergency card), 145 Tox Info Suisse, 1414 Rega, 143 Die Dargebotene Hand (English line
0800 143 000, 18-23 h), 147 Pro Juventute (24/7, free; WhatsApp 07:30-22:00), 142 Opferhilfe (nationwide since 1 May 2026, free and anonymous,
not an emergency number), and the Geneva emergency-accommodation line 0800 22 22 10 (scope "Ville de Genève").

## How the data was made

- **Geocoding**: swisstopo SearchServer (`origins=address`, up to 5 hits). A hit is accepted only if the house number (when there is one),
  the street's longest word, and the postcode or the town match. Canton comes from the hit; otherwise from the swissBOUNDARIES3D canton layer at the
  operator's map pin. When the source has no postcode (Geneva leaflet, Nette-Toilette flyers), it is taken from swisstopo and the notes say so.
- **Operator pins**: Tischlein, Madame Frigo, foodsharing and brocki.ch publish map pins. They are used only when the address is not found
  (33 items, all noted). If pin and address are more than 1 km apart, the item is marked `low` and listed in `pin_conflicts`.
- **foodsharing**: of about 180 points in the Swiss bounding box, those with "Frigo", "geschlossen" or "aufgehoben" in the name are dropped,
  then those outside a Swiss canton (DE/AT/FL), then inactive ones (`status != 1`), then any within 75 m of a Madame Frigo fridge (15, listed in
  the file). The 8 left are mostly RestEssBar points. Creator and manager user names from the API are **not** stored.
- **Tischlein fee**: the feed has no fee. "CHF 1 per visit" comes from the Heilsarmee Zürich directory (30.09.2026) and is cited in `cost`.
- **Corrections** (noted on the item): Pfuusbus street "Uetlibergerstrasse" -> Uetlibergstrasse (swisstopo); Basel flyer "Tellpaltz" -> Tellplatz,
  "Gembsberg 2-4" -> Gemsberg 2; ranges like "Rebgasse 12-14" are geocoded on the first number.

## Confidence

- **high**: operator or authority page read on 2026-11-21 and current (live feeds; city pages updated in 2026; Heilsarmee directories dated 2026).
- **medium**: Madame Frigo, foodsharing (volunteer-run, change often); brocki.ch; Nette-Toilette flyers (2024/2025, venues change); Zürich women's
  shelter (the city calls it the women's Notschlafstelle, the Heilsarmee list calls it a winter shelter); Sleep-In Biel (undated page).
- **low** (4): `brocki-baar` (brocki.ch shows the Bern address for Baar: address dropped, map pin used), `brocki-pratteln` (listed address is in
  Basel: address dropped, pin used), `brocki-lausanne` (pin 1.9 km from the address), `winterthur-gassenkuche-associazione-shalom` (only a city-library
  encyclopaedia article with a 2017 photo; times not stated).

Without coordinates (4, in `geocode_unmatched`): `tdd-bergpost-val-mustair` (no street in the feed), `lausanne-la-marmotte` (Rue du Vallon 17 not in
the building register), `lausanne-sleep-in` (Chemin de l'Usine-à-Gaz 10 not in the register), `nette-toilette-luzern-krienbruggli`
("Bruggerstrasse 8" does not exist in Luzern).

## Not found / left out (gaps)

- **Schweizer Tafel**: not included. It supplies more than 500 institutions (soup kitchens, shelters) and does not give food to individuals.
  Its "Standorte" page lists only offices and depots.
- **Too Good To Go** and similar commercial apps: skipped on purpose.
- **Partage (GE)** and other cantonal food banks only supply organisations; no public distribution points.
- **foodsharing.ch / foodsharingschweiz.ch**: no separate Swiss listing could be reached. Swiss Fairteiler come from the foodsharing.de API (see above).
- **Ärztefon / medical on-call numbers per canton**: no national list exists. The service is split across 100+ regional numbers (e.g. Zürich 0800 33 66 55,
  Basel MNZ 061 261 15 15). Not added; add canton by canton from official pages if needed.
- **Lugano: no night shelter** with a public address was found. Press search results say the city places people in guesthouses instead; this was not checked against an official page.
- **Geneva**: only the Abri PC de Richemont has a published address. The city's two hotels, Abri PC Châtelaine, Abri PC Sainte-Clotilde and the
  women's buildings are reached through 0800 22 22 10.
- **Zürich**: the family emergency shelter and youth emergency rooms have no public address (registration through Soziale Dienste); Broken Bread
  (street food distribution in the Langstrasse area) has no fixed address. Not added.
- **Free clothing**: no national list for Caritas, HEKS or SRK second-hand/clothing shops. Only Heilsarmee brocki.ch (paid second-hand) is
  included. Local free clothing (e.g. Brot-Egge Zürich, Le CARÉ Geneva on request) is in notes or not covered.
- **Nette Toilette elsewhere**: no current list found for other cities. A 2024 Winterthur city-council paper on public toilets reportedly decided against it (seen in a search snippet only, not read in full). For Thun
  only a 2016 article mentions a 2014 project. Nothing was found for the Romandie or Ticino. Bern is in `data/help.json`.
- **Domestic-violence shelters**: no addresses on purpose. Use 142 (Opferhilfe), 117 or 144.
- **Licences**: no source states one. Operator feeds are read from their own public map data; mark `licence_unclear`.

## Sources (all read on 2026-11-21)

Live: kkonlinerestapi.tischlein.ch/abgabestelle; caritas-markt.ch/de (+ /de/guenstig-einkaufen for eligibility); essenfueralle.org/beziehen/;
madamefrigo.ch/de/standorte/; foodsharing.de/api/map/markers/food-share-points and /api/food-share-points/{id}; brocki.ch/de/filialen/.
Manual: Basel Tourismus Nette-Toilette flyer (Stand 06/24); Luzern Tourismus flyer 2025; Stadtkanzlei Solothurn flyer 04.2025; Heilsarmee Soziale
Beratungsstelle Zürich "Notunterkünfte" (30.06.2026) and "Lebensmittelhilfe & Mahlzeiten" (30.09.2026); stadt-zuerich.ch Notschlafstelle; bs.ch
Notschlafstellen; gassenkueche-basel.ch; geneve.ch (Abri PC de Richemont, dispositif d'hébergement d'urgence, leaflet July 2026); lausanne.ch/hebergement-urgence;
meresofia.ch; jobdach.ch/notschlafstelle; tragwerk-luzern.ch; stadt.sg.ch Angebote für Obdachlose; stiftung-suchthilfe.ch; fondazionefrancesco.ch;
sleep-in-biel.ch; gassenkueche-biel.ch; winterthur-glossar.ch; kapo.tg.ch emergency card; toxinfo.ch; rega.ch; 143.ch; 147.ch; opferhilfe-schweiz.ch.
Exact URLs are in `sources[]`.
