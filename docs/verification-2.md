# Verification of the data-gap datasets (21 Nov 2026)

Seeded random sample (seed 777): 32 location records across services, toilets, station lifts, construction sites, street slopes, stop accessibility and register-derived addresses; 17 curated records from help, offices, fares (39 values) and holidays. Result: 0 FAIL. Fixed after review: toilets.json now keeps OSM `access` (customers/private) and maps "unknown" to null.

# Independent location verification: 32 sampled records (run 2026-11-21)

Input: `vs-locations.json`. Script: `vl.mjs` (raw output in `vl-raw.json`), `st2.mjs` (BAV stop layer).
Independent sources used: GWR building register identify, geo.admin SearchServer address geocode, swisstopo REFRAME (LV95 to WGS84), swisstopo height service, BAV `ch.bav.haltestellen-oev` layer, OSM API 0.6 (live), map.bern.ch ArcGIS (Baustellen_2, Strassensteigungen) re-query, the organisations' own websites, business register (business-monitor.ch), web search.
Distances are from the stored point to the independent point.

| file | id | name | evidence | dist m | verdict | note |
|---|---|---|---|---|---|---|
| services | kantonbern.religion_relstaet/224 | Ref. KG Grosshöchstetten, Kirche Zäziwil | REFRAME of source LV95 = 0 m; GWR Oberthalstrasse 3 at 10 m; OSM church way 177619934 addr Oberthalstrasse 3; parish site lists "Kirche Zäziwil-Mirchel" | 10 | PASS | |
| services | kantonbern.religion_relstaet/138 | Ev.-ref. KG Köniz, Stephanuskirche | REFRAME 0 m; GWR Spiegelstrasse 84 at 12 m; OSM "Kirche Spiegel" = Spiegelstrasse 84; geocode of the stated "Spiegelstrasse 80" = 34 m; kg-koeniz.ch: Kirchenkreis Spiegel, Spiegelstrasse 80 | 12 / 34 | PASS | The point is on the church (No. 84). The stated address is the office (No. 80). |
| services | kantonbern.religion_relstaet/640 | Sri Vinayagar Tempelverein Langnau | REFRAME 1 m; GWR Schärischachen 809b at 1 m | 1 | WARN | The location matches the stated address. Web search found nothing showing the temple exists: only a Facebook link, with no website or directory listing. |
| services | kantonbern.religion_relstaet/142 | Ref. KG Münsingen | REFRAME 0 m; GWR Bernstrasse 23 at 15 m; OSM church way 151277523 addr Bernstrasse 23; the secretariat (Schlossstr. 11, per ref-muensingen.ch) is 306 m away | 15 | PASS | The point is the church. The phone number and email belong to the secretariat. |
| services | kantonbern.admgde_gdedat/50 | Gemeindeverwaltung Aefligen | aefligen.ch: Fraubrunnenstrasse 3, 3426 Aefligen, tel. 034 445 23 93; geocode 0 m | 0 | PASS | |
| services | kantonbern.admgde_gdedat/184 | Gemeindeverwaltung Epsach | epsach.ch: Schulweg 1, 3272 Epsach, tel. 032 396 19 62; GWR 0 m | 0 | PASS | |
| services | kantonbern.religion_relstaet/183 | Ref. KG Oberwil | REFRAME 1 m; GWR Rütistrasse 3 at 1 m; OSM church addr Rütistrasse 3; kg-oberwil.ch footer: Rütistrasse 1 (41 m) | 1 | PASS | The canton's contact address (`adresse_k`, Hauptstrasse 6, 4584 Lüterswil, 2.3 km away) does not match the parish website (Rütistrasse 1). |
| services | kantonbern.admgde_gdedat/43 | Gemeindeverwaltung Wachseldorn | wachseldorn.ch: Süderen 63a, tel. 033 453 10 54; GWR 63a at 4 m (geocoder matched "Süderen 63") | 4 | PASS | |
| toilets | node/8787149451 | (Muristrasse 21c) | OSM live 0 m, tags match (eurokey, 24/7, fee=no); geocode Muristrasse 21c at 5 m | 5 | PASS | Duplicate: OSM node 478657989 is about 3 m away and is also in toilets.json with the same address. |
| toilets | node/7933623916 | (Langmauerweg 20a) | OSM 0 m, wheelchair=no matches; GWR Langmauerweg 20a at 3 m | 3 | PASS | Existence is confirmed only by OSM. |
| toilets | node/9753510188 | (no name) | OSM 0 m; tags are only amenity=toilets + female=yes; nearest GWR building 50 m (Stöckackerstrasse 9) | 50 | WARN | No address and no attributes. Edited 2022, nothing independent confirms it. The female=yes tag is dropped. |
| toilets | node/11040318686 | (Wohlenstrasse 60a) | OSM 0 m; GWR Wohlenstrasse 60a at 2 m | 2 | WARN | OSM says **access=customers**, but toilets.json has no access field, so the app presents it as a public toilet. |
| toilets | node/7643601461 | Domicil Schwabgut | OSM 0 m; GWR Normannenstrasse 1 at 9 m; Domicil brochure: Normannenstrasse 1, 3018 Bern | 9 | PASS | `opening_hours: "unknown"` is carried over as a literal string and should be null. |
| station-lifts | osm/node/3298730829 | Riedmoosbrücke | OSM live 0 m (highway=elevator on the footbridge at Niederwangen station); BAV "Niederwangen, Riedmoosbrücke" at 21 m | 0 | PASS | The label drops the "Niederwangen," prefix. The Niederwangen rail platform is about 100 m away. |
| station-lifts | osm/node/6100593395 | Weyermannshaus | OSM 0 m; nearest BAV stop "Bern, Weyermannshaus" at 76 m; the surroundings are a housing estate (access=private paths, apartment blocks) | 76 | WARN | Probably a private or residential lift, not station infrastructure. |
| station-lifts | osm/way/380731120 | Schanzenstrasse | OSM 0 m; the way is an inner member of platform relation 10228958 (railway=platform, ref 1;2, train=yes), i.e. **Bern main station**; BAV "Bern" (sloid 7000) at 46 m | 0 | WARN | Labelled with the bus stop name. Someone searching "Bern" for station lifts would miss it. |
| station-lifts | osm/way/1207978504 | Wankdorf Bahnhof | OSM 0 m, operator=SBB, wheelchair=yes; BAV "Bern Wankdorf, Bahnhof" at 25 m | 0 | PASS | |
| construction | baustelle/I.2026.0054 | Abbruch bestehendes Gebäude | map.bern.ch layer 1 still lists it; Locality/Project/status match; start 2022-03-01, end 2026-12-18 match (Zurich time); GWR Bubenbergplatz 10/12 at 16–17 m | 10 | PASS | The source record holds contractor and inspector names, phones and emails. **None of them are in the stored record.** |
| construction | baustelle/G.2025.0294 | "und Waldheimstrasse AS25 BeWe" | layer 2 still lists it; dates 2025-09-01 to 2027-12-31 match; GWR Waldheimstrasse 6/8 at 21 m | 14 | PASS | The title is a fragment in the source: Locality="Fabrik" plus Project="und Waldheimstrasse..." is presumably "Fabrikstrasse und Waldheimstrasse", an SBB project. The source's private Bauherrschaft phone was not leaked. |
| construction | baustelle/I.2026.0015 | Muldenplatz für Hausumbau | layer 1 lists it; dates 2026-02-01 to 2026-11-30 match; GWR Industrieweg 8 at 6 m | 0 | PASS | Ends in 9 days. The source names a private person as Bauherrschaft; the stored record does not. |
| street-slopes | strassensteigung/1759-0 | Diesbachstrasse | City re-query: Steig 5.77, first vertex 0 m; length 95.9 m (source Shape_Length 96.0); swisstopo heights 556.3 to 561.0 m gives +4.9 % in the stored direction (up) | 0 | PASS | The DEM gives 4.9 % against the source's 5.77 %. Both are "moderate", and the first 35 m are about 9 %. |
| street-slopes | strassensteigung/2378 | Spittelerstrasse | City Steigung −2.61, first vertex 0 m; DEM 580.5 to 579.4 over 61 m = −1.8 % (down) | 0 | PASS | |
| street-slopes | strassensteigung/1204 | Stauffacherstrasse | City Steigung −0.78; DEM −0.3 % over 69.5 m | 0 | PASS | |
| stop-access | ch:1:sloid:71398 | Kehrsatz, Bahnhof | BAV layer: all 3 edges at 0–57 m from their own sloids (exact); every attribute matches the ATLAS platform CSV and BFR (ug_Ersatztransport=1) | 0 | PASS | The source sentinels `999` cm (area length) and `0` height are carried over as real measurements on edge 03 (TO_BE_COMPLETED). |
| stop-access | ch:1:sloid:89031 | Ittigen, Hausmattstrasse | BAV layer 0 m; CSV: height 0, area 540×290, WITH_ASSISTANCE; BFR ug_Rampeneinsatz gives ramp_no_booking | 0 | PASS | |
| stop-access | ch:1:sloid:89227 | Niederwangen, Bahnhof | BAV layer 0 m for A/B/C/D; 6 edges match the CSV/BFR, including the new edge :31 (TO_BE_COMPLETED, valid until 2026-12-12) | 0 | PASS | Edges :03 and :31 both carry the label "D" (as in the source). The stop-level BFR is "replacement_transport" although edges A and B have ramp_no_booking. |
| places (derived) | node/11857724017 | Feinwerk & Co. | GWR geocode Rathausgasse 3 at 1 m; OSM shop=gift (edited 2024-04); **business register: Feinwerk&Co. KLG, Breitenrainplatz 33, 3014 Bern** (1109 m away); no web evidence of a shop at Rathausgasse 3 | 1 / 1109 | WARN | The derived address is right for the point, but the point itself may be stale or wrong. |
| places (derived) | node/9844659964 | Ragazzi di Berna | ragazzidiberna.ch: Eigerstrasse 73, 3007 Bern; GWR 7 m | 7 | WARN | The location is right, but the website now says "Montag bis Sonntag ausschliesslich für Gruppenanfragen geöffnet" (open Monday to Sunday for group bookings only). The OSM opening_hours (2025-06) are stale. |
| places (derived) | node/7248471129 | Rodelbahn auf dem Gurten | GWR Gurtenstrasse 222a at 3 m; OSM 0 m; sources say the Rodelbahn is at the Gurten top station, 3084 Wabern | 3 | PASS | The attraction has no published street address, so the derived address is only the nearest building. |
| amenities (derived) | way/570310535 | bicycle parking | OSM 0 m (capacity 20, covered); GWR Eigerstrasse 36a at 14 m | 14 | PASS | |
| amenities (derived) | node/13201994717 | bench | OSM 0 m; GWR Nesslerenweg 40 at 22 m | 22 | PASS | A house address on a bench reads as if the bench were at that house. |
| amenities (derived) | way/568191772 | disabled parking | OSM 0 m (capacity:disabled 2, fee no); GWR Marzilistrasse 45a at 5 m | 5 | PASS | |

