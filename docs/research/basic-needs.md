# Basic needs / humanitarian services, Bern (research, 21 Nov 2026)

Legend: V = VERIFIED (fetched/queried this session), U = UNVERIFIED (search-snippet or third-party only, re-check before shipping).
Bottom line up front: **no open dataset covers these services.** The best single source is a city-published PDF (hand-curate from it); OSM covers almost none of it.

## 0. Best single source (hand-curate from this)

| Name | What | URL | Format | Licence | V |
|---|---|---|---|---|---|
| "uf dr Gass" street guide, Stadt Bern (PINTO), Version 01.26 (Mar 2026) | ~24 numbered entries: day rooms, meals, soup kitchens, night shelters, showers, advice, emergency numbers, with address, phone, hours, price | https://www.bern.ch/politik-und-verwaltung/stadtverwaltung/bss/familieundquartier/pinto-pravention-intervention-toleranz/downloads/downloads-2/uf%20dr%20Gass%20Vs%2009_25.pdf | PDF (2 landscape pages, text extractable with `pdftotext -layout`; file URL says 09_25 but content is 01.26) | none stated (city publication; ask before bulk reuse) | V |
| Wohnkonferenz Region Bern "Wohnführer" | Filterable web directory of housing (Notschlafen, betreut, begleitet); mostly supported housing for locals, not a refugee directory | https://www.wohnkonferenz.ch | HTML only, no API/CSV seen; `/downloads-3` has only PDFs/slides, no shelter list | none stated | V |
| Katholische Kirche Region Bern, "Angebote im Migrations- und Asylbereich", Frühling 2025 | Directory of ~40 migration/asylum orgs (Hilfswerke, NGOs, church, Stadt, private) with address, phone, target group | https://cms.kathbern.ch/media/ay2g41fp/migrationsangebote_a5_2025_web.pdf | PDF | none stated | V |
| hallo-bern.ch (Kanton Bern, GSI) | Multilingual newcomer guide (20 languages), pages "Notfälle und Beratungsstellen", "Häusliche Gewalt", "Gesundheit", "Soziale Sicherheit". Prose, no map, no download seen | https://www.hallo-bern.ch/de/notfaelle-und-beratungsstellen | HTML | none stated | V (home page) |

## 1. Emergency night shelters / accommodation

| Name | What | Address / phone | Data source | Format / licence | V |
|---|---|---|---|---|---|
| Sleeper (Verein Pro Sleeper) | Men/people without means; bed + breakfast CHF 5; check-in 22:00-01:00; wake 09:00, out 10:00 | Neubrückstrasse 19, 3012 Bern, 031 301 64 04 | uf dr Gass PDF; also in OSM (`amenity=social_facility`, `social_facility=shelter`) | PDF / ODbL | V |
| Passantenheim der Heilsarmee | 50 beds, men and women, shower on floor, washing machine, kitchen; CHF 15 incl. breakfast; open Sun-Thu to 23:00, Fri-Sat to 24:00; new admissions only exceptionally round the clock | Muristrasse 6, 3006 Bern, 031 351 80 27 | uf dr Gass PDF; OSM has it as a node without address/shelter tag | PDF / ODbL | V |
| Frauen/FINTA-Notschlafstelle | Safe overnight place for homeless FINTA persons, access 24h, breakfast, cooking. This is a homelessness shelter, address is public on the city guide (not a DV refuge) | Kursaalstrasse 6, 3013 Bern, 076 326 97 75 | uf dr Gass PDF; Stadt Bern press release (URL surfaced in search, not fetched) | PDF | V (PDF) |
| Pluto (youth night shelter, 14-23) | Run by Verein Rêves sûrs | Studerstrasse 44, 3004 Bern | web search snippet only | - | U |
| Notschlafstelle Tiefenau (Heilsarmee, temporary) | Winter 2024/25 overflow shelter, avg 17-18 guests/night, **closed end March 2025**, future site open; check whether a winter 2026/27 successor exists | former Tiefenauspital | Stadt Bern press release 7 Apr 2025 (PDF fetched) | PDF | V (closure) |
| Wohn- und Obdachlosenhilfe, Stadt Bern | City office for housing/homelessness referrals | 031 321 60 83 | https://www.bern.ch/themen/gesundheit-alter-und-soziales/sozialhilfe/wohn-und-obdachlosenhilfe (no shelter list on page) | HTML | V |
| Sozialdienst Stadt Bern (registration for help) | New registrations Mo-Thu 14:00-16:30, Fr 14:00-15:30; form help (Schreibstube) Mo-Mi 08:30-11:30, Fr 08:30-11:30 | Schwarztorstrasse 71, 031 321 60 27 | uf dr Gass PDF | PDF | V |
| Kirchliche Passantenhilfe Bern (AKiB) + Sozialberatung Heilsarmee | Emergency aid, social counselling, anonymous possible, free; Mo/Di/Do/Fr 09-11:30 + 14-16, Mi 14-16 | Laupenstrasse 5, 031 380 75 40 | uf dr Gass PDF | PDF | V |

