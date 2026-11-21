# Admin / government / integration services for newcomers in Bern

Researched 2026-11-21. Legend: **V** = VERIFIED (fetched a page, API or dataset that states it), **U** = UNVERIFIED (search-snippet only, old document, or not confirmed). Lat/lon come from OSM (Overpass) or the Kanton Bern RAV shapefile. Blank = not obtained. Opening hours: almost no official page text gave current hours, so the "hours source" column says where to look. Do not hard-code hours.

## 1. Offices

| # | Name | What for (newcomer) | Address | lat, lon | Hours source / languages | Source URL | V? |
|---|---|---|---|---|---|---|---|
| 1 | **Einwohnerdienste, Migration und Fremdenpolizei (EMF) Stadt Bern** | Register after moving to the city (also move/address change, permits, Fremdenpolizei for city residents). Tel +41 31 321 53 00, einwohnerdienste@bern.ch | Predigergasse 5, 3011 Bern | 46.94943, 7.44625 (OSM n10161413090) | Hours not on fetched page; see www.bern.ch/EMF. bern.ch is DE/EN/FR/IT. Service languages not stated | https://www.bern.ch/en/topics/foreign-nationals/counselling-services ; SEM list https://www.sem.admin.ch/de/kantonale-migrations-und-arbeitsmarktbehoerden | V (address, phone) |
| 2 | **Migrationsdienst des Kantons Bern (MIDI)**, part of Amt für Bevölkerungsdienste | Cantonal permits (B/C/L, F, N), Kundenzentrum. Tel +41 31 633 53 15, midi.info@be.ch | Ostermundigenstrasse 99B, 3006 Bern | 46.95551, 7.47557 (OSM n13893702957) | Hours not found (check Kontaktformular on migration.sid.be.ch). Site is DE/FR. **Warning:** fake Telegram accounts impersonating MIDI are flagged on the site | https://www.migration.sid.be.ch/de/start.html | V (address via SEM page + OSM; site fetched) |
| 3 | **Bundesasylzentrum Bern (SEM, with procedural function)** | Asylum applicants' federal centre. Tel +41 58 461 44 20 | Morillonstrasse 75, 3007 Bern | | Visiting info not published (page lists none). Older docs say "Zieglerspital" (previous site) | https://www.sem.admin.ch/de/adressen-asyl | V (SEM list; search says published 17 Apr 2026) |
| 4 | SEM headquarters (not a walk-in for newcomers) | Federal migration office | Quellenweg 6, 3003 Bern-Wabern | | | https://www.sem.admin.ch/de/adressen-asyl | V |
| 5 | **RAV Bern (AVA Amt für Arbeitslosenversicherung), Standort Bern Bümpliz Süd** (OSM calls it "RAV Bern West") | Job-seeker registration, unemployment insurance. Tel +41 31 636 70 00, contact www.be.ch/ava-kontakt | Lagerhausweg 10, 3018 Bern | 46.93730, 7.39425 (OSM n1088649836) | Hours: be.ch/ava-kontakt. Not in dataset | Kanton Bern shapefile https://geofiles.be.ch/geoportal/pub/download/ADMRAV/admrav.zip | V (dataset downloaded and parsed) |
| 6 | **RAV Bern Wankdorf** | Same, second city site | Adamstrasse 6, 3014 Bern | OSM "RAV Bern Zentrum" n5628719872 at 46.95418, 7.46130 (unconfirmed it is the same site) | as above | same dataset | V (address); U (OSM match) |
| 7 | **Sozialdienst Stadt Bern** (Sozialhilfe; also Sozialamt) | Welfare / social assistance. Tel +41 31 321 60 27, sozialdienst@bern.ch. Page says it helps "needy citizens of the City of Bern" (refugee routing not stated: ask) | Schwarztorstrasse 71, 3007 Bern | OSM "Sozialamt der Stadt Bern" n6154375095 at 46.94451, 7.42879 (not matched to this address) | Search-snippet 2026 flyer: new applications Mon-Thu 14:00-16:30, Fri 14:00-15:30 (U). Flyers exist in DE/EN/FR and Leichte Sprache | https://www.bern.ch/en/topics/health-age-social-well-being/income-support | V (address, phone); hours U |
| 8 | **Fachstelle für Migrations- und Rassismusfragen (FMR)**, Stadt Bern. Replaced "Kompetenzzentrum Integration" (KI), which no longer exists | Counselling for new arrivals ("Beratung für Neuzugezogene"): schools, work, German courses. Tel +41 31 321 72 00, fmr@bern.ch | Predigergasse 5, 3011 Bern (same building as EMF) | 46.94943, 7.44625 (building) | Hours on bern.ch address block (not in page text). FMR page DE/EN/FR/IT, plus Leichte Sprache and sign language | https://www.bern.ch/en/topics/foreign-nationals/counselling-services ; fetched FMR page; KI->FMR from search (2022 newsletter) | V (address/phone); KI->FMR rename U |
| 9 | **isa Fachstelle Migration (Informationsstelle für Ausländerinnen und Ausländer)** | Free immigration + integration advice, German courses info. Tel +41 31 310 12 70 / 12 72, isa@isabern.ch | Speichergasse 29, 3011 Bern | | Advice in DE, FR, IT, EN (EN page); psychosocial advice in many languages (FMR page: 8 languages). Hours: canton flyer says open counselling Mon/Wed/Thu 16-18 (U, undated) | https://www.bern.ch/en/topics/foreign-nationals/counselling-services ; https://www.isabern.ch | V (address, languages); hours U |
| 10 | **Schulamt Stadt Bern** | Enrol children (Kindergarten, school; Intensivkurse IK German for newly arrived foreign-language children). Tel +41 31 321 64 60, schulamt@bern.ch | Effingerstrasse 21, 3008 Bern ("Meerhaus") | | IK form in DE/EN (search). Enrolment forms per Schulkreis | https://www.bern.ch/en/topics/foreign-nationals/german-courses (address/phone) | V (address/phone on fetched page); forms U |
| 11 | **Strassenverkehrs- und Schifffahrtsamt (SVSA), Verkehrsprüfzentrum Bern** | Driving licence: exchange foreign licence, theory/practical tests, registrations | Schermenweg 9, 3001 Bern (SVSA office Schermenweg 5 per search, U). Tel +41 31 635 80 80 | | **Counter Mon-Fri 07:30-16:00; phone Mon-Fri 07:30-12:00, 13:00-16:00.** Foreign-licence conversion rules not fetched | https://www.svsa.sid.be.ch/de/start/svsa/geschaeftsstellen/verkehrspruefzentrum-bern.html | V (address, hours) |
| 12 | **Steuerverwaltung des Kantons Bern** | Cantonal tax (Quellensteuer for permit holders, tax returns). Infoline +41 31 633 60 01 | Brünnenstrasse 66, 3018 Bern | OSM n3532403266 at 46.94286, 7.38576 | Hours conflict in sources; check taxme.ch | search (local.ch / Staatskalender); OSM | U |
| 13 | **Zivilstandsamt Bern** (civil registry: marriage, birth, etc.) | Civil-status events | Laupenstrasse 18a, 3008 Bern | 46.94759, 7.43574 (OSM n3527717377) | | OSM | V (OSM only) |
| 14 | **KKF / OCA Kirchliche Kontaktstelle für Flüchtlingsfragen** | Phone counselling, return counselling, courses for volunteers. Tel +41 31 385 18 11, info@kkf-oca.ch | Effingerstrasse 55, 3008 Bern | | No hours on page (see kkf-oca.ch/angebote-beratung/). Site DE/FR | https://www.kkf-oca.ch | V |
| 15 | **Amt für Integration und Soziales (AIS, GSI Kanton Bern)** | Operates the cantonal portal "Integrationsangebote im Kanton Bern" and KIP (integration programme). Not a walk-in office | Rathausplatz 1, 3000 Bern 8; Tel +41 31 633 78 11 | | DE/FR | https://integrationsangebote.apps.be.ch/de/impressum | V |
| 16 | **Comprendi** (Berner Vermittlungsstelle für interkulturelle Übersetzende; Caritas Bern per job ads) | Book community interpreters (clinics, school, social service). Tel 031 378 60 20 | no street address found | | Site comprendi.ch did not load (TLS cert error) | City of Bern doc via search | U |
| 17 | **frabina** (women and binational couples counselling) | Counselling | Kapellenstrasse 24, 3011 Bern; +41 31 381 27 01 | | | https://www.bern.ch/en/topics/foreign-nationals/counselling-services | V |
| 18 | **Berner Beratungsstelle für Sans-Papiers** | Undocumented migrants | Monbijoustrasse 31, 3011 Bern; +41 31 382 00 15 | | site DE/FR/IT | same page | V |
| 19 | **Prämienverbilligung & KVG-Obligatorium (ASV, Kanton Bern)** | Health insurance duty (3 months after registering), premium subsidy | Forelstrasse 1, 3072 Ostermundigen; +41 31 636 45 00, asv.pvo@be.ch | | | search (ASV leaflet) | U |
| 20 | **AKVB (Kanton: Amt für Kindergarten, Volksschule, Beratung)**, home-language courses (HSK) in about 25 languages | Home-language classes for kids | Sulgeneckstrasse 70, 3005 Bern; +41 31 633 84 51 | | | https://bern.ch/en/topics/foreign-nationals/german-courses | V |
| 21 | **Kantonspolizei / Polizei posts** | Police | e.g. Bahnhofplatz 10 (Bahnhof); Waisenhausplatz 32 (Polizeiposten Waisenhaus) | 46.94893, 7.43979 ; 46.95044, 7.44450 | | OSM | V (OSM) |
| 22 | **Post offices** (23 in bbox; useful: Bern 8 Kramgasse 3011; Post PostParc Bern; Bern 14 Mattenhof Belpstrasse 48) | Post, PostFinance | see list in section 3 | e.g. 46.94786, 7.45221 ; 46.94828, 7.43804 | Hours: post.ch Filialfinder | OSM | V (OSM) |
| 23 | **Embassies / consulates** | Passports, consular help | see section 4 | | EDA list | OSM + EDA | V |
| 24 | **International Bern Welcome Desk (IBWD)** | For diplomats, internationals, expats (not asylum seekers). Started Aug 2020 by EDA, Kanton and Stadt Bern; funding stated "until 2023" so it may be gone | no address on page | | | https://www.eda.admin.ch/de/bei-fragen-zum-alltag-in-bern-hilft-das-international-bern-welcome-desk | V (existence); U (still running) |