## Summary

| file | PASS | WARN | FAIL |
|---|---|---|---|
| services.json | 7 | 1 | 0 |
| toilets.json | 3 | 2 | 0 |
| station-lifts.json | 2 | 2 | 0 |
| construction-sites.geojson | 3 | 0 | 0 |
| street-slopes.geojson | 3 | 0 | 0 |
| bern-stop-accessibility.json | 3 | 0 | 0 |
| places.json (derived:gwr) | 1 | 2 | 0 |
| amenities.json (derived:gwr) | 3 | 0 | 0 |
| **total** | **25** | **7** | **0** |

The conversions are correct. LV95 to WGS84 is within 0–1 m (REFRAME), the geocoded offices are at 0 m, and OSM, map.bern.ch and the ATLAS/BAV coordinates and attributes all round-trip exactly. The slope signs agree with the DEM. No personal data reached construction-sites.geojson, even though the upstream layer does publish names, phones and emails.

### Systematic issues and concrete fixes
1. **toilets.json drops OSM `access`.** `tools/build-toilets.mts` builds OSM items without `access`, so `access=customers/private` toilets look public (seen on node/11040318686). Fix: add `access: t.access ?? null` to `FIELDS` and the OSM mapping, and either filter out `private`/`no` or show "customers only". Also map the literal `"unknown"` to null for `opening_hours`/`fee`.
2. **Duplicate OSM toilets are not merged.** node/478657989 and node/8787149451 are about 3 m apart and both appear. Fix: dedupe OSM-to-OSM pairs within about 10 m (keep the one with more tags) before merging ATLAS and nette.
3. **The lift `station_name` is just the nearest stop name.** This mislabels the lift on Bern main-station platform 1/2 as "Schanzenstrasse" and attaches a probably private estate lift to "Weyermannshaus". Fix in `lifts()` (`tools/build-streets.mts`):
   - Prefer a rail station (BAV/official-places with train) within about 80 m over a closer bus stop, or use the OSM platform relation the lift belongs to.
   - Drop lifts whose ways are all `access=private` or that are more than 50 m from any platform or footway linked to a stop.
   - Keep the municipality prefix ("Niederwangen, Riedmoosbrücke").