## 2. Federal / cantonal asylum

| Name | What | Address / phone | Data source | Format / licence | V |
|---|---|---|---|---|---|
| Bundesasylzentrum (BAZ) Bern, with procedure function | Federal asylum centre. Older name "BAZ Bern (Zieglerspital)" still appears in some documents; official list gives Morillonstrasse | Morillonstrasse 75, 3007 Bern, +41 58 461 44 20 | https://www.sem.admin.ch/de/adressen-asyl | HTML | V |
| Bundesasylzentrum Kappelen, no procedure function | Outside Bern city | Grenzstrasse 19, 3250 Lyss, +41 58 480 88 71 | same | HTML | V |
| Rechtsschutz inside BAZ Bern | Free legal protection for asylum seekers in the centre | Morillonstrasse 75, +41 31 370 35 00 | web search snippet (Rechtsschutz overview, Apr 2025) | - | U |
| Kollektivunterkünfte (Herrenschwanden SRK, Tiefenau Heilsarmee) | Cantonal collective housing for refugees. Exist in OSM as `social_facility=shelter`, `social_facility:for=refugees` | Herrenschwanden: Bernstrasse 1 (OSM) | OSM Overpass | ODbL | V (OSM only) |
| Kanton Bern Asyl und Flüchtlinge portal | Canton's asylum pages; no location dataset found | https://www.asyl.sites.be.ch | HTML | - | U (only seen in search results) |

Do not scrape/guess addresses of private asylum accommodations. Only list centres the SEM publishes.

## 3. Food and cheap food

| Name | What | Address / phone / hours | Data source | Format / licence | V |
|---|---|---|---|---|---|
| Sleeper Gassenküche | Warm menu daily from 18:00, CHF 5 | Neubrückstrasse 19, 031 301 64 04 | uf dr Gass PDF | PDF | V |
| La Prairie | Lunch CHF 5, Tue-Fri 10-15 | Sulgeneckstrasse 7, 031 313 03 63 | uf dr Gass PDF | PDF | V |
| Azzurro | Café + meal CHF 7 (Mo, We, Th, Fr from 11:30; Sun from 15:00); first Monday of month free soup 18:00 | Lindenrain 5, 031 305 73 53 | uf dr Gass PDF | PDF | V |
| Casa Marcello | Mo-So from 15:00 | Aarbergergasse 19, 031 311 30 26 | uf dr Gass PDF | PDF | V |
| La Gare (alcohol meeting point) | Meal ~13:30 (register by 12:00), menu CHF 5, soup+bread CHF 2 | Perronplatte/Kurzparking Bahnhof, 031 311 81 06 | uf dr Gass PDF | PDF | V |
| Dock 8 | Mo-Fr day space; PINTO Sunday free meal 17:30 | Holligerhof 8, 3008 Bern, 076 348 41 97 | uf dr Gass PDF | PDF | V |
| Offene Kirche Heiliggeist | Free coffee/tea | Bahnhofplatz, 031 370 15 52 | uf dr Gass PDF | PDF | V |
| Café Mazay | Tue-Fri 14-18 | Beundenfeldstr. 13 | uf dr Gass PDF | PDF | V |
| "Im Hof" outdoor meal | Saturday 14:00-16:00 | Hodlerstrasse 22 (next to AST) | uf dr Gass PDF | PDF | V |
| Sonntags z'Nacht (PINTO/Stadt) | Free hot meal, Sunday from ~17:40 | at Dock 8 | uf dr Gass PDF | PDF | V |
| Medina Schützenmatte | Community centre; meals, medical and social advice, for people in need incl. sans-papiers; Do/Fr 18-22 | Schützenmatte; medina@immerda.ch | uf dr Gass PDF + church directory | PDF | V |
| Solidaritätsnetz Bern | Mittagstisch for asylum seekers (Mo, We, Th office) | Quartiergasse 12, 3013 Bern, 031 991 39 29 | church directory | PDF | V |
| Gassenbus | Wed from 20:00, Hodlerstrasse (Kunstmuseum) | - | uf dr Gass PDF | PDF | V |
| Caritas-Markt Bern | Discount supermarket for people with low income (Kulturlegi / Caritas card). Annual report 2025 says it moved to larger premises in 2025, but Caritas page still shows below address | Könizstrasse 19a, 3008 Bern, 031 302 81 80 (hours not on page) | https://caritas-regio.ch/ueber-caritas/bern ; https://caritas-regio.ch/angebote/guenstiger-leben/caritas-markt | HTML | V (address as published, check hours) |
| Tischlein deck dich | Rescued food for CHF 1/week; needs card issued via a Sozialfachstelle. Only an interactive map exists (no list, no CSV): https://www.tischlein.ch/de/lebensmittel-erhalten#karte | no Bern addresses extracted | tischlein.ch | JS map | V (process), Bern points U |
| Madame Frigo community fridges | Free food sharing fridges, 14 `amenity=food_sharing` objects in OSM bbox, most tagged `operator=Madame Frigo` | in OSM | OSM | ODbL | V |
| Schweizer Tafel | Rescued food distribution; Bern-specific outlet not checked | - | - | - | U |