### Not found / gaps
- **Bildungszentrum Bern / specific German course providers**: no course finder located. The city says its overview is at bern.ch/deutschkurse (search snippet); fetched "German Courses" page has no finder, no subsidy details (U). Cantonal course portal ("Webportal" with subsidised courses) referenced by BKD, but the actual URL was not obtained.
- **Banks**: nothing authoritative. Moneyland (2022, U): Berner Kantonalbank accepts permit B or S, not N or F; UBS accepts B, F, S (in branch). PostFinance: page says come to a branch if you lack standard ID (S not named). Do not put this in the app as a fact; link to the post office / "ask the Sozialdienst" instead.
- **Health insurance**: no office to visit; it is an info item (3-month rule, ASV leaflet U).
- **Hours** for EMF, MIDI, FMR, Schulamt: not obtained from page text. Plan: store a `hoursUrl` per office and link out, or call a city "Öffnungszeiten" page by hand on the morning of the demo.

## 2. Data sources

| Source | What it has | Usable? | V? |
|---|---|---|---|
| **Kanton Bern geodata on opendata.swiss** (Amt für Geoinformation, files at geofiles.be.ch) | Dataset `regionale-arbeitsvermittlungszentren-rav-und-zahlstellen-der-arbeitslosenkasse` (shapefile, GPKG, Parquet; 2 Bern sites, name + address + phone; RAVZP layer has 7 rows canton-wide). Also `standorte-offentlicher-volksschulen`, `regionale-schulinspektorate`, `stand-elektronischer-umzug-eumzug`, `immobilienportfolio-des-amts-fur-grundstucke-und-gebaude`, `angebote-fur-kinder-...`, `regionen-erziehungsberatung-eb`. Files are LV95 (EPSG:2056): convert to WGS84 | **Yes for RAV and Volksschulen.** No dataset for MIDI/Einwohnerdienste/Sozialdienst found (searches for Botschaft, Poststellen, Asyl, Deutschkurse on CKAN: nothing Bern-specific) | V: downloaded admrav.zip, parsed DBF |
| opendata.swiss CKAN API: `https://ckan.opendata.swiss/api/3/action/package_search?q=...` | search works with a browser User-Agent (plain curl got 403) | Good for discovery | V |
| **Swiss Post open data** (swisspost.opendatasoft.com) | Domain no longer resolves ("This domain could not be found - Huwise"). opendata.swiss notice (search snippet): Swiss Post open data portal discontinued, questions to opendata@post.ch. Old dataset `zugangspunkte-post` (2018) | **No.** Use OSM for post offices | V (domain dead via curl); notice U |
| geo.admin.ch (api3 MapServer, 880 layers) | Searched layer names: no embassy / public administration / post layer. Only `ch.sem.sachplan-asyl_kraft` (Sachplan Asyl) and the PLZ perimeters `ch.swisstopo-vd.ortschaftenverzeichnis_plz` seem related | Not useful for offices | V |
| Stadt Bern Geoinformation (opendata.swiss, WMS/WFS) | Datasets such as parking, schools (Gymnasien, Hochschulen), playgrounds, bike pumps. No admin-office dataset seen | Maybe schools; not offices | U (search snippet) |
| **OSM via Overpass** | See section 3. Includes the main offices with names and often addresses | **Yes, best single source for embassies and post/police** | V |
| EDA Liste des diplomatischen und konsularischen Korps | PDF 643 kB, French, updated 26 Oct 2026; no machine-readable version found | Cross-check only | V (link on page) |
| bern.ch "Informationen in vielen Sprachen" | Static pages in: Arabic, Deutsch, English, Español, Français, Italiano, Kurdi, Português, Russian, Shqip, Srpski/Bosanski/Hrvatski, Tamil, Tigrinya, Türkçe, Ukrainian (found by scraping the page's links) | Good for **deep links per language**, not structured data | V |
| hallo-bern.ch | Title "Hallo Bern · Informationen für einen guten Start am neuen Wohnort" (HTTP 200). No API checked | Link out | V (title only) |
| integrationsangebote.apps.be.ch | Kanton Bern GSI portal, DE/FR; navigation "Arbeit und Qualifizierung", "Diskriminierungsschutz und Vernetzung". No API (`/api` is 404) | Link out | V |
| **migraweb.ch** | Both `www.migraweb.ch` and `migraweb.ch` failed DNS resolution from this machine. Could not check content or structured data | Unknown | U (not reachable) |

## 3. OSM counts (real queries)

Bbox `(46.9,7.34,46.99,7.5)`, Overpass query form:

```
[out:json][timeout:80];
nwr["<key>"="<value>"](46.9,7.34,46.99,7.5);
out tags center;
```

Note: `https://overpass-api.de` (and kumi, private.coffee, lz4, z) timed out from this network, so the identical queries were run against the Swiss mirror `https://overpass.osm.ch/api/interpreter` (same data, same query). Counts are nodes+ways+relations.

| Tag | Count | Notes |
|---|---|---|
| `amenity=townhall` | 10 | Mostly surrounding municipalities (Muri, Ostermundigen, Ittigen, Wohlen, Köniz area...). `r3988433` "Rathaus" at 46.94873, 7.45239 |
| `office=government` | 113 | Includes SEM (2 nodes), RAV Bern West, RAV Bern Zentrum, Sozialamt, Zivilstandsamt, Steuerverwaltung, SVSA, GSI, Einwohnerdienste/Migration/Fremdenpolizei (Predigergasse 5), MIDI (Ostermundigenstrasse 99B). 66 have no `government=*` subtag |
| `amenity=embassy` | **0** | Not used here, embassies are tagged `office=diplomatic` |
| `office=diplomatic` | **129** | `diplomatic=embassy` 119, `consulate` 9, `liaison` 1. 128 have a name, 120 have `addr:street`. Have `country=XX` tag. Clustered at Jungfraustrasse 1, Weltpoststrasse 4 and 20 etc. |
| `amenity=post_office` | 23 | Includes agencies and a DHL point |
| `amenity=police` | 12 | Includes Polizeiposten Waisenhaus, Bahnhof, Bümpliz, Neufeld |
| `office=employment_agency` | 9 | Temp agencies (Manpower, 4insiders...), **not** RAV |
| `amenity=social_facility` | 73 | Nursing homes 22, assisted living 13, group homes 9, shelter 3, outreach 1, advice 1; 19 untagged. Little for newcomers |
| `amenity=courthouse` | 2 | Obergericht, Regionalgericht Effingerstrasse 34 |
| `amenity=language_school` | 2 | |

Take-away: OSM is good for embassies (`office=diplomatic`), post offices, police and for the major agency buildings (names + coordinates), but many government nodes lack `addr:*` tags and some coordinates are rough, so spot-check.

## 4. Embassies

- **Is there a dataset?** Official EDA list is a French PDF only (V: eda.admin.ch protocol page, 26 Oct 2026). EDA says about half of the accredited missions are in Bern (no exact count on the page; a 2020 EDA statement cited via search: 152 embassies in Switzerland, 91 in Bern, U). Nothing on opendata.swiss (V: CKAN search "Botschaft" returned unrelated datasets).
- **OSM**: 129 `office=diplomatic` features in the bbox (V). Sample (V): Botschaft Argentinien and Malaysia at Jungfraustrasse 1 (46.94409, 7.45461); Portugal and Mexico at Weltpoststrasse 20 (46.93743, 7.47639); Greece and Finland at Weltpoststrasse 4 (46.93903, 7.47313).
- **Recommendation for app**: pull from OSM at build time, filter `office=diplomatic` + `diplomatic=embassy|consulate`, keep name, `country`, address, coordinates. Pre-index by country so a newcomer searches "Syria" or "Eritrea" and gets their embassy. Spot-check the top 20 nationalities by hand.

## 5. Multi-language info available

- bern.ch has an "Informationen in vielen Sprachen" section with 16 language pages (list in section 2). The FMR page says information is also available in Leichte Sprache and sign language. isa advice: DE/FR/IT/EN. KI/FMR page: isa consultants speak 8 languages.
- be.ch migration site: DE/FR only. KKF: DE/FR. Integrationsangebote portal: DE/FR.
- "Welcome to Bern" brochure: not found as such; closest is "Hallo Bern" and the "Bern für Sie" flyer (2019, via search, not opened).

## 6. Recommendation: hand-curate a JSON of ~20 key offices vs pull from data

**Hand-curate the ~20 offices (rows 1-3, 5-14, 16-20 above); pull only embassies, post offices and police from OSM.**

Reasons:
1. No official dataset covers MIDI, Einwohnerdienste, Sozialdienst, FMR, isa, Schulamt or SEM. Only RAV and schools exist (Kanton Bern GPKG), and the Swiss Post open dataset is gone.
2. The set is small and stable (about 20 offices). Typing it takes less time than building a pipeline. Each row can carry a `hoursUrl`, `languages`, `docs to bring` and `entrance note` (door/bus stop), which no source supplies. That is the "get me to the right door" feature.
3. Coordinates for hand-curated rows: reuse OSM where it matches (EMF, MIDI, RAV West, Zivilstandsamt, Steuerverwaltung); geocode the rest with geo.admin SearchServer (`type=locations&origins=address`; endpoint responds, but I did not test address geocoding itself) then eyeball on the map.
4. Suggested schema: `{id, name_de, purpose{en,de,...}, address, lat, lon, phone, email, hoursUrl, languages[], source, verifiedOn, needsAppointment}`.
5. Mark the unverified items (Steuerverwaltung hours, isa hours, Sozialdienst hours, comprendi, Schulamt forms) as "check before use" and verify by phone call or by opening the page before the demo.
6. Pull from data: `office=diplomatic` (129) and `amenity=post_office` (23) and `amenity=police` (12) from OSM once, bake into a static GeoJSON. Optionally RAV and Volksschulen from the Kanton Bern shapefile (reproject LV95 to WGS84).

## 7. Caveats
- Many facts came from search-engine summaries of PDFs/pages and are flagged U. Strong V items: EMF, FMR, isa addresses (bern.ch counselling page), SEM Morillonstrasse 75, RAV sites (shapefile), SVSA Verkehrsprüfzentrum incl. hours, Sozialdienst address, KKF, OSM counts.
- Opening hours were essentially not available as text; do not hard-code.
- overpass-api.de was unreachable from this machine; counts are from overpass.osm.ch. Re-run on the main host if exact parity matters.