4. **ATLAS sentinel values pass through as measurements.** `wheelChairAreaLength=999` (2,771 rows nationally) and `height 0`/`area 0×0` on `TO_BE_COMPLETED` edges appear as real numbers. Fix in `build-bern-accessibility.mts`: 999 becomes null (or "≥ 9.99 m"), and 0 becomes null when `infoOpportunities`/`vehicleAccess` is TO_BE_COMPLETED.
5. **Derived addresses are right for the point but cannot fix a stale OSM point.** Feinwerk & Co. sits at Rathausgasse 3 while its registered seat is Breitenrainplatz 33 (1.1 km). OSM opening hours for Ragazzi are stale. Fix: show a derived address as "near <address>" (also for benches and parking), and keep `check_date` or the OSM timestamp visible so users can judge freshness. This is a data-quality limitation, not a code bug.
6. Minor, from the source:
   - The canton's `adresse_k` for KG Oberwil is outdated.
   - The construction title is split across Locality and Project ("Fabrik" / "und Waldheimstrasse ..."). Consider `title = Locality + " " + Project` when Project starts with a lowercase word.
   - The source has two edges labelled "D" at Niederwangen. Consider showing the sloid suffix when labels collide.

Not checked: whether the OSM-only toilets physically exist (there is no current city list), and ATLAS data beyond the opentransportdata CSV and BAV layer (the ATLAS API needs a key).