## 4. Clothing and second hand

| Name | What | Address | Data source | V |
|---|---|---|---|---|
| Heilsarmee brocki.ch Bern | Second-hand store, Mo-Fr 09:00-18:30, Sa 09:00-17:00 | Bümplizstrasse 35, 3027 Bern | https://www.brocki.ch/de/filialen/bern/ | V |
| SRK Kanton Bern Secondhand-Shops ("La Trouvaille"), Sozialrabatt | Cheap goods; the only listed shop appears to be in Münsingen, not Bern city | Bernstrasse 33, 3110 Münsingen (U) | https://www.srk-bern.ch/de/unterstuetzung-im-alltag/bei-finanzieller-not/secondhand-shops | V (page exists), address U |
| HIOB Brockenstuben | Thunstrasse 103 (3006), Pappelweg 10 (3013), Wangenstrasse 57 (3018); HIOB also in OSM as `shop=charity` | as listed | web search snippet only | U |
| Emmaus Bern | Statthalterstrasse 10, 3018 | | web snippet | U |
| KulturLegi (Caritas) | Discount card, incl. Caritas-Markt | https://caritas-regio.ch/angebote/guenstiger-leben/kulturlegi | HTML | V (link only) |

No Caritas Kleiderbörse in Bern found. Free clothing specifically for newcomers: only Medina / Passantenhilfe / SRK Überbrückungshilfe (https://www.srk-bern.ch/de/unterstuetzung-im-alltag/bei-finanzieller-not/finanzielle-ueberbrueckungshilfe) found; no list.

## 5. Day centres, showers, washing

| Name | What | Address / phone / hours | V |
|---|---|---|---|
| Aufenthaltsraum (Stadt/Kirche) | Day room, free coffee/tea, soup Sat; Mo-Fr 08:30-11:00 / 14:30-16:30, closed Tue afternoon + Sun; closed from 16.12 | Mattenhofstrasse 32, 031 311 15 53 | V (PDF) |
| Punkt 6 (winter, Nov-Apr) | Coffee/tea, **showers, washing clothes**, internet, lockers, phone; Mo-So 06:00-10:00 and 17:30-22:30 | Nägeligasse (ex KODA) | V (PDF) |
| Gassendusche, Brasserie Lorraine | Street shower CHF 2; Tue-Sat from 09:00, Sun from 10:00 | Quartiergasse 17, 031 332 39 29 | V (PDF) |
| Passantenheim Heilsarmee | Washing machine for guests | Muristrasse 6 | V (PDF) |
| Contact Anlaufstelle | Day centre for drug users, hygienic consumption rooms; Mo-Fr 12:30-20:00, Sun/holidays 16:00-20:00 | Hodlerstrasse 22, 031 310 06 50 | V (PDF) |
| PINTO, KGB Gassenarbeit | Street outreach and advice | PINTO Schwarztorstrasse 23, 031 321 75 54; KGB Sennweg 6, 031 312 38 68 | V (PDF) |
| Blaues Kreuz, Berner Gesundheit | Addiction counselling | Zeughausgasse 39, 031 311 11 56; Eigerstrasse 80, 031 370 70 70 | V (PDF) |

OSM has 45 `amenity=shower` objects and 3 `shop=laundry` in the bbox, but these are generic (pools, camping, etc.; not checked per object). Punkt 6 and Gassendusche are not identifiable as such.

## 6. Legal help

| Name | What | Address / phone | Data source | V |
|---|---|---|---|---|
| Rechtsberatungsstelle für Menschen in Not (RBS Bern) | Legal advice/representation: asylum, social assistance, discrimination, short advice on aliens law. Short advice Mo-Thu 9-12 by appointment (Stadt list, Jan 2024) | Eigerplatz 5, 3007 Bern, 031 385 18 20, info@rbsbern.ch | church directory (V PDF); hours from search snippet (U) | V (contact) |
| Berner Beratungsstelle für Sans-Papiers | Advice for undocumented people | Monbijoustrasse 31, 3011 Bern, 031 382 00 15, beratung@sanspapiersbern.ch | church directory | V |
| Solidaritätsnetz Bern | Legal and social advice, rejected asylum seekers, sans-papiers | Quartiergasse 12, 3013 Bern, 031 991 39 29 | church directory | V |
| isa Bern (Fachstelle Migration) | Counselling incl. rejected asylum seekers; walk-in Mo-Thu 16-18 | Speichergasse 29, 3011 Bern, 031 310 12 72 | search snippet | U |
| Beobachtungsstelle für Asyl- und Ausländerrecht | Info/analysis, referral | Hallerstrasse 58, 3012 Bern, 031 381 45 40 | church directory | V |
| humanrights.ch | Umbrella, legal counselling networks | Hallerstrasse 23, 031 302 01 61 | church directory | V |
| Solidarité sans frontières | Policy/information | Schwanengasse 9, 3011 Bern, 031 311 07 70 | church directory | V |
| AsyLex | Free online legal aid for asylum seekers, Zürich-based, no Bern office | https://www.asylex.ch, Gotthardstrasse 52, 8002 Zürich | search snippet | U |
| Freiplatzaktion | Only Basel found; **no Bern Freiplatzaktion found** | - | - | U (not found) |
| Caritas Bern Rechtsberatung / Sozialberatung | https://caritas-regio.ch/angebote/soziale-rechtliche-unterstuetzung/rechtsberatung (page linked, content not read) | Zähringerstrasse 25, 3012 Bern, 031 378 60 00 | caritas-regio.ch | V (contact) |
| Rechtsauskunftsstellen in der Stadt Bern (city list, Jan 2024) | Official list; the PDF URL returned 404/HTML to my fetch, so only used via snippet | https://www.bern.ch/politik-und-verwaltung/stadtverwaltung/sk/bereich-recht/downloads/rechtsauskunftsstellen-in-der-stadt-bern.pdf | PDF | U |
| SEM list of Rechtsberatungsstellen | https://www.sem.admin.ch/dam/sem/de/data/asyl/verfahren/liste-rechtsberatungsstellen-d.pdf (not retrievable, returned 14 bytes) | | | U |

## 7. Red Cross (SRK Kanton Bern), Caritas Bern

| Name | What | Address / phone | Source | V |
|---|---|---|---|---|
| SRK Kanton Bern (HQ) | Integration, Secondhand, Sozialrabatt, Überbrückungshilfe, SESAM education. Phone Mo-Th 8:30-11:30 + 13:30-16:00, Fr 8:30-11:30 | Bernstrasse 162, 3052 Zollikofen, 031 919 09 09 | https://www.srk-bern.ch | V |
| Caritas Bern | Caritas-Markt, KulturLegi, interpreting, work integration, advice | Zähringerstrasse 25, 3012 Bern, 031 378 60 00, info@caritas-bern.ch | https://caritas-regio.ch/ueber-caritas/bern | V |
| HEKS Regionalstelle Bern | Integration, German courses | Bärenstrasse 12, 3007 Bern, 031 385 18 40 | church directory | V |

## 8. Medical care for undocumented, mental health

| Name | What | Address / phone | Source | V |
|---|---|---|---|---|
| Gesundheitsversorgung für Sans-Papiers (GVSP), SRK, at Ambulatorium SRK | Medical care for undocumented people. Note: "Meditrina" is the **Zürich** equivalent, not Bern | Werkstrasse 16 or 18 (sources disagree), 3084 Wabern; OSM has SRK at Werkstrasse 16 | web search snippets; OSM confirms Werkstrasse 16 SRK office | U (house number, hours) |
| Ambulatorium für Folter- und Kriegsopfer SRK | Trauma/mental health for torture and war victims | Werkstrasse 16, 3084 Wabern | search snippets; OSM | U |
| Medina Schützenmatte | Medical + social advice, sans-papiers welcome | see section 3 | church directory | V |
| City Notfall Bern | Walk-in emergency/medical; also for violence victims | Schanzenstrasse 4a, 3008 Bern, 031 326 20 00 | Kanton emergency card (PDF fetched) | V |
| Inselspital Notfallzentrum | Emergency | Freiburgstrasse 16c, 3010 Bern, 031 632 24 02 | same card | V |
| Dargebotene Hand | 143 (24/7), national; multilingual claim not verified | - | emergency card (V for number) | V |
| Pro Juventute | 147 (youth) | - | emergency card | V |
| Psychiatric emergency list | www.psy.ch | | emergency card | V |
| Selbsthilfe BE Beratungszentrum | Mental health self-help | Bollwerk 41 (OSM) | OSM | V (OSM) |
| Migesplus (info in many languages) | Right to medical care for sans-papiers, confidentiality | https://www.migesplus.ch/en/publications/right-to-receive-medical-care-for-sans-papiers | HTML | U (snippet) |

No Bern refugee-specific psychotherapy directory found. Only the SRK Ambulatorium. Gap.

## 9. Women's shelters / domestic violence (addresses are secret, list hotlines only)

Frauenhäuser in Bern and Thun keep their addresses secret. **Do not put any address on the map.** Source: Kanton Bern emergency card https://www.big.sid.be.ch/content/dam/big_sid/dokumente/de/startseite/publikationen/notallkarten/notfallkarte-faltblatt-deutsch-franz%C3%B6sisch-englisch.pdf (fetched, DE/FR/EN, V). More info: https://www.hallo-bern.ch/de/haeusliche-gewalt (20 languages).

| Service | Number | V |
|---|---|---|
| Police / Ambulance | 112 or 117 / 144 | V |
| AppElle! Frauenhäuser hotline (24h/7) | 031 533 03 03 | V |
| Opferhilfe Bern (all persons, confidential, free) | 031 370 30 70 | V |
| Fachstelle Häusliche Gewalt, Stadt Bern | 031 321 63 02 | V |
| Nationale Opferhilfe | 142 | U (search snippet) |
| Lantana (after sexual violence) | 031 313 14 00 | V |
| Inselspital Frauenheilkunde (sexual violence, women/girls 16+) | 031 632 10 10 | V |
| Berner Interventionsstelle (for perpetrators) | 079 308 84 05 | V |
| Dargebotene Hand / Pro Juventute | 143 / 147 | V |

The city's Frauen/FINTA-Notschlafstelle (Kursaalstrasse 6) is for homeless FINTA persons and its address is published by the city. Distinct from DV refuges, but still treat with care in-app.

## 10. Datasets and APIs: what actually exists

| Source | Finding | URL | Format / licence | V |
|---|---|---|---|---|
| opendata.swiss (CKAN API) | Queried `package_search` for Asyl, Sozialeinrichtung, Notschlafstelle, Obdach, Sozialdienst, Gesundheitseinrichtung etc. **No Bern dataset for shelters, food, clothing, legal aid or refugee services.** Needs a browser-like User-Agent (curl default gets 403) and `ckan.opendata.swiss` host | https://ckan.opendata.swiss/api/3/action/package_search | JSON API | V |
| Stadt Bern on opendata.swiss | Org slugs `geoinformation-der-stadt-bern` (historic maps), `statistik-stadt-bern`. No social POIs | https://opendata.swiss/en/organization/stadt-bern | - | V |
| Kanton Bern AGI: Spitäler und Kliniken | Hospital/clinic points, weekly update, open terms | https://geofiles.be.ch/geoportal/pub/download/SPITAL/spital_spitklin.parquet (also .gpkg.zip, .zip) | Parquet/GPKG/SHP; `opendata.swiss/terms-of-use#terms_open` | V |
| Kanton Bern AGI: Standorte Alter und Behinderung (ILV) | Elderly/disability care sites (not relevant to newcomers) | https://geofiles.be.ch/geoportal/pub/download/ILV/ilv_stoalter.parquet | same | V |
| Kanton Bern AGI: NFFS Sozialdienste | Social service districts/locations (`nffs_sozd.parquet`), possibly the Sozialdienst offices | https://geofiles.be.ch/geoportal/pub/download/NFFS/nffs_sozd.parquet | same | V (listed), content not inspected |
| Kanton Bern AGI: Regionale Jugendanwaltschaften, Offene Kinder- und Jugendarbeit | Youth-related, marginal | opendata.swiss search | same | V (listed) |
| SEM / BFS | Statistics only (asylum numbers), no locations | opendata.swiss `2-30-Flu` etc. | CSV | V (titles) |
| Basel-Stadt "Notfalltreffpunkte", "Secondhand-Angebote" | Shows the kind of dataset that Bern lacks; Basel only | opendata.swiss | CSV | V (titles) |
| sozialinfo.ch | Jobs, courses, legal knowledge base; **no service directory/API seen** | https://www.sozialinfo.ch | - | V |
| bern.ch Sozialwegweiser 60plus | Elderly-oriented PDF, not for newcomers | https://bern.ch/sozialwegweiser | PDF | U |
| "Bern hilft" / 211-style directory | Nothing found for Bern. (Switzerland has no 211.) | - | - | U (not found) |
| Stadt Bern map (map.bern.ch) social layer | Not checked | - | - | U |

## 11. OSM coverage

Overpass note: `overpass-api.de` and other main mirrors **timed out from this machine** (curl/PowerShell). Counts below come from **https://overpass.osm.ch/api/interpreter**, which works intermittently (retry on "duplicate_query"/"dispatcher" errors). Its `timestamp_osm_base` field looked odd ("118620"), so freshness unverified. Bbox `(46.9,7.34,46.99,7.5)` (covers Bern city plus parts of Köniz, Ostermundigen, Ittigen, Muri).

Query pattern (counts via `out count;`; `nwr` = node/way/relation):

```
[out:json][timeout:50];nwr["amenity"="social_facility"](46.9,7.34,46.99,7.5);out count;
```

| Tag | Count | Note |
|---|---|---|
| `amenity=social_facility` | 70 (40 n / 27 w / 3 r) | mostly elderly/disability; see below |
| `social_facility=shelter` | **3** | Sleeper, Kollektivunterkunft Herrenschwanden (SRK), Kollektivunterkunft Tiefenau |
| `social_facility=food_bank` | **0** | |
| `social_facility=soup_kitchen` | **0** | |
| `social_facility=outreach` | 2 | Pro Senectute + 1 |
| `social_facility=ambulatory_care` | 5 | Spitex etc. |
| `social_facility=assisted_living` / `group_home` / `nursing_home` | 16 / 11 / 22 | not relevant |
| `amenity=shelter` | 266 | **Pitfall: bus stops, picnic huts, bike shelters. NOT homeless shelters.** Never use for this feature |
| `amenity=shower` | 45 | generic, unchecked |
| `amenity=drinking_water` | 33 | |
| `amenity=toilets` | 165 | |
| `shop=second_hand` | 31 | |
| `shop=charity` | 3 | HIOB, Brockenstube Ittigen, Trödelecke |
| `shop=laundry` | 3 | |
| `amenity=washing_machine` | 0 | |
| `amenity=food_sharing` | 14 | Madame Frigo fridges |
| `amenity=clinic` / `doctors` / `hospital` / `pharmacy` | 21 / 66 / 10 / 55 | good coverage for general health |
| `office=ngo` | 23 | includes SRK Werkstrasse 16, Kirchliche Gassenarbeit, humanrights.ch, La Prairie, Triio |
| `office=lawyer` | 22 | private lawyers, not pro bono |
| `amenity=community_centre` / `social_centre` | 34 / 4 | Quartiertreffs, handy for newcomers |
| `healthcare=counselling` / `psychotherapist` | 3 / 5 | |
| `government=migration` | 1 | SEM |
| `amenity=give_box`, `building=refugee_housing` | 0 / 0 | |
| `office=association` | 39 | |
| `tourism=hostel` | 5 | |

`amenity=social_facility` entries that matter (name | `social_facility` | `for`): Sleeper | shelter | homeless; Passantenheim Heilsarmee (no sub-tag); Kollektivunterkunft Herrenschwanden | shelter | refugees; Kollektivunterkunft Tiefenau | shelter | refugee; La Prairie | underprivileged; Pulferstube; Blaues Kreuz; Selbsthilfe BE | advice | mental_health; familintreff bern; Berner GenerationenHaus; benevol. Many have no address and some lack `social_facility` sub-tag.

**Missing from OSM entirely:** Gassenküche as soup_kitchen, Azzurro, Casa Marcello, Dock 8, Punkt 6, Gassendusche, Caritas-Markt, Tischlein, Frauen/FINTA-Notschlafstelle, RBS, Sans-Papiers Beratung, Medina, GVSP. Coverage of relevant services is roughly 10-20%, so OSM can only supply a few points plus generic health/second-hand shops.

## 12. Gaps / recommendation

**Pull from data (automatic):**
- OSM (Overpass, ODbL, attribute): clinics/doctors/hospitals/pharmacies, `shop=second_hand|charity`, `amenity=community_centre|social_centre`, `amenity=food_sharing` (Madame Frigo), `amenity=drinking_water|toilets`, `office=ngo` after name filter. Optionally contribute the hand-curated missing places back to OSM.
- Kanton Bern AGI Parquet/GPKG "Spitäler und Kliniken" (open terms) as hospital source/cross-check. Inspect `nffs_sozd.parquet` for Sozialdienst locations.
- SEM page for BAZ Bern/Kappelen (2 points, stable).

**Hand-curate (one JSON file, ~40-60 rows; fields: id, category, name, address, lat/lon, phone, hours, price, languages, source_url, source_date, verified_date):**
- Everything in sections 1, 3, 5, 6: take it from the "uf dr Gass" PDF (Version 01.26) and the church migration directory PDF. Geocode with Nominatim. These are the only structured-ish lists, and both are PDFs. Re-verify by phone/website for hours, as winter closures (Punkt 6 Nov-Apr, Aufenthaltsraum closed from 16.12) change.
- Caritas-Markt (confirm new address/hours), Tischlein deck dich (read the map's JSON network calls or ask kundenkarten@tischlein.ch; map has no download), GVSP/Ambulatorium Wabern house number, Pluto, isa Bern, HIOB/Emmaus.
- Domestic violence: **hotlines only, no coordinates**. Treat Frauenhaus locations as never-shown.

**Biggest gaps:**
1. No machine-readable Bern directory of shelters/food/legal help (opendata.swiss, Stadt Bern, Kanton, sozialinfo.ch checked). Stadt Bern's list is a PDF updated by hand.
2. Opening hours/seasonal changes (winter shelter opening, Tiefenau closed, 2026/27 plans unknown).
3. Newcomer-specific free clothing, language-specific mental health, and medical care for sans-papiers have no verified public contact details/hours (GVSP, Ambulatorium Wabern U).
4. Tischlein deck dich locations in Bern not extractable without scraping the map.
5. Licence: city PDFs carry no explicit licence. Attribute, and ask Stadt Bern (bss@bern.ch / PINTO) for permission or for the source spreadsheet. Better: partner with the city, they might share data.

**Practical for tomorrow:** build the app against a local `services.json`; seed it from the PDFs (verified rows in this document), merge OSM health/second-hand layers at build time, show `last_verified` per row, and show a "call to confirm" notice.
