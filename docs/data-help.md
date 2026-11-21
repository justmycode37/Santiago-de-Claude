# Help data: needs with no open dataset (`data/help.json`, `data/fares.json`)

Checked on 2026-11-21. Rebuild with `node tools/build-help.mts` (writes `data/help.json`; needs internet for the two
live feeds and swisstopo geocoding). `data/fares.json` is written by hand.

## What `data/help.json` contains

94 items, one per place, phone line or link-out. Each item has `source_url`, `source_checked` and `confidence`; unknown = `null`.

| category | n | main source |
|---|---|---|
| food_distribution | 11 | Tischlein deck dich operator feed (10 points, Bern + Liebefeld, Ostermundigen, Zollikofen, Worb), "uf dr Gass" leaflet |
| free_meal | 1 | leaflet (PINTO Sunday meal at Dock 8) |
| public_fridge | 15 | Madame Frigo locations page (Bern + Hinterkappelen) |
| day_centre / outreach | 4 / 2 | leaflet (Café Mazay, Contact, Gassenbus, KGB Gassenarbeit, PINTO, La Strada) |
| shelter | 1 | leaflet + city press release (Frauen/FINTA-Notschlafstelle) |
| free_showers | 1 | PINTO shower/locker flyer |
| health_mental / health_free / health_emergency | 1 / 2 / 2 | SRK page, leaflet, bern.ch/notfaelle |
| hotline / pharmacy_on_duty | 6 / 1 | bern.ch/notfaelle, toxinfo.ch, Rechtsauskunft PDF (gggfon) |
| legal_advice | 9 | "Rechtsauskunftsstellen in der Stadt Bern", Ausgabe Oktober 2026 (PDF) |
| language_courses | 19 | Kanton Bern course finder, 13 DeutschBon schools (bern.ch), 5 low-cost offers (old city PDF) |
| discount | 3 | DeutschBon, KulturLegi flyer 2025, Caritas-Markt rules |
| admin_help | 2 | writing help for letters/forms (old city PDF) |
| toilets_partner | 12 | "Nette Toilette" city flyer (2018) |
| phone_charging | 1 | nau.ch article (Westside lockers) |
| banks | 1 | link-out only, no list |

`counts` in the file is the live per-category count.

Extra fields: `opening_hours_osm` (OSM syntax, only where the text was unambiguous), `licence_unclear: true` on the
Tischlein and Madame Frigo rows (neither site states a licence; we read their own public map data).

### Overlap with `data/offices.json`

No row of offices.json is repeated. Instead `offices_supplement` adds what offices.json lacks, keyed by its id:
hours for aufenthaltsraum, azzurro, casa-marcello, la-gare, dock8, la-prairie, heiliggeist, sleeper-kueche, medina,
sleeper, passantenheim, passantenhilfe, punkt6 (Nov-Apr), gassendusche, sozialdienst (from the leaflet); gvsp (SRK
sans-papiers walk-in hours, phone, CHF 10 first visit), caritas-markt (shop hours), isa, rbs, sans-papiers (from the
Rechtsauskunft PDF), city-notfall, insel-notfall (bern.ch). The build fails if a supplement id is missing from offices.json
or an item id clashes with one.

`data/services.json` (another build) also has the Schlichtungsbehörde Bern-Mittelland as a `conciliation_office`;
here it is kept as `schlichtungsbehoerde-bern` because the item is about the free legal-advice phone line. Other
address matches with services.json are only co-locations (food points inside churches), not duplicates.

Conflicts found: the city page gives Inselspital emergency at **Rosenbühlgasse 27**, offices.json has Freiburgstrasse 16c.
offices.json `gvsp` merges two SRK services; the trauma clinic is a separate item here (`srk-ambulatorium-folter-kriegsopfer`).

## Sources (all read on 2026-11-21)

- "uf dr Gass" leaflet, Stadt Bern / PINTO: file name "Vs 09_25", content says "Version 01.26".
  https://www.bern.ch/politik-und-verwaltung/stadtverwaltung/bss/familieundquartier/pinto-pravention-intervention-toleranz/downloads/downloads-2/uf%20dr%20Gass%20Vs%2009_25.pdf