# Verify pass 2: hand-curated facts (vs-facts.json)

Checked 2026-11-21. I fetched pages with a browser User-Agent and geocoded addresses with the api3.geo.admin.ch SearchServer (distance = stored lat/lon vs swisstopo hit). The fetched page texts are in `scratchpad/v2f/`.

## Summary

| File | PASS | WARN | FAIL |
|---|---|---|---|
| help.json (10) | 7 | 3 | 0 |
| offices.json (5) | 5 | 0 | 0 |
| fares.json (39 value rows) | 38 | 1 | 0 |
| holidays.json (4) | 3 | 1 | 0 |

Safety check: PASS. The sample has no domestic-violence shelter address. Opferhilfe has no address, and Pluto is a youth night shelter whose address is published by the operator itself. There is no private person's data: the 078 numbers belong to the Schreibdienst and Pluto services, as published by them.

## help.json

| id / field | Stored | Found | Source | Verdict | Note |
|---|---|---|---|---|---|
| lang-academia-languages / phone | +41 58 440 90 80 | +41 58 440 90 80 (Bern page); +41 58 440 90 90 is the head office in the site footer | https://academia-languages.ch/bern/ , city DeutschBon page | PASS | Bern school is at Effingerstrasse 53 & 15, 3008 Bern (address is null in the record). The note's "overview page lists 80 90" is confusing; the other number is 90 90 = HQ. |
| lang-academia-languages / email, DeutschBon | info.bern@academia-group.ch | same; Bern page says DeutschBon accepted | same | PASS | |
| frigo-dock8 | Holligerhof 8, 3008; 46.947777,7.415456 | Operator: Holligerhof 8, 3008 Bern; swisstopo 0 m | https://www.madamefrigo.ch/de/standorte/ | PASS | |
| nette-toilette-…-ringgenberg | Kornhausplatz 19, 3011; 46.948788,7.447863 | swisstopo 0 m; restaurant still listed at Kornhausplatz 19 (bern.com, myswitzerland); a Stadtrat motion from Jul 2026 still mentions the Nette Toilette scheme | city flyer (2018); https://bern.com/en/explore/food-drink/restaurants/restaurant-ringgenberg | WARN | Participation is only proven by the 2018 flyer; I found no current list. The restaurant now calls itself "Restaurant Ringgenberg". |
| schreibdienst-vbg | Mo 14-19, Bahnhofplatz 2, 078 741 22 27, free, no registration | Same on the VBG page: Mo 14-19 at Berner GenerationenHaus, phone Mo 14-19 078 741 22 27, free, no registration, no translations/tax/legal; swisstopo 0 m | https://www.vbgbern.ch/die-vbg/projekte-und-angebote/schreibdienst | PASS | The page mentions a summer break (Sommerpause). The record's source is an undated PDF; switch source_url to the VBG page. |
| lang-ecap | +41 31 381 81 33, infobe@ecap.ch | ECAP Bern: Freiburgstrasse 130, Tel 031 381 81 33, infobe@ecap.ch | https://www.ecap.ch/standorte/bern/ | PASS | Stored website URL redirects to /standorte/bern/. Address is null in the record. |
| frigo-sub-husli | Lerchenweg 32, 3012; 46.953922,7.429677 | Operator: Unitobler, Lerchenweg 32, 3012; swisstopo 0 m | madamefrigo.ch/de/standorte | PASS | |
| lang-muki | +41 31 321 64 78, ages ~2.5-5 | Same phone, ages "ungefähr 2,5 bis 5 Jahren"; cost CHF 300/year (CHF 3.80/h), courses start in August | https://www.bern.ch/themen/bildung/vorschule/muki-deutsch | PASS | Cost could be filled in: CHF 300/year. |
| tdd-bern-burenpark | Fr 10-11, Bovetstrasse 1, card via Sozialfachstelle | Feed: "AS Bern Bürenpark", Missione Cattolica, Bovetstrasse 1, Freitag 10.00-11.00; tischlein.ch describes the same card process (needs check, card by post, once a week); swisstopo 0 m | https://kkonlinerestapi.tischlein.ch/abgabestelle , https://www.tischlein.ch/de/lebensmittel-erhalten | PASS | The fee amount (commonly CHF 1) is not on these pages either, so "amount not stated" is honest. |
| asylhilfe-bern / phone | 031 382 52 72 / 076 700 49 40 | Own site lists only Mobile 076 700 49 40. The city PDF (edition Oct 2026) lists both | https://www.asylhilfe.ch/de/ , city PDF | WARN | The landline is not on the organisation's own site; call the mobile first. Advice is in DE/EN/Farsi (could fill `languages`). Postal address Postfach 4034, 3604 Thun and "by appointment" confirmed. The cost "free or max CHF 50" is the PDF's generic statement for all listed offices. |
| frigo-buvette-spitz / address | Viktoriastrasse 60, 3013; 46.955162,7.454382 | Operator's address field says Viktoriastrasse 60, but its own pin geocodes to Spitalackerstrasse 35, 3013 Bern. Viktoriastrasse 60 does not exist in swisstopo (nearest is No. 49, 160 m away). The pin is 10 m from Spitalackerstrasse 35 | madamefrigo.ch/de/standorte | WARN | Coordinates are fine. Show the address as "Spitalackerpark, near Spitalackerstrasse 35, 3013 Bern" rather than a non-existent house number. |

