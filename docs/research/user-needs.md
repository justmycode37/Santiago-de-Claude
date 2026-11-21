# User needs and competitor evidence: newcomer transit app, Bern

Research date: 21 Nov 2026. Tag legend: **VERIFIED** = I read the page/PDF and the number is in it. **UNVERIFIED** = from a search-result snippet or memory only; check before putting on a slide.

Important honesty note up front: I found NO study measuring fare evasion among migrants in Switzerland, and NO Swiss-specific smartphone-use study for refugees. The pitch must therefore combine (a) hard Swiss numbers on who lives here and what fines cost, and (b) foreign studies on what refugees do with phones. Do not claim "newcomers get fined more often" - nobody has shown it.

---

## 1. Who the users are, and what they need (evidence)

### 1a. Which languages to support (numbers)

| Fact | Number | Source | Status |
|---|---|---|---|
| Asylum applications in Switzerland, 2025 | 25,781 (-7.1% vs 2024) | SEM press release 19 Feb 2026: https://www.sem.admin.ch/de/newnsb/iiAHV0k5TFjK | VERIFIED |
| Top origins 2025 | Afghanistan 6,207; Eritrea 3,415 (+63.2%); Türkiye 2,534 (2024: 4,107); Algeria and Somalia also in top 5 (no figures on that page); Horn of Africa total 6,378 (SEM snippet, via search) | same page; Horn of Africa figure: SEM search snippet, https://www.sem.admin.ch/de/newnsb/iiAHV0k5TFjK | VERIFIED (first 3), UNVERIFIED (Horn total) |
| Ukrainians with Status S, end 2025 | 71,762 (68,070 end 2024); 12,897 Status S applications in 2025 | same SEM page | VERIFIED |
| Nearly 2/3 of 2025 applications from Afghan, Eritrean, Turkish, Algerian, Somali nationals | "beinahe zwei Drittel" | SEM search result summary (same press release family) | UNVERIFIED wording |
| SEM expects further slight decline in 2026 | - | SEM search snippet | UNVERIFIED |

Foreign residents of the **City of Bern** (Statistik Stadt Bern, end 2025; I extracted these from the PDF tables and cross-checked sums: Asia 5,331, Africa 3,188):
- Total 146,867 residents (UNVERIFIED, from search snippet); 37,004 foreign nationals (VERIFIED); foreign share 25.2% (UNVERIFIED snippet; 25.1% end 2024).
- By nationality: Germany 6,172; Italy 3,899; **Ukraine 2,217 (3rd largest group, +15.8% in a year)**; Spain 2,013; Portugal 1,366; Türkiye 1,244; Kosovo 1,056; N. Macedonia 1,059; Austria 725 (column alignment in the PDF text is slightly ambiguous for the small European countries; the big ones are consistent with the text report); **Eritrea 943** (25 in 2000); **Afghanistan 799**; China 721; Sri Lanka 652; Syria 608; Somalia 484 (Asia block order read from the PDF: Afghanistan, China, Sri Lanka, Syria, other Asia 2,551; sum matches 5,331).
- Sources: https://www.bern.ch/themen/stadt-recht-und-politik/bern-in-zahlen/katost/01bev/jahresdaten/t-01-05-020-auslandische-wohnbevolkerung-nach.pdf and https://www.bern.ch/themen/stadt-recht-und-politik/bern-in-zahlen/publikationen/2026-2030/download-2026-2030/2026-01-27-bev-2025-b.pdf . VERIFIED for Ukraine, Eritrea, Germany, Italy, 37,004, 71.8% European. The PDF text extraction mis-aligned a few column labels in the Asia block (Afghanistan/China/Sri Lanka/Syria); treat 799 / 721 / 652 / 608 (Afghanistan, China, Sri Lanka, Syria) as "check the table" and do not quote country-level Asian numbers on a slide without opening the PDF.
- **Caveat for pitch:** this counts *nationals*, not language speakers, and excludes people already naturalised and asylum seekers housed in collective centres registered elsewhere. It is a floor, not the target market.