- PINTO shower/locker flyer (same downloads folder).
- Rechtsauskunftsstellen in der Stadt Bern, Ausgabe Oktober 2026 (Stadtkanzlei).
- bern.ch: Notfälle, Deutsch lernen, DeutschBon, Teilnehmende Deutschschulen, Angebotskompass "Sprache" PDF, FINTA press release (17 Jun 2025), Nette Toilette press release (11 Jul 2018) and flyer.
- redcross.ch: Sans-papiers health care page; Ambulatorium für Folter- und Kriegsopfer page.
- Tischlein deck dich: https://kkonlinerestapi.tischlein.ch/abgabestelle (feed behind tischlein.ch/de/lebensmittel-erhalten).
- Madame Frigo: https://www.madamefrigo.ch/de/standorte/ (fridge list in the HTML).
- KulturLegi Kanton Bern flyer 2025 and partner-commune page (Stadt Bern is a partner commune); caritas-regio.ch (Caritas-Markt rules); caritas-markt.ch (Bern shop hours).
- toxinfo.ch; Kanton Bern course finder https://www.weiterbildung-kurse.apps.be.ch/sprachkurs.
- Fares: mylibero.ch (Einzelbillette, Kurzstrecke, Tageskarte Bern, Mehrfahrtenkarte, Abo Bern, FAQ, Tarifinfos, "einfach" apps page, Verkauf & Beratung); bernmobil.ch (Fahrausweiskontrolle, Ticketautomaten, Verkaufsstelle, Vergünstigungen, öV Plus App, E-Ticket); bls.ch press release 7 Oct 2025 (cashless machines); sbb.ch Halbtax page.

## Confidence

- **high**: official or operator page read today and dated 2025-2026 (bern.ch, SRK, Rechtsauskunft PDF Oct 2026, Tischlein feed, Libero/Bernmobil/BLS/SBB).
- **medium**: the leaflet (Jan 2026, small print, a few typos), Madame Frigo (volunteer-run; 2 pins used where the address is not a real swisstopo address), FINTA shelter (see below).
- **low**: undated or old: Angebotskompass "Sprache" PDF (lists isa at an old address, so outdated), Nette Toilette flyer (2018), Westside charging lockers (undated news article), banks overview (2022, third party).

## Things to know

- **FINTA-Notschlafstelle**: the June 2025 press release said the Kursaalstrasse 6 site was a temporary use "vorerst bis Ende April 2026"; the Jan 2026 leaflet still lists it. Confirm before showing it as open.
- **Leaflet times**: the PINTO Sunday meal is given as both 17:30 and 17:40; Aufenthaltsraum note "Ab 16.12 geschlossen" (year unclear).
- **Unia**: the PDF table columns are misaligned, so hours and member rules are left `null`.
- **academia languages**: two different phone numbers on bern.ch (+41 58 440 90 80 vs 80 90); the detail page value is used.
- **Tischlein deck dich**: you need a customer card from a social agency; the per-visit fee amount is not on the site.
- **Schweizer Tafel**: not included. Its site says it does not give food to individuals; it supplies institutions (Gassenküchen, Abgabestellen, shelters).
- **Domestic violence**: no shelter addresses. Hotlines are in offices.json; the Rechtsauskunft PDF also lists Frauenhaus Bern phone 031 332 55 33 (not added).
- **Pharmacy on duty**: phone 0900 98 99 00 (CHF 0.98/min) plus link to notfall-finder.ch; no rota stored.
- **Fares**: national prices change on 13 Dec 2026 (SBB shows new Halbtax prices: 195/175). Libero had not published new prices on 21 Nov 2026, so **re-check fares.json after 13 Dec 2026**. Bernmobil machines take coins, contactless cards and TWINT; BLS machines are cashless (prepaid card bought with cash at BLS counters). Fines (Bernmobil): CHF 100/140/170 without a ticket, 75/115/145 with a partly valid ticket.

## Not found (gaps)

- **Free clothing**: no current source for free clothing in Bern (only paid second-hand shops and donation pick-ups). Ask PINTO or the Sozialdienst.
- **Free community meals**: beyond the leaflet (PINTO Sunday meal, Azzurro's monthly free soup), no other recurring free meal with a current source. The Angebotskompass "Gesellschaft" PDF lists low-cost (not free) lunches; not added.
- **Phone charging**: no official source; only the old Westside article. Punkt 6 lists "Telefon" (phone use), not charging.
- **Notschlafstelle for everyone, winter 2026/27**: the city said it was looking for a new site; no current address found.
- **Meditrina-type clinic**: that model is Zurich; in Bern the SRK sans-papiers service (offices.json gvsp) is the equivalent.
- **Interpreters**: Comprendi is already in offices.json; nothing new added.
- **KulturLegi public-transport discount**: none listed. No refugee- or asylum-specific fare found.
- **Banks for N/F/S**: link-out only. Rules vary by bank and change; the only overview found is from 2022.
- Tischlein/Madame Frigo licence: not stated; marked `licence_unclear`.