## offices.json

| id / field | Stored | Found | Source | Verdict | Note |
|---|---|---|---|---|---|
| pluto | Studerstrasse 44, 3004; 078 247 24 44; 14-23, free | Own site: Studerstrasse 44, 078 247 24 44 (Signal/Telegram too), ages 14-23, free, 7 beds, open nightly 18:00-09:00; hallo-bern lists the same phone; swisstopo 0 m | https://pluto-bern.ch/ , hallo-bern.ch | PASS | The address is now confirmed on the operator's site, so `verified:false` and "address from a web snippet only" are out of date. Hours 18:00-09:00 could be added. |
| hotline-117 | 117 | "Im Notfall wählen Sie bitte 112 oder 117" | https://www.police.be.ch/de/start.html | PASS | |
| isa | Speichergasse 29, 3011; +41 31 310 12 70; free, DE FR IT EN | Speichergasse 29, 3011 Bern; 031 310 12 70 / 72; free advice; languages listed also include Spanish, Turkish, Farsi, Dari, Azerbaijani; swisstopo 0 m | https://isabern.ch/kontakt/ , https://isabern.ch/beratung-information/persoenliche-beratung/ | PASS | The language list is incomplete. Walk-in hours on the contact page: Mon-Thu 10-12; Mon, Wed, Thu 14-17. |
| akvb | Sulgeneckstrasse 70, 3005; +41 31 633 84 51 | City page shows the same block (AKVB, Sulgeneckstrasse 70, +41 31 633 84 51, akvb@erz.be.ch); the canton's state calendar has the same number; swisstopo 0 m | https://www.bern.ch/en/topics/foreign-nationals/german-courses , sta.be.ch Staatskalender | PASS | The number is the AKVB general information line, not a dedicated HSK line. |
| hotline-opferhilfe | 031 370 30 70 | Opferhilfe Bern 031 370 30 70 (Seftigenstrasse 41, Bern); hallo-bern lists the same; for all people | https://www.opferhilfe-bern.ch/de , hallo-bern.ch | PASS | Since May 2026 Opferhilfe can be reached nationwide, 24/7, on the short number **142**. Worth adding. |