**Language shortlist implied by the data (my inference):**
1. English (lingua franca; also covers expats), 2. Ukrainian (Status S; Bern's #3 group), 3. Arabic (Syria, plus Eritrea/Somalia/Sudan speakers), 4. Tigrinya (Eritrea: 3,415 new applications 2025, +63%; 943 residents in Bern), 5. Dari/Farsi (Afghanistan 6,207), 6. Turkish/Kurdish (Türkiye 2,534; 1,244 residents), 7. Somali, 8. Tamil (Sri Lanka, 652 residents). Realistic hackathon scope: English + Ukrainian + Arabic + Tigrinya + Dari, with the string table designed so any language can be added.
- Corroboration that these are the right languages: the federal SEM `integration-info` app offers 18 languages: Albanian, Arabic, Croatian/Serbian/Bosnian, German, English, Spanish, Farsi/Persian/Dari, French, Italian, Kurdish, Portuguese, Russian, Somali, Tamil, Tibetan, Tigrinya, Turkish, Ukrainian (https://migesplus.ch/en/publications/integration-info, VERIFIED). Use this as the ready-made language list, and note that Tigrinya, Dari, Kurdish, Somali are rare in commercial apps.
- Caution: Tigrinya, Dari and Kurdish machine translation is weak. Plan human-checked strings for the 20-30 core phrases (see section 5).

### 1b. What newcomers do with phones for navigation (foreign evidence)

- **Vienna, Syrian refugees (Kaufmann 2018):** the 5 most-named apps were Facebook, WhatsApp, **qando Wien (the Vienna public transport app)**, **Google Maps**, **Google Translate**; ~90 apps named, **none designed for refugees/immigrants**; GPS used to find their way despite limited language; **none said government or city had told them about helpful apps.** https://km4s.ca/publication/navigating-a-new-life-syrian-refugees-and-their-smartphones-in-vienna-2018/ - VERIFIED. Strongest "gap in the market" evidence: people improvise with general tools.
- **"Information precarity" (Wall, Campbell, Janbek 2017, New Media & Society 19(2):240-254):** Syrian refugees in a Jordanian camp; five forms of information precarity incl. limited technological/social access, irrelevant or dangerous content, surveillance. DOI 10.1177/1461444815591967 - UNVERIFIED (search snippet; camp context, not Europe). Use the *concept*, not the numbers.
- **Open University "Mapping Refugee Media Journeys" (2016):** phone as essential navigation, translation and networking tool; also exposes users to surveillance by smugglers/extremists. https://www.open.ac.uk/blogs/news/?p=3046 - UNVERIFIED (snippet).
- **Berlin survey of 83 Arab refugees "The Best, the Worst, and the Hardest to Find":** importance/difficulty of finding information and spotting misinformation. https://journals.sagepub.com/doi/10.1177/2056305118764428 - UNVERIFIED (snippet; I did not extract rankings).
- **UNHCR / Accenture "Connecting Refugees" (2016):** refugees spend up to a third of disposable income on connectivity; refugees 50% less likely than general population to have an internet-enabled phone; 29% of refugee households have no phone. Archived page returned a bot-check, so I could not read it. UNVERIFIED. Source: https://webarchive.archive.unhcr.org/20160930162244mp_/http:/www.unhcr.org/connectivity-for-refugees.html . These are 2016 global figures and likely overstate the gap for Switzerland; do not present as Swiss.
- **GSMA/UNHCR 2019:** affordability, literacy/digital skills and charging are the main barriers to mobile ownership/use; handset cost most cited. https://www.gsma.com/mobilefordevelopment/blog/the-digital-lives-of-refugees-how-displaced-populations-use-mobile-phones-and-what-gets-in-the-way/ - UNVERIFIED (snippet; camp/low-income-country settings).

### 1c. Transport barriers for refugees (best available European evidence)

- **Scotland, Mental Health Foundation (2023 survey of 222 refugees and people seeking asylum, published 2024):** **84% had been unable to afford public transport**; of those 49% could not afford it all or almost all the time; 66% stayed home, 65% walked, 27% borrowed money; 77% said free transport would affect their mental health; 78% wanted free transport for asylum seekers; 66% described staff interactions positively; 82% felt safe. https://www.mentalhealth.org.uk/our-work/research/journey-wellbeing-refugees-transport-and-mental-health - VERIFIED. Not Swiss, but the only quantified refugee-transport survey I could read. Note the page did *not* cover language or fear of fines.
- **Finland (Univ. Tampere):** cost is a major barrier for newly arrived immigrants; language difficulties and poor connectivity flagged by some. https://trepo.tuni.fi/handle/10024/225019 - UNVERIFIED (page blocked, claim from search snippet).
- **Frankfurt region study / Ukrainian women in Gdynia (n=95):** another ticketing system, other rules, language barriers disrupt routines; authors suggest multilingual information and ticketing guidance. https://etrr.springeropen.com/track/pdf/10.1186/s12544-019-0360-x and https://trid.trb.org/View/2707983 - UNVERIFIED (snippets). The Gdynia entry shows a publication date later than today; treat as preprint.
- **Gap:** I found no European study that directly measures fare evasion among migrants or tests whether language causes non-payment (search for "fare evasion migrants" in academic databases if time permits).

### 1d. Swiss-specific information-need evidence

- A Bern/Lausanne research group built the **Sui** self-help app (Swiss Red Cross / Univ. Bern), first for Arabic-speaking refugees in Switzerland, motivated by getting important information in their own language (https://selfhelp.psy.unibe.ch/sui/assets/Flyer.pdf, UNVERIFIED snippet). It is mental-health oriented, not transport.
- The SEM's own apps (asylum-info.ch, integration-info) cover asylum procedure, health, school, work, politics. **Neither page mentions public transport** (VERIFIED, pages read). That absence is the gap we fill.

---

## 2. Pain points in Swiss public transport for newcomers

### 2a. Fines (verified amounts)
- **Current surcharge (Zuschlag), Alliance SwissPass, reported Feb 2026:** 1st offence CHF 100, 2nd CHF 140, 3rd CHF 170; each includes a CHF 10 fare charge; partially valid ticket is CHF 25 less; criminal complaint possible after 3 offences within 2 years. https://lenews.ch/2026/02/06/continued-rise-in-number-of-fare-evaders-caught-on-swiss-public-transport/ - VERIFIED (secondary source quoting Alliance SwissPass). So the old "CHF 90" figure is outdated in most regions (SRF 2021 said 90 or 100 depending on region: https://www.srf.ch/news/panorama/fahren-ohne-billett-schwarzfahren-wird-teuer-gibt-aber-keinen-strafregister-eintrag, VERIFIED but dated). Say "CHF 100 for a first offence, 140, then 170" and cite SwissPass; note regional variation.
- **Volume:** 1.17 million passengers caught without valid or fully valid ticket in 2024, up from 1 million in 2023; rising every year since 2019; ~CHF 200 million lost revenue (same lenews article, VERIFIED). A search snippet says 1,173,295 caught in 2025 (SRF, UNVERIFIED).
- **A national fare-evader register exists** (run by Postauto, ~554,000 people in 2021); entries deleted after 2 years if paid; checking your entry requires an ID/passport copy (SRF 2021, VERIFIED).
- **Check-in is not automatic for data-protection reasons**: users must start and end check-in themselves (SRF 2021, VERIFIED). A newcomer using an EasyRide-style app who forgets to check out can be billed or fined.
- **Unpaid fines can lead to prison:** more than half of Swiss prison admissions are substitute custodial sentences (~5,000 people/year); the new association **Freiheitsfonds Schweiz** pays transport fines for penniless people; Gassenarbeit Bern reports people jailed several times a year for short trips without ticket; SBB files a criminal complaint only for repeat offences or non-payment. https://www.plattformj.ch/artikel/245478/ - VERIFIED. This is the strongest *human* argument for a "what ticket do I need, exactly" app: the downside of a mistake is large for people on low incomes.

### 2b. Tickets, payment, zones
- **BLS bus-stop machines (new generation)** accept debit/credit cards, Postcard, Twint, Reka, SwissPass Pay and the anonymous **ÖV Prepaid Card**, which is free at staffed sales points and top-up can be done in cash. I found no confirmation that Bernmobil/BLS stop machines take cash. https://www.bls.ch/de/fahren/fahrausweise/verkauf/bus - UNVERIFIED (snippet). A cash-only newcomer can therefore only buy via staffed points or the prepaid card; this is a pain point to verify with a transit worker.
- **Apps:** SBB Mobile saves credit card, Twint, Apple Pay, Reka, invoice via a SwissPass login (https://www.sbb.ch/de/hilfe-und-kontakt/mein-profil/zahlungsmittel-hinterlegen.html returned 403; claim from search snippet and SBB community forum, UNVERIFIED). Twint needs a Swiss bank account (general knowledge, UNVERIFIED), which many newcomers lack. BLS Mobil lists Apple Pay, Twint, Mastercard, Visa, PostFinance, Reka, Amex (https://apps.apple.com/ch/app/bls-mobil-fahrplan-tickets/id1146743800 snippet, UNVERIFIED).
- **Libero:** zone-based tariff association covering 26 operators in cantons Bern, Solothurn, Jura (https://www.sbb.ch/de/angebote/tarifverbund-libero, UNVERIFIED snippet). Bern city is zones 100/101 (from city council docs, UNVERIFIED). Zones are not intuitive to newcomers; "which ticket do I need for A to B" is exactly a computed problem our app can solve.
- **Discounts:** In Bern, **KulturLegi** gives at least 30% discount on health, sport, education, culture for people on Sozialhilfe, supplementary benefits, scholarships, IPV, or wage garnishment; free first year, CHF 20 to renew; ~4,200 partners (flyer 2025, VERIFIED: https://www.kulturlegi.ch/fileadmin/Media_KuLe/Schweiz/Dokumente/BE_Dokumente/Flyer_mit_Antragsformular_2025.pdf). **The flyer does not list public transport**, and does not name asylum seekers explicitly (refugees on Sozialhilfe qualify via Sozialhilfe). The Bern city council has considered free Libero for KulturLegi holders; the Gemeinderat is critical (answer dated 16 March 2026, https://www.bern.ch/politik-und-verwaltung/gemeinderat/aktuelle-antworten-auf-vorstosse/publizierte-antworten-am-16-maerz-2026/po-kostenloser-ov.pdf/at_download/file - UNVERIFIED snippet; I could not read it, file returned 404 on a second fetch). I found no ÖV discount specific to asylum seekers/refugees in Bern. Honest framing: our app should *show* the cheapest valid option (Halbtax, day pass, multi-trip) and flag KulturLegi where relevant, not claim a refugee ticket exists.
- **Existing multilingual PDF:** City of Bern's "ÖV-Tipps für Fremdsprachige" (explains Abo types in Turkish and presumably other languages) is dated 2016 and static (https://www.bern.ch/themen/mobilitat-und-verkehr/bus-tram-bahn/tippsoev/oev-tipps-fuer-fremdsprachige/ov-tipps-turk.pdf, VERIFIED that the Turkish PDF exists and explains Abo types). Shows demand and a gap: static, not routed, not about stops.

### 2c. Wayfinding pain points (hypotheses, NOT verified - good interview topics)
- Direction vs terminus: signs show the end-of-line name, not the destination; newcomers must know which terminus lies "that way". **UNVERIFIED, no source found.**
- Which side of the road / which stop edge (A/B/C/D "Kante" at Bern Bahnhof bus platforms and tram stops). **UNVERIFIED**; this is the team's core idea and should be validated by interviews and by checking GTFS/Swiss open data (opentransportdata.swiss) for platform/stop-position fields.
- Request stops ("Haltewunsch"/Halt auf Verlangen), board at front/back, validation/check-in. **UNVERIFIED**; I did not find a source in time.

---

## 3. Existing apps and why they fall short

| App | What it does | Languages | Shortfall for newcomers | Source / status |
|---|---|---|---|---|
| **SBB Mobile** | Timetable, tickets, EasyRide check-in, platform info (Gleis), map | German, English, French, Italian | No Arabic/Tigrinya/Ukrainian etc.; payment relies on card/Twint/SwissPass login; App Store rating 3.1/5 from 1,182 ratings, recent complaints about redesigned connection and map views; no stop-edge guidance for buses/trams in the description | https://apps.apple.com/ch/app/sbb-mobile/id294855237 - VERIFIED |
| **BLS Mobil / ÖV Plus / Bernmobil** | Regional tickets and timetables for Bern region (Libero) | BLS Mobil listing: German, English, French, Italian, Swiss German | Same language gap; no routing aids for tram/bus side | https://apps.apple.com/ch/app/bls-mobil-fahrplan-tickets/id1146743800 - UNVERIFIED snippet. I did not examine the Bernmobil app separately. |
| **Google Maps** | Door-to-door, global | Many languages | Real-time works but ticket cost/zone and Libero rules are not shown; no "which platform edge" in street-level detail (my assertion, UNVERIFIED) | - |
| **Moovit, Citymapper** | Multimodal routing | Moovit multilingual | I did not verify Swiss coverage or language list (UNVERIFIED). Check before claiming. | - |
| **UNHCR Help Switzerland** (help.unhcr.org/switzerland) | Static service directory for refugees; Ukrainian and Arabic versions exist; NGO list with language notes | Several (EN, UK, RU, AR) | Information site, not a mobility tool; blocked (403) so details UNVERIFIED | https://help.unhcr.org/switzerland/ ; snippets |
| **RefAid** | Maps nearby aid services (>5,000 providers), works offline; Arabic and Farsi for some services | partial | Not transit; coverage claim from a small-review App Store listing | https://apps.apple.com/us/app/refaid-refugee-aid-app/id1080936380 - UNVERIFIED |
| **Integreat** (Germany) | Offline-capable municipal info app + website + PDF; each municipality curates content; over 100 municipalities | municipality chooses | Only Germany named on the site; no Swiss city found. Good *model* (offline, municipality-owned content) | https://integreat-app.de/en/ - VERIFIED (that Switzerland is not mentioned) |
| **Ankommen** (Germany, BAMF et al.) | Arrival app, language course + asylum info | Arabic, Farsi, etc. (UNVERIFIED) | Not Swiss; not transit | UNVERIFIED, not researched |
| **asylum-info.ch app (SEM)** | Asylum procedure, centres, life in CH, health; read-aloud (webReader) and videos | 12 languages (not named on page) | No public transport content; offline not stated | https://www.sem.admin.ch/en/asylum-info-ch - VERIFIED |
| **integration-info (SEM web app, 2023)** | Life in Switzerland, school, work, health, politics; contact addresses | 18 languages incl. Tigrinya, Dari, Somali, Tamil, Ukrainian | No transport; read-aloud only "planned" | https://migesplus.ch/en/publications/integration-info - VERIFIED |
| **hallo-schweiz.ch** | Private German-only info site since 2001 (permits, insurance, tax) | German | No public transport page found | https://www.hallo-schweiz.ch - VERIFIED |
| **HelloUkraine.ch** | Tips for Ukrainians | DE, EN, UK, RU | Not transit | https://www.migesplus.ch/en/publications/hello-ukraine - UNVERIFIED snippet |
| **migraweb.ch** | Content written by 297 volunteer migrants, 16 languages (per crowdfunding page) | 16 | Domain would not resolve (ENOTFOUND) when I fetched it, so possibly offline; UNVERIFIED | https://wemakeit.com/users/web-for-migrants?locale=en |
| **AsyLex chatbots** | Legal info chatbots for asylum seekers; Afghanistan bot Farsi+English, Ukraine bot English+Ukrainian; handouts in EN/DE/FR/Farsi/Arabic/Tigrinya | see left | Legal, not mobility; useful as precedent for chatbot-with-guardrails | https://arxiv.org/html/2407.09197v3 and AsyLex pages - UNVERIFIED (snippets) |
| **Sui app (Red Cross / Uni Bern)** | Self-help mental health for Arabic-speaking refugees | Arabic first | Not transit | UNVERIFIED |

**Positioning in one line:** every Swiss newcomer app found is an *information portal*; none of the ones I read cover the daily act of getting on the right vehicle, in the newcomer's language, with ticket logic. Qualified: I did not test Moovit/Citymapper/Bernmobil in-app, so say "none of the Swiss newcomer-specific tools" rather than "no app".

---

## 4. Accessibility and digital constraints

- **Cost of connectivity:** UNHCR 2016 says up to a third of disposable income on connectivity (UNVERIFIED, global). In Switzerland, asylum seekers receive small cash allowances (Nothilfe/asylum social aid levels are low); I did not retrieve a Swiss figure. The Scotland study (VERIFIED above) shows daily ticket price vs weekly allowance is the central issue for UK asylum seekers (£49.18/week vs £5.60 day bus ticket).
- **Offline/PWA:** Integreat is explicitly offline-capable (VERIFIED) and RefAid works offline (UNVERIFIED). A PWA with cached stop pages and schedules (GTFS static) directly addresses prepaid/limited data; live data is a progressive enhancement.
- **Old/low-end phones:** GSMA/UNHCR: handset cost is the most cited barrier (UNVERIFIED, non-Swiss). Implication: keep bundle small (<1 MB shell target is my suggestion), no heavy map tiles by default, support Android Chrome of older versions, avoid WebGL maps; use pictograms and a simple line diagram of the stop.
- **Low literacy / non-Latin scripts:** SEM's asylum-info app offers read-aloud via webReader and videos (VERIFIED); integration-info only plans read-aloud (VERIFIED). So read-aloud is something the state sees as needed and has not fully shipped; use the browser Web Speech API where voices exist, but **Tigrinya text-to-speech is unlikely to exist on-device** (my assessment, UNVERIFIED) - fall back to recorded audio for the ~20 core phrases (e.g. "Does this bus go to X?"), recorded by native speakers in the room.
- **RTL:** Arabic, Dari, Farsi, Kurdish (Sorani) need right-to-left layout; Tigrinya (Ge'ez script) needs a font that renders (e.g. Noto Sans Ethiopic).
- **Trust/gov outreach gap:** in Vienna no interviewee had been told about helpful apps by authorities (VERIFIED) - distribution through social workers, language courses, WhatsApp/Facebook groups and a QR code at the stop is likely more effective than app stores.

---

## 5. Ethical considerations

- **Location privacy:** For asylum seekers, location history could in principle be misused (Open University notes phones expose refugees to surveillance, UNVERIFIED snippet; Wall et al. list state surveillance as a form of information precarity, UNVERIFIED snippet). Design: compute everything on-device, request geolocation only on tap (or not at all - allow manual "I am at stop X"), no accounts, no analytics identifiers, no cookies, no server-side logs of coordinates, no third-party SDKs (no Google Analytics/Fonts at runtime), open-source the code. Say so on screen in plain language and in each language.
- **Check-in and register:** the Swiss fare-evader register requires ID to query (VERIFIED), so people may fear authorities. We should *not* sell or store tickets; we should link out to official ticketing and explain rules, not collect identity.
- **AI hallucination for official info:** AsyLex built legal chatbots with guardrails and published their method (UNVERIFIED snippets). Principle for our app: **the AI/LLM must not be the source of truth** for fares, fines, permits. Use LLM only to translate pre-written, reviewed strings or to rephrase; show the official source and "last checked" date; fare numbers come from a versioned data file we maintain, not from generation. Machine translation of Tigrinya/Dari is the highest risk: label "machine-translated, check with a person" until a native speaker reviews; keep a human-reviewed core of ~20-30 strings.
- **Mis-guidance harm:** wrong platform side or wrong ticket => CHF 100 surcharge, possible criminal complaint after repeat, and substitute prison in extreme cases (all VERIFIED in section 2a). So the app should say "Buy ticket before boarding" prominently and not claim a ticket is valid.
- **Inclusion without stigma:** do not label users as "refugees" in the UI; the app is useful for tourists, expats and elderly too (Bern's foreign population is 25%, 72% European - VERIFIED), and the brand "for newcomers" avoids outing asylum status.
- **Data sources:** use open data (opentransportdata.swiss, check licence) and OSM; cite attribution (licence terms UNVERIFIED, not checked).

---

## Prioritised feature list

**MUST (demo-critical; each has evidence)**
1. **"Stand here" stop-edge/side guidance for the chosen route** (e.g. "Platform B, the side where buses go toward Bümpliz; the sign says 'Bümpliz Bahnhof'"). Evidence: nobody in the Swiss newcomer apps read covers it (section 3, VERIFIED absence); Vienna refugees rely on transit apps plus Google Maps (VERIFIED); direction/terminus confusion is a hypothesis to validate in interviews.
2. **UI in newcomers' languages, core set EN + Ukrainian + Arabic + Tigrinya + Dari, extensible.** Evidence: 71,762 Status S, Afghanistan 6,207, Eritrea 3,415 applications; Bern 2,217 Ukrainians, 943 Eritreans (all VERIFIED); SEM itself publishes 18 languages (VERIFIED).
3. **Offline-capable PWA, small download, no login.** Evidence: connectivity cost barriers (UNVERIFIED, global); Integreat offline model (VERIFIED); Vienna: no authority told refugees about apps - make it shareable by link/QR (VERIFIED).
4. **"Which ticket do I need" with Libero zone and plain price, plus a clear warning on fines.** Evidence: fines CHF 100/140/170, 1.17M caught in 2024 (VERIFIED, secondary source); prison consequences (VERIFIED); Bern's own 2016 Turkish Abo PDF shows ticket confusion is recognised (VERIFIED).
5. **Privacy by design: no accounts, location only on-device.** Evidence: section 5; Wall et al. and OU (UNVERIFIED snippets) plus hackathon "Ethical" score.

**SHOULD**
6. **Read-aloud / audio for core phrases and pictograms.** Evidence: SEM provides read-aloud (VERIFIED), literacy cited as a barrier by GSMA/UNHCR (UNVERIFIED).
7. **Cheapest-option hints (Halbtax, day pass, KulturLegi mention).** Evidence: KulturLegi 30%+ on listed areas for low-income people (VERIFIED) but *not* transport (VERIFIED): so frame honestly. Scotland 84% priced out (VERIFIED, not Swiss).
8. **Translatable "show this to the driver" card** ("I want to go to X, please tell me when we arrive"). Evidence: translation use among Vienna refugees (Google Translate top-5, VERIFIED). Sound hypothesis for requests-stops/terminus issues.
9. **Places newcomers need near the stop** (Integrationsstelle, Sozialdienst, Caritas, KulturLegi point, language courses, pharmacy, Sans-Papiers counselling). Evidence: SEM lists integration offices; UNHCR Help lists NGOs (VERIFIED that these exist; weak evidence on demand; ask interviewees).

**COULD**
10. Live departures (opentransportdata.swiss) - useful but all competitors have it; not our differentiator.
11. Voice input ("where is the Eritrean community centre?") - high risk in low-resource languages.
12. LLM chat explainer for fare rules - only with guardrails and citations (section 5); skip if time is short.
13. Share link/QR for social workers.

---

## 5 interview questions for newcomers this morning

1. "Think of the last time you took a bus or tram in Bern and were unsure. What exactly confused you: which stop, which side, which direction, which ticket, or something else?" (tests the stop-edge/terminus hypothesis)
2. "How do you pay for transport now - cash, card, Twint, app, prepaid? Has anyone ever fined you or warned you? Did you understand why?" (ticket and fine pain, payment friction)
3. "What apps and languages do you use on your phone for getting around? How much mobile data do you have, and do you use WhatsApp, Google Maps, Google Translate?" (digital constraints, app habits)
4. "Would you rather read, listen, or see a picture for 'wait here' and 'get off at the next stop'? In which language and script?" (read-aloud, icons, language priority, literacy)
5. "Would you be comfortable letting an app know where you are? What would make you trust it, or not?" (privacy and trust)

Optional probe: "Which places do you need to go to most (Sozialdienst, school, language course, doctor, mosque/church, market)?"

---

## Gaps / not done (be honest if a judge asks)
- No Swiss study on refugee smartphone use or on fare-evasion among migrants was found.
- Not verified: Bernmobil app languages/features, Moovit/Citymapper coverage in Bern, Ankommen languages, Libero zone prices, Swiss asylum-seeker allowance, official SBB surcharge page (403), Tampere study, UNHCR 2016 numbers (bot-checked).
- Bern nationality table: large groups are reliable; small Asian/European column labels in the PDF text extract were misaligned, so recheck the table before quoting a specific mid-size country.