## fares.json

Sources: mylibero.ch pages listed per row, bernmobil.ch, sbb.ch. Libero table column order is ermässigt 2nd/1st, then Vollpreis 2nd/1st.

| Field | Stored | Found | Source | Verdict |
|---|---|---|---|---|
| Kurzstrecke adult_2nd / reduced_2nd | 3 / 2 | 3.00 / 2.00, 30 min, max 1.5 km | mylibero.ch/de/tickets/kurzstrecke | PASS |
| Kurzstrecke 6-trip card adult / reduced | 16.20 / 10.80 | 16.20 / 10.80 | mylibero.ch/de/tickets/mehrfahrtenkarte | PASS |
| Kurzstrecke not valid on Gurtenbahn, Marzilibahn, Matte lift | – | confirmed | kurzstrecke | PASS |
| Einzelbillett 1-2 zones a2/a1/r2/r1, 60 min | 5.20/9.00/3.00/5.10 | 5.20/9.00/3.00/5.10, 60 min | einzelbillette | PASS |
| Undated single/day/multi-trip must be stamped | – | confirmed on all 3 pages | einzelbillette, tageskarte-bern, mehrfahrtenkarte | PASS |
| Tageskarte 100/101 a2/a1/r2/r1 | 10.40/18.00/6.00/10.20 | same | tageskarte-bern | PASS |
| Tageskarte validity until 05:00 next day | – | confirmed | tageskarte-bern | PASS |
| Tageskarte "worth it from 2 trips a day (Libero)" | – | Not stated on the page. The arithmetic holds (2 × 5.20 = 10.40) | tageskarte-bern | WARN: present it as a calculation, not a Libero quote |
| Mehrfahrtenkarte 1-2 zones a2/a1/r2/r1 | 28.20/48.60/16.20/27.60 | same | mehrfahrtenkarte | PASS |
| Mehrfahrtenkarte valid 1 year; several people same reduction | – | "Gültigkeit von einem Jahr"; same rule | mehrfahrtenkarte / faq | PASS |
| Abo Bern month a2/a1/r2 | 82/136/62 | 82.00/136.00/62.00 | libero-abo/bern | PASS |
| Abo Bern year a2/a1/r2 | 738/1224/558 | 738.00/1'224.00/558.00 | libero-abo/bern | PASS |
| Abo reduced = up to 25th birthday, women 64+, men 65+, 2nd only; worth from 3 days/week | – | confirmed | libero-abo/bern | PASS |
| reduced_fare_means (Halbtax, children 6-15, dogs) | – | "Ermässigte Preise mit Halbtax, für Kinder unter 16 Jahren und für Hunde"; under 6 free | einzelbillette, faq/tarifinfos | PASS |
| Zones: 2-15 zones, zones crossed twice count once, 15+ = whole area | – | confirmed | faq | PASS |
| Zone colours (blue overlap not valid within; green = Abos only) | – | confirmed | faq | PASS |
| Bern machines "Einzelbillett Zonen 100 101" quick button | – | confirmed | faq / ticketautomaten | PASS |
| Day pass not valid on Gurtenbahn, valid Marzilibahn/Matte; no boats | – | confirmed | faq | PASS |
| Beyond Libero: national ticket from last stop | – | confirmed | tageskarte-bern / mehrfahrtenkarte | PASS |
| Children: Junior-Karte / Kinder-Mitfahrkarte rule | – | confirmed (price not on page) | faq/tarifinfos | PASS |
| Apps SBB Mobile, BLS Mobil, FAIRTIQ | – | all three linked on page | mylibero.ch/de/einfach | PASS |
| öV Plus payments | cards, TWINT, Reka, Apple/Samsung/Swisscom Pay, Halbtax PLUS | same | bernmobil.ch …/oev-plus-app | PASS |
| Check-in before departure | – | confirmed | bernmobil e-ticket, fahrausweiskontrolle | PASS |
| Bernmobil machines: coins, cards contactless, TWINT; Kante L help | – | confirmed | ticketautomaten | PASS |
| BLS machines cashless, Dec 2025 to mid-2026, anonymous prepaid card | – | confirmed | bls.ch press release 07.10.2025 | PASS |
| Servicecenter Bubenbergplatz 5, 031 321 88 44, hours + holiday hours, free passport photo | – | all confirmed (Zibelemärit 23.11.2026 09-17, 24/31.12 09-17, closed 25/26.12, 1/2.1) | bernmobil.ch …/verkaufsstelle | PASS |
| Webshop libero-webshop.ch/de/ | – | linked | mylibero.ch/de/tickets | PASS |
| Libero advice phone | +41 31 321 82 22 | same | mylibero.ch/de/verkauf-beratung | PASS |
| Fines without ticket 1st/2nd/3rd, incl. fare | 100/140/170, 10 | same | bernmobil.ch …/fahrausweiskontrolle | PASS |
| Fines partly valid 1st/2nd/3rd, incl. fare | 75/115/145, 5 | same | same | PASS |
| Extras: misuse/false data/running away; ID research per 15 min; reminder; forgery | 100/25/40/200 | same | same | PASS |
| Payment terms 30 days, reminder 10 days; basis = last 2 years; reduced surcharge conditions | – | same | same | PASS |
| Halbtax now: adult new/renewal, youth new/renewal | 190/170/120/100 | same | sbb.ch/de/angebote/halbtax | PASS |
| Halbtax from 13.12.2026 | 195/175/120/100 | same | same | PASS |
| Halbtax: no Abo discount; auto renewal | – | confirmed (faq + sbb) | faq, sbb | PASS |
| Halbtax PLUS valid except multi-trip, multi-day, Abos | – | confirmed | mehrfahrtenkarte / faq | PASS |
| KulturLegi flyer 2025: no public-transport discount | – | no ÖV/Libero/Bernmobil text in the PDF | kulturlegi.ch flyer | PASS |
| IV-Libero Stadt Bern (IV, or AHV+EL) | – | confirmed | bernmobil.ch …/verguenstigungen | PASS |
| Schnupperabo 5 days + CHF 20 off | – | confirmed | faq/tarifinfos | PASS |
| Commune contribution IV/EL | – | confirmed | faq | PASS |
| SwissPass replacement CHF 30 with ID | – | confirmed | faq | PASS |

The price_change_warning is reasonable: SBB confirms new Halbtax prices from 13.12.2026, and I found no announced Libero price change.

## holidays.json

| Field | Stored | Found | Source | Verdict | Note |
|---|---|---|---|---|---|
| public 2026-04-03 Karfreitag | 2026-04-03 | Karfreitag is a "hoher Festtag" (BSG 555.1 Art. 2b); Easter 2026 = 5 Apr | BSG 555.1 (lexfind.ch/tolv/111424/de) | PASS | |
| public 2027-12-26 Stephanstag | 2027-12-26 | "der 26. Dezember" is a public holiday (BSG 555.1 Art. 2c) | same | PASS | Falls on a Sunday in 2027. |
| school CH-BE-VS Winterferien | 2027-12-25 to 2028-01-09 | City of Bern: Fr Mittag 24.12.2027 to So 09.01.2028 (canton: same) | https://www.bern.ch/themen/bildung/schule/schulferien ; cantonal Ferienordnung | PASS | Off by a half day: school ends at noon on 24.12. |
| school CH-BE-EO Winterferien | 2025-12-22 to 2026-01-02 | No official French-speaking source found. German-speaking 2025/26 was Sa 20.12.2025 to So 04.01.2026 | cantonal Ferienordnung (German part) | WARN | Unconfirmed. The range is Mon-Fri, while the VS record includes weekends (inconsistent convention). Also not relevant to Stadt Bern. |

## Systematic issues

1. Some records carry stale verification metadata. Pluto has `verified:false` with "address from a web snippet only", but the operator now publishes the address. Schreibdienst cites an undated PDF when the VBG page has the same data.
2. Useful facts are missing from records even though the sources have them: Opferhilfe national 24/7 number 142 (since May 2026), the Pluto hours 18:00-09:00, the MuKi cost CHF 300/year, the isa and Asylhilfe languages, and the Academia (Effingerstrasse 53) and ECAP (Freiburgstrasse 130) addresses.
3. Madame Frigo's address text is not always trustworthy (Buvette Spitz); its map pin is. Swisstopo-validate the address field and fall back to the pin's reverse-geocode.
4. School-holiday conventions are mixed. Some ranges include weekends and some don't, and half-days (Do/Fr Mittag) are dropped. The OpenHolidays data matches the city table for VS apart from the half-day.
5. Nette Toilette partners rely on a 2018 list. Treat all of them as low confidence, as the record already does.
