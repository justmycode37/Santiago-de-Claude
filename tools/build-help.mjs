// Usage: node tools/build-help.mjs [data/help.json]
// Hand-curated help items for newcomers / refugees / low-income people in Bern where no open dataset exists
// (see docs/data-help.md), plus two live operator feeds: Tischlein deck dich (public JSON used by its own map)
// and Madame Frigo (fridge list embedded in its locations page). Neither feed states a licence -> licence_unclear.
// Every address is geocoded with swisstopo SearchServer; a hit is accepted only if its postcode and house number match.
// Places already in data/offices.json are NOT repeated; extra hours/phones for them go to `offices_supplement`.
import { writeFileSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";

const OUT = process.argv[2] ?? "data/help.json";
const CHECKED = "2026-11-21";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36" };

// ---- sources actually read on CHECKED ----
const SRC = {
  ufdrgass: "https://www.bern.ch/politik-und-verwaltung/stadtverwaltung/bss/familieundquartier/pinto-pravention-intervention-toleranz/downloads/downloads-2/uf%20dr%20Gass%20Vs%2009_25.pdf",
  dusche: "https://www.bern.ch/politik-und-verwaltung/stadtverwaltung/bss/familieundquartier/pinto-pravention-intervention-toleranz/downloads/downloads-2/Flyer%20a4%204xA6%20-%20Schliessfaecher%20Duschen%20Waschen.pdf/download",
  recht: "https://www.bern.ch/politik-und-verwaltung/stadtverwaltung/sk/bereich-recht/downloads/rechtsauskunftsstellen-in-der-stadt-bern-stand.pdf/download",
  notfall: "https://www.bern.ch/themen/sicherheit/notfaelle",
  deutsch: "https://www.bern.ch/themen/auslanderinnen-und-auslander/deutsch-lernen",
  dbon: "https://www.bern.ch/themen/auslanderinnen-und-auslander/deutsch-lernen/deutschbon",
  dschulen: "https://www.bern.ch/themen/auslanderinnen-und-auslander/deutsch-lernen/deutschbon/deutschschulen",
  sprache: "https://www.bern.ch/themen/freizeit-und-sport/freizeit-und-kultur-gunstig-oder-gratis/angebotskompass/angebote/downloads/Sprache.pdf/download",
  kule: "https://www.kulturlegi.ch/fileadmin/Media_KuLe/Schweiz/Dokumente/BE_Dokumente/Flyer_mit_Antragsformular_2025.pdf",
  kuleGem: "https://www.kulturlegi.ch/kanton-bern/partnergemeinden",
  cmRules: "https://caritas-regio.ch/angebote/guenstiger-leben/caritas-markt",
  cmShops: "https://caritas-markt.ch/de/",
  srkSp: "https://www.redcross.ch/de/unser-angebot/unterstuetzung-im-alltag/medizinische-versorgung-fuer-sans-papiers",
  srkAfk: "https://www.redcross.ch/de/unser-angebot/unterstuetzung-im-alltag/ambulatorium-folter-kriegsopfer",
  tox: "https://www.toxinfo.ch/",
  finta: "https://www.bern.ch/mediencenter/medienmitteilungen/aktuell_ptk/neue-frauen-finta-notschlafstelle-in-der-stadt-bern-eroeffnet",
  nette: "https://www.bern.ch/mediencenter/medienmitteilungen/aktuell_ptk/nette-toiletten-gehoeren-definitiv-zu-bern-1/dokumente/flyer-nette-toilette.pdf/download",
  netteMm: "https://www.bern.ch/mediencenter/medienmitteilungen/aktuell_ptk/nette-toiletten-gehoeren-definitiv-zu-bern-1",
  westside: "https://www.nau.ch/news/schweiz/mobiltelefon-suchtige-so-lauft-das-grosse-geschaft-65616426",
  banks: "https://www.moneyland.ch/de/fluechtlinge-bank-konto-schweiz",
  tddPage: "https://www.tischlein.ch/de/lebensmittel-erhalten",
  tddApi: "https://kkonlinerestapi.tischlein.ch/abgabestelle",
  frigo: "https://www.madamefrigo.ch/de/standorte/",
};

const FIELDS = ["id", "category", "name", "organisation", "address", "lat", "lon", "phone", "email", "website", "opening_hours",
  "opening_hours_osm", "languages", "cost", "who_for", "how_to_access", "notes", "source_url", "source_checked", "confidence"];
const item = (o) => ({ ...Object.fromEntries(FIELDS.map((f) => [f, null])), source_checked: CHECKED, ...o });

// ---- hand-curated items ----
const L = "Leaflet 'uf dr Gass' (Stadt Bern / PINTO), file name 'Vs 09_25', content says 'Version 01.26'.";
const curated = [
  // food
  item({ id: "im-hof-essensabgabe", category: "food_distribution", name: "Im Hof – outdoor food distribution", address: "Hodlerstrasse 22, 3011 Bern",
    opening_hours: "Saturday 14:00-16:00", opening_hours_osm: "Sa 14:00-16:00", cost: null, who_for: "People living on the street",
    notes: "Listed under 'Essensabgabe (Outdoor)', next to Contact Anlaufstelle. " + L, source_url: SRC.ufdrgass, confidence: "medium" }),
  item({ id: "pinto-sonntag-znacht", category: "free_meal", name: "Sunday evening meal (PINTO) at Dock 8", organisation: "PINTO, Stadt Bern",
    address: "Holligerhof 8, 3008 Bern", opening_hours: "Sunday from 17:30/17:40 (leaflet gives both times)", cost: "free", who_for: "Everyone",
    notes: "Free warm meal and tea. Dock 8 itself is in offices.json (id dock8). " + L, source_url: SRC.ufdrgass, confidence: "medium" }),
  // day centres / outreach
  item({ id: "cafe-mazay", category: "day_centre", name: "Café Mazay", address: "Beundenfeldstrasse 13, 3013 Bern", opening_hours: "Tue-Fri 14:00-18:00",
    opening_hours_osm: "Tu-Fr 14:00-18:00", notes: L, source_url: SRC.ufdrgass, confidence: "medium" }),
  item({ id: "contact-anlaufstelle", category: "day_centre", name: "Contact Anlaufstelle", organisation: "Contact (Stiftung für Suchthilfe)",
    address: "Hodlerstrasse 22, 3011 Bern", phone: "031 310 06 50", opening_hours: "For everyone: Mon-Fri 12:30-20:00, Sun and public holidays 16:00-20:00",
    opening_hours_osm: "Mo-Fr 12:30-20:00; Su,PH 16:00-20:00", who_for: "People who use drugs", notes: "Everyday help and supervised consumption rooms. " + L,
    source_url: SRC.ufdrgass, confidence: "medium" }),
  item({ id: "gassenbus", category: "day_centre", name: "Gassenbus", address: "Hodlerstrasse, 3011 Bern", opening_hours: "Every Wednesday from 20:00",
    opening_hours_osm: "We 20:00+", notes: "Bus parked at Hodlerstrasse (Kunstmuseum). " + L, source_url: SRC.ufdrgass, confidence: "medium" }),
  item({ id: "kgb-gassenarbeit", category: "day_centre", name: "Kirchliche Gassenarbeit Bern (KGB)", address: "Sennweg 6, 3012 Bern", phone: "031 312 38 68",
    opening_hours: "Tue 14:00-16:00 women's office; Thu 14:00-16:00 open office for everyone", opening_hours_osm: "Tu,Th 14:00-16:00", cost: "free",
    who_for: "People living on the street (Tuesday: women only)", notes: "Free information and advice, street presence. " + L, source_url: SRC.ufdrgass, confidence: "medium" }),
  item({ id: "pinto", category: "outreach", name: "PINTO – street social work", organisation: "Stadt Bern", address: "Schwarztorstrasse 23, 3007 Bern",
    phone: "031 321 75 54", email: "pinto@bern.ch", opening_hours: "Phone Mon-Fri 09:00-23:00, Sat 16:00-23:00; drop-in without appointment Mon-Fri 09:00-10:00, Sat 16:00-17:00",
    opening_hours_osm: "Mo-Fr 09:00-23:00; Sa 16:00-23:00", cost: "free", who_for: "Everyone using public space, incl. homeless people",
    how_to_access: "Call, or meet staff in red work clothes on the street, or drop in at the drop-in hours.", notes: L, source_url: SRC.ufdrgass, confidence: "high" }),
  item({ id: "la-strada", category: "outreach", name: "La Strada (mobile bus)", address: "Taubenstrasse, 3011 Bern",
    opening_hours: "Wed, Fri, Sat 19:30-24:00", opening_hours_osm: "We,Fr,Sa 19:30-24:00", who_for: "Women doing sex work on the drug scene",
    notes: "Mobile contact point; bus at Taubenstrasse, entrance Kleine Schanze. Anonymous. " + L, source_url: SRC.ufdrgass, confidence: "medium" }),
  // shelter
  item({ id: "finta-notschlafstelle", category: "shelter", name: "Frauen/FINTA-Notschlafstelle", organisation: "Heilsarmee (on behalf of Stadt Bern)",
    address: "Kursaalstrasse 6, 3013 Bern", phone: "076 326 97 75", opening_hours: "Access around the clock", opening_hours_osm: "24/7",
    who_for: "Homeless women and FINTA persons (women, inter, non-binary, trans, agender)",
    notes: "18 places; breakfast and kitchen. City press release (17 June 2025) said the site was a temporary use, 'vorerst bis Ende April 2026'; the Jan 2026 leaflet still lists it. Call before going. Homeless shelter, not a domestic-violence shelter.",
    source_url: SRC.ufdrgass, confidence: "medium" }),
  // showers
  item({ id: "pinto-duschen", category: "free_showers", name: "Showers, laundry and lockers for homeless people", organisation: "PINTO, Stadt Bern",
    address: "Schwarztorstrasse 23, 3007 Bern", phone: "031 321 75 54", opening_hours: "Lockers/showers Mon-Fri 09:00-10:00 and 16:30-17:00, Sat 16:00-17:00",
    opening_hours_osm: "Mo-Fr 09:00-10:00,16:30-17:00; Sa 16:00-17:00", cost: "free", who_for: "Homeless people", source_url: SRC.dusche, confidence: "high" }),
  // health
  item({ id: "srk-ambulatorium-folter-kriegsopfer", category: "health_mental", name: "Ambulatorium für Folter- und Kriegsopfer SRK",
    organisation: "Schweizerisches Rotes Kreuz", address: "Werkstrasse 16, 3084 Wabern", phone: "+41 58 400 47 77", email: "gi-ambulatorium@redcross.ch",
    website: SRC.srkAfk, languages: "Works with certified intercultural interpreters", cost: null,
    who_for: "Adults, youth and children traumatised by torture, war or flight; priority for people who speak no national language",
    how_to_access: "Through a doctor: the doctor registers you with a form. No waiting list.",
    notes: "On " + CHECKED + " the page said: places for children and youth available; no regular places for adults (some research-project places). Same address as offices.json id gvsp (which merges both services).",
    source_url: SRC.srkAfk, confidence: "high" }),
  item({ id: "berner-gesundheit", category: "health_free", name: "Berner Gesundheit", address: "Eigerstrasse 80, 3007 Bern", phone: "031 370 70 70",
    cost: "usually free", who_for: "People with addiction problems; sexual health, prevention", notes: L, source_url: SRC.ufdrgass, confidence: "medium" }),
  item({ id: "blaues-kreuz", category: "health_free", name: "Blaues Kreuz", address: "Zeughausgasse 39, 3011 Bern", phone: "031 311 11 56",
    who_for: "People with alcohol problems and their relatives", notes: "Assessment, counselling, therapy, self-help groups. " + L, source_url: SRC.ufdrgass, confidence: "medium" }),
  item({ id: "zahnarzt-notfall-uni", category: "health_emergency", name: "Zahnärztlicher Notfalldienst der Universität Bern", address: "Freiburgstrasse 7, 3010 Bern",
    phone: "+41 31 684 06 00", email: "zentrale.dienste@zmk.unibe.ch", opening_hours: "Mon-Fri 08:00-12:00, 13:00-17:00; outside these hours call +41 31 529 60 60 (Notfallzahnarzt Bern)",
    opening_hours_osm: "Mo-Fr 08:00-12:00,13:00-17:00", cost: null, source_url: SRC.notfall, confidence: "high" }),
  item({ id: "praxiszentrum-bahnhof", category: "health_emergency", name: "Praxiszentrum am Bahnhof (walk-in)", address: "Parkterrasse 10, 3012 Bern",
    phone: "+41 31 335 50 00", opening_hours: "Mon-Fri 07:30-19:00, Sat-Sun 09:00-18:00, also without appointment", opening_hours_osm: "Mo-Fr 07:30-19:00; Sa,Su 09:00-18:00",
    cost: null, notes: "Not a free service (normal health-insurance billing assumed; not stated on source).", source_url: SRC.notfall, confidence: "high" }),
  // hotlines (no address)
  item({ id: "hotline-145-tox", category: "hotline", name: "Tox Info Suisse – poisoning (145)", phone: "145", opening_hours: "24/7", opening_hours_osm: "24/7",
    cost: "free", website: SRC.tox, source_url: SRC.tox, confidence: "high" }),
  item({ id: "hotline-1414-rega", category: "hotline", name: "Rega air rescue (1414)", phone: "1414", opening_hours: "24/7", opening_hours_osm: "24/7",
    source_url: SRC.notfall, confidence: "high" }),
  item({ id: "hotline-aerzte-notruf", category: "hotline", name: "Ärzte-Notruf Bern (doctor on call)", phone: "0900 57 67 47",
    cost: "CHF 3.23/min; from prepaid phones 0900 57 67 48 (CHF 3.50/min)", notes: "Paid 0900 number. For life-threatening emergencies call 144.",
    source_url: SRC.notfall, confidence: "high" }),
  item({ id: "hotline-apotheken-notruf", category: "pharmacy_on_duty", name: "Apothekennotruf (on-duty pharmacy)", phone: "0900 98 99 00",
    website: "https://notfall-finder.ch/", cost: "CHF 0.98/min",
    notes: "Phone tells you which pharmacy is on duty; no rota stored here. notfall-finder.ch is the city-linked digital emergency guide.",
    source_url: SRC.notfall, confidence: "high" }),
  item({ id: "hotline-upd-krise", category: "hotline", name: "Psychiatric emergency / crisis centre (UPD)", phone: "+41 31 632 88 11", source_url: SRC.notfall, confidence: "high" }),
  item({ id: "hotline-elternnotruf", category: "hotline", name: "Elternnotruf Kanton Bern (parents' helpline)", phone: "0848 35 45 55", source_url: SRC.notfall, confidence: "high" }),
  // legal advice (Rechtsauskunftsstellen in der Stadt Bern, Ausgabe Oktober 2026: free or max CHF 50)
  ...[
    { id: "asylhilfe-bern", name: "Asylhilfe Bern", address: null, phone: "031 382 52 72 / 076 700 49 40", email: "info@asylhilfe.ch", website: "https://www.asylhilfe.ch",
      opening_hours: "By appointment", who_for: "Asylum seekers and immigrants: legal and social advice", notes: "Postal address Postfach 4034, 3604 Thun (no Bern street address in source)." },
    { id: "fasa-asyl", name: "FASA, Fachstelle Sozialarbeit der kath. Kirche Region Bern – Asylbereich", address: "Mittelstrasse 6A, 3012 Bern", phone: "031 300 33 47",
      website: "https://www.kathbern.ch", opening_hours: "Tue-Thu, with prior registration", who_for: "Rejected asylum seekers living in Bern and surroundings",
      notes: "A personal e-mail is listed in the source; not copied here." },
    { id: "gggfon", category: "hotline", name: "gggfon – Gemeinsam gegen Gewalt und Rassismus", address: null, phone: "031 333 33 40", email: "melde@gggfon.ch", website: "https://www.gggfon.ch",
      opening_hours: "Mon-Fri 10:00-17:00 (more hours possible; answering machine and e-mail outside)", cost: "free",
      who_for: "People discriminated against because of origin, religion, skin colour, status, way of life or language" },
    { id: "mieterverband-bern", name: "Mieterinnen- und Mieterverband Kanton Bern", address: "Monbijoustrasse 61, 3007 Bern", phone: "031 378 21 21",
      website: "https://www.mieterverband.ch/bern", opening_hours: "Mon-Thu 09:00-12:30, 14:00-17:00; Fri 09:00-12:30, 14:00-16:00",
      opening_hours_osm: "Mo-Th 09:00-12:30,14:00-17:00; Fr 09:00-12:30,14:00-16:00", cost: "members; non-members: phone advice by lawyers 0900 900 800 (CHF 4.40/min from landline)",
      who_for: "Tenants", how_to_access: "Personal advice for members after phone registration." },
    { id: "schlichtungsbehoerde-bern", name: "Schlichtungsbehörde Bern-Mittelland (free legal advice line)", organisation: "Kanton Bern", address: "Effingerstrasse 34, 3008 Bern",
      phone: "031 635 47 60", email: "Schlichtungsbehoerde.Bern@justice.be.ch", website: "https://www.justice.be.ch",
      opening_hours: "Phone advice Mon-Wed 09:00-11:00, 15:00-17:00; Thu-Fri 09:00-11:00, 14:00-16:00; in person by appointment",
      opening_hours_osm: "Mo-We 09:00-11:00,15:00-17:00; Th,Fr 09:00-11:00,14:00-16:00", who_for: "Tenancy, employment and equality law questions",
      notes: "Advice only on the number 031 635 47 60 (main line 031 635 47 50)." },
    { id: "triio-beratung", name: "TRiiO Beratungsstelle", address: "Gutenbergstrasse 40B, 3011 Bern", phone: "031 311 91 55", email: "info@triio.ch", website: "https://www.triio.ch",
      opening_hours: "Mon-Fri 08:45-12:00, 13:30-16:45; closed Wednesday morning", opening_hours_osm: "Mo,Tu,Th,Fr 08:45-12:00,13:30-16:45; We 13:30-16:45",
      who_for: "Questions about authorities (RAV, Sozialdienst), employment and social-insurance law",
      notes: "First assessment and referral, not formal legal advice; writes objections, checks work references." },
    { id: "unia-bern", name: "Gewerkschaft Unia Bern", address: "Monbijoustrasse 61, 3007 Bern", phone: "031 385 22 22", email: "bern@unia.ch", website: "http://bern.unia.ch",
      how_to_access: "Appointments by phone", who_for: "Workers (employment and social-insurance law)",
      notes: "Hours and member/non-member rules could not be read unambiguously from the PDF table; ask by phone. Unia unemployment fund: 058 332 11 31." },
    { id: "anwaltsverband-rechtsauskunft", name: "Bernischer Anwaltsverband – Rechtsauskunftsstelle", address: "Bundesgasse 16, 3011 Bern", phone: "031 312 53 53",
      website: "https://www.bav-aab.ch/de/rechtssuchende/rechtsauskunftsstellen.html", opening_hours: "Thu 17:00-19:30, Sat 09:00-12:00; closed at Easter, Ascension, Pentecost and summer/winter holidays",
      opening_hours_osm: "Th 17:00-19:30; Sa 09:00-12:00", cost: "CHF 50 for about 20 minutes", who_for: "All areas of law", notes: "No legal advice by phone; answering machine only." },
    { id: "berner-schuldenberatung", name: "Berner Schuldenberatung", address: "Seftigenstrasse 57, 3007 Bern", phone: "031 371 84 84", email: "info@schuldeninfo.ch",
      website: "https://www.schuldeninfo.ch", cost: "first consultation free", who_for: "People in debt" },
    { id: "breitsch-traeff-rechtsauskunft", name: "Breitsch-Träff Rechtsauskunftsstelle", address: "Breitenrainplatz 27, 3014 Bern", phone: "031 311 65 05",
      email: "info@breitsch-traeff.ch", website: "https://www.breitsch-traeff.ch", how_to_access: "Phone registration required", who_for: "All areas of law" },
  ].map((o) => item({ category: "legal_advice", cost: "free or max. CHF 50 (per source)", source_url: SRC.recht, confidence: "high", ...o })),
  // language courses
  item({ id: "kanton-sprachkurs-suche", category: "language_courses", name: "Kanton Bern German course finder", organisation: "Kanton Bern (BKD)",
    website: "https://www.weiterbildung-kurse.apps.be.ch/sprachkurs", who_for: "Migrants looking for German/French courses (incl. literacy, parent-child, conversation)",
    notes: "Search engine linked from bern.ch (www.be.ch/sprachkurse-migration); filters by course type and distance. Use it instead of a static list.",
    source_url: SRC.deutsch, confidence: "high" }),
  item({ id: "deutschbon", category: "discount", name: "DeutschBon – CHF 400 voucher for a German course", organisation: "Stadt Bern, Fachstelle für Migrations- und Rassismusfragen",
    phone: "+41 31 321 72 00 (Mon-Fri 10:00-12:00)", email: "deutschbon@bern.ch", website: SRC.dbon, cost: "free voucher worth CHF 400",
    who_for: "Age 18+, German is a foreign language, registered in Stadt Bern or Ostermundigen; S status and sans-papiers allowed; not if asylum social aid already pays a course",
    how_to_access: "Lottery of 600 vouchers (+100 Ostermundigen); people with health-insurance premium reduction (IPV) get priority. Registration closed on " + CHECKED + "; next round autumn 2027.",
    notes: "Group courses only (incl. online) at 13 schools; no exam fees. Does not affect residence permit.", source_url: SRC.dbon, confidence: "high" }),
  ...[
    ["academia-languages", "academia languages", "+41 58 440 90 80", "info.bern@academia-group.ch", "https://academia-languages.ch/", "Overview page lists +41 58 440 80 90; school detail lists +41 58 440 90 80."],
    ["alemania", "Alemania Deutschschule", "+41 31 332 31 31", "bern@alemania.ch", "https://www.alemania.ch/"],
    ["benedict", "Bénédict-Schule Bern", "+41 31 310 28 28", "info.be@benedict.ch", "https://www.benedict.ch/"],
    ["ecap", "ECAP Bern", "+41 31 381 81 33", "infobe@ecap.ch", "https://www.ecap.ch/Standorte/Bern/Aktuell", "Non-profit; intensive/extensive, literacy, job-specific courses, fide tests; childcare from 6 months."],
    ["flying-teachers", "Flying Teachers", "+41 31 311 55 13", "office.bern@flyingteachers.com", "https://www.flyingteachers.ch"],
    ["heks-hip", "HEKS Integrationsprogramme HIP", "+41 31 385 18 45", "hip@heks.ch", "https://www.heks.ch/was-wir-tun/heks-integrationsprogramme-hip", "Open to all regardless of status; slow pace, fide-oriented; childcare from 3 months."],
    ["inlingua-aare", "inlingua Aare", "+41 31 333 00 73", "kontakt@inlingua-aare.ch", "https://www.inlingua-aare.ch/"],
    ["ils-bern", "International Language School ILS-Bern", "+41 31 561 90 90", "info@ils-bern.ch", "https://www.ils-bern.ch"],
    ["isa", "isa Fachstelle Migration", "+41 31 310 12 70", "isa@isabern.ch", "https://isabern.ch/", "A1-B1, literacy, conversation, online. Office is in offices.json (id isa)."],
    ["klubschule", "Klubschule Migros Bern", "+41 58 568 00 30", "klubschule.bern@migrosaare.ch", "https://www.klubschule.ch/sprachen/deutschkurse/"],
    ["lernpunkt", "Lern.Punkt (Heilsarmee)", "+41 31 511 36 20", "lernpunkt@heilsarmee.ch", "https://lernpunkt.heilsarmee.ch/", "Express, literacy and courses for people with impaired sight up to B1; telc and fide tests; childcare from 6 months."],
    ["muki", "MuKi-Deutsch (mother-child courses), Stadt Bern", "+41 31 321 64 78", null, "https://www.bern.ch/themen/bildung/vorschule/muki-deutsch", "Children about 2.5-5 years."],
    ["vhs", "Volkshochschule Bern", "+41 31 320 30 32", "info@vhsbe.ch", "https://www.vhs-bern.ch"],
  ].map(([slug, name, phone, email, website, notes]) => item({ id: `lang-${slug}`, category: "language_courses", name, phone, email, website,
    notes: ["DeutschBon partner school (eduQua or similar).", notes].filter(Boolean).join(" "), source_url: SRC.dschulen, confidence: "high" })),
  ...[
    { id: "lang-muetterzentrum-bern-west", name: "German for women – Mütterzentrum Bern-West", address: "Waldmannstrasse 15, 3027 Bern", phone: "031 991 21 05", email: "info@muetterzentrumbern-west.ch" },
    { id: "lang-zentrum5", name: "German for women – Zentrum 5", address: "Flurstrasse 26b, 3014 Bern", phone: "031 333 26 20", email: "info@zentrum5.ch" },
    { id: "lang-treffpunkt-untermatt-muki", name: "MUKI German course – Treffpunkt Untermatt", address: "Bümplizstrasse 21, 3027 Bern", phone: "031 992 49 82", email: "treff.untermatt@bluewin.ch",
      cost: "CHF 300 per year", notes: "Mothers learn 2 hours/week; children cared for in parallel." },
    { id: "lang-denk-mal", name: "German courses – Denk mal", address: "Stauffacherstrasse 82, 3014 Bern", email: "denk-mal@denk-mal.info" },
    { id: "lang-heiligkreuz-muki", name: "Mother-child German – Pfarrei Heiligkreuz", address: "Kastellweg 7, 3004 Bern", phone: "031 300 70 20", email: "heiligkreuz.bern@kathbern.ch" },
  ].map((o) => item({ category: "language_courses", cost: o.cost ?? "free or low cost (per source)", source_url: SRC.sprache, confidence: "low",
    ...o, notes: [o.notes, "From the city's undated 'Angebotskompass – Sprache' PDF (lists isa at an old address, so it is not current)."].filter(Boolean).join(" ") })),
  item({ id: "schreibdienst-vbg", category: "admin_help", name: "Schreibdienst (help with letters and forms)", organisation: "Vereinigung Berner Gemeinwesenarbeit VBG",
    address: "Bahnhofplatz 2, 3011 Bern", phone: "078 741 22 27", email: "schreibdienst@vbgbern.ch", opening_hours: "Monday 14:00-19:00", opening_hours_osm: "Mo 14:00-19:00",
    cost: "free", how_to_access: "No registration; bring all your papers.", notes: "At Berner GenerationenHaus. No translations, tax returns or legal advice. Undated PDF.",
    source_url: SRC.sprache, confidence: "low" }),
  item({ id: "schreibstube-untermatt", category: "admin_help", name: "Schreibstube Bern-West", organisation: "Treffpunkt Untermatt", address: "Bümplizstrasse 21, 3027 Bern",
    phone: "031 992 49 82", opening_hours: "Wednesday 14:00-18:00, closed in Bern school holidays", opening_hours_osm: "We 14:00-18:00", cost: "free",
    notes: "Letters, forms, understanding texts. Undated PDF.", source_url: SRC.sprache, confidence: "low" }),
  // discounts
  item({ id: "kulturlegi-bern", category: "discount", name: "KulturLegi Kanton Bern", organisation: "Caritas Bern", address: "Zähringerstrasse 25, 3012 Bern",
    phone: "031 378 60 36 (infoline)", email: "bern@kulturlegi.ch", website: "https://www.kulturlegi.ch/kanton-bern", cost: "first year free; renewal CHF 20 (CHF 30 for a couple/family household; free for children up to 18)",
    who_for: "Residents of partner communes (Stadt Bern is one) on social aid, AHV/IV supplementary benefits, scholarship, second-highest health-premium reduction (IPV), or wage garnishment; others with low income via tax assessment or previous year's salary statement",
    how_to_access: "Social service or AHV branch confirms eligibility; apply online, at Caritas Bern, or by post with passport photo.",
    notes: "At least 30% off ~4200 partner offers (health, sport, education, culture), cheaper German courses, shopping at Caritas-Markt. Partner list: https://www.kulturlegi.ch/kanton-bern/angebote ; partner communes: " + SRC.kuleGem + " . The flyer lists no public-transport discount.",
    source_url: SRC.kule, confidence: "high" }),
  item({ id: "caritas-markt-zugang", category: "discount", name: "Caritas-Markt – who may shop there", organisation: "Caritas",
    who_for: "Social aid or AHV/IV supplementary benefits; premium reduction (some regions); income at subsistence minimum; scholarship; refugee status or asylum seeker (N, F, S permit); sans-papiers; KulturLegi holders",
    how_to_access: "Personal shopping card: KulturLegi or a Caritas-Markt-Einkaufskarte from the regional Caritas.",
    notes: "Bern shop is offices.json id caritas-markt (hours in offices_supplement).", source_url: SRC.cmRules, confidence: "high" }),
  // banks (link-out only)
  item({ id: "banks-n-f-s-linkout", category: "banks", name: "Bank account with N, F or S permit (link-out)", website: SRC.banks,
    how_to_access: "Ask your Sozialdienst / Asylsozialdienst or the bank branch directly.",
    notes: "No list on purpose: bank rules for N/F/S permits differ and change. Only overview found is a third-party article dated 27 Sep 2022.",
    source_url: SRC.banks, confidence: "low" }),
  // phone charging
  item({ id: "charging-westside", category: "phone_charging", name: "Free phone-charging lockers, Westside shopping centre", address: "Riedbachstrasse 100, 3027 Bern",
    cost: "free", notes: "Only source for the lockers is an undated nau.ch article (probably several years old); unverified that they still exist. Address from www.westside.ch footer.", source_url: SRC.westside, confidence: "low" }),
];

// Nette Toilette flyer (2018 press release; still linked on bern.ch). Free toilet use without buying anything.
const nette = [
  ["Bar-Club Propeller Bar", "Aarbergergasse 30, 3011 Bern"], ["Restaurant Schmiedsstube", "Schmiedenplatz 5, 3011 Bern"],
  ["Hotel Nydeck – Junkere Bar", "Gerechtigkeitsgasse 1, 3011 Bern"], ["Ristorante Santa Lucia", "Bärenplatz 7, 3011 Bern"],
  ["The Beef Steakhouse & Bar", "Kramgasse 74, 3011 Bern"], ["Confiserie Monnier", "Schauplatzgasse 26, 3011 Bern"],
  ["Restaurationsbetriebe Reitschule", "Neubrückstrasse 8, 3012 Bern"], ["Restaurant Mülirad", "Gerberngasse 4, 3011 Bern"],
  ["Hotel-Restaurant National", "Hirschengraben 24, 3011 Bern"], ["Restaurant Brésil", "Bollwerk 15, 3011 Bern"],
  ["Restaurant Brasserie Ringgenberg", "Kornhausplatz 19, 3011 Bern"], ["Café Tscharni", "Waldmannstrasse 17, 3027 Bern"],
].map(([name, address]) => item({ id: "nette-toilette-" + slug(name), category: "toilets_partner", name: `Nette Toilette – ${name}`, address, cost: "free, no purchase needed",
  how_to_access: "Look for the red 'Nette Toilette' sticker at the entrance; only during the venue's opening hours.",
  notes: "List from the city flyer linked to the 11 July 2018 press release (12 venues then). May be outdated; the city WebGIS also shows them." + (name.includes("Schmieds") ? " Flyer writes the street as 'Schmiedplatz 5'." : ""),
  source_url: SRC.nette, confidence: "low" }));

function slug(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
assert.equal(slug("Café Tscharni – Bümpliz"), "cafe-tscharni-bumpliz");

// ---- live feeds ----
async function get(url, as = "text") {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return as === "json" ? res.json() : res.text();
}
// Stadt Bern (3001-3030) + communes touching it: Wohlen/Hinterkappelen, Bremgarten, Worblaufen, Zollikofen, Ittigen,
// Bolligen, Ostermundigen, Gümligen/Muri, Worb, Wabern, Liebefeld/Köniz.
const NEAR = new Set(["3032", "3033", "3047", "3048", "3052", "3063", "3065", "3072", "3073", "3074", "3076", "3084", "3097", "3098"]);
const isBernArea = (plz) => (+plz >= 3001 && +plz <= 3030) || NEAR.has(plz);
assert(isBernArea("3011") && isBernArea("3084") && !isBernArea("3054") && !isBernArea("5630"));

const tdd = (await get(SRC.tddApi, "json")).filter((r) => isBernArea(r.plz)).map((r) => item({
  id: "tdd-" + slug(r.firma1.replace(/^AS /, "")), category: "food_distribution", name: `Tischlein deck dich – ${r.firma1.replace(/^AS /, "")}`,
  organisation: ["Tischlein deck dich", r.firma2].filter(Boolean).join(" / "), address: `${r.strasse}, ${r.plz} ${r.ort}`,
  phone: r.telefon_direkt || r.telefon || null,
  opening_hours: `${r.oeffnung_wochentag} ${r.oeffnung_zeit_start}-${r.oeffnung_zeit_end}` + (r.bemerkung_oeffnungszeit ? ` (${r.bemerkung_oeffnungszeit})` : ""),
  opening_hours_osm: `${{ Montag: "Mo", Dienstag: "Tu", Mittwoch: "We", Donnerstag: "Th", Freitag: "Fr", Samstag: "Sa", Sonntag: "Su" }[r.oeffnung_wochentag]} ${hm(r.oeffnung_zeit_start)}-${hm(r.oeffnung_zeit_end)}`,
  cost: "small fee per visit (amount not stated on source)", who_for: "People in need with a Tischlein deck dich customer card",
  how_to_access: "Get a customer card through a social agency (Sozialfachstelle) after a needs check; the card comes by post; then collect food once a week here.",
  notes: "From the operator's own map feed. Source coordinates: " + r.koordinaten, source_url: SRC.tddApi, licence_unclear: true, confidence: "high",
}));
function hm(t) { const [h, m] = t.split("."); return `${h.padStart(2, "0")}:${(m ?? "00").padEnd(2, "0")}`; }
assert.equal(hm("9.00"), "09:00"); assert.equal(hm("16.15"), "16:15");
assert(tdd.length >= 5, `Tischlein feed: only ${tdd.length} Bern rows`);

// Madame Frigo prints each fridge as a PHP array dump: [title], [address] => Array([street], [plz], [city]).
const fh = await get(SRC.frigo);
const frigo = fh.split("<pre>Array").slice(1).map((b) => {
  const g = (re) => b.match(re)?.[1]?.trim();
  return { title: g(/\[title\] => (.*)/), street: g(/\[street\] => (.*)/), plz: g(/\[plz\] => (.*)/), city: g(/\[city\] => (.*)\n\s*\[link\]/),
    srcLat: +g(/\[lat\] =>\s*([\d.]+)/), srcLon: +g(/\[lng\] =>\s*([\d.]+)/) };
}).filter((f) => f.plz && isBernArea(f.plz)).map((f) => item({
  _srcLatLon: [f.srcLat, f.srcLon],
  id: "frigo-" + slug(f.title), category: "public_fridge", name: `Madame Frigo – ${f.title}`, organisation: "Madame Frigo (volunteers)",
  address: `${f.street.replace(/\s+[–-]\s+.*$/, "")}, ${f.plz} ${f.city}`, cost: "free",
  who_for: "Everyone", how_to_access: "Bring food you don't need, take what you need.",
  notes: /[–-]\s/.test(f.street) ? `Location detail: ${f.street}` : null, source_url: SRC.frigo, licence_unclear: true, confidence: "medium" }));
assert(frigo.length >= 8, `Madame Frigo: only ${frigo.length} Bern fridges`);

// ---- geocoding ----
const geo = new Map();
async function geocode(address) {
  if (geo.has(address)) return geo.get(address);
  const [, street, plz, town] = address.match(/^(.*?), (\d{4}) (.+)$/);
  const q = address.replace(/,/g, " ");
  const j = await get(`https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=${encodeURIComponent(q)}&type=locations&origins=address&sr=4326&limit=5`, "json");
  const hit = j.results.find((r) => addrOk(r.attrs.detail, street, plz, town));
  const res = hit ? { lat: +hit.attrs.lat.toFixed(6), lon: +hit.attrs.lon.toFixed(6) } : null;
  geo.set(address, res);
  return res;
}
// detail looks like "bahnhofplatz 2 3011 bern 351 bern ch be". Same canton, same house number (if any), same street word,
// and same postcode or same town (postbox postcodes like 3001 are not address postcodes).
function addrOk(detail, street, plz, town) {
  const m = detail.match(/^(.*?) (?:(\d+)[\w.]* )?(\d{4}) (.*) ch (\w\w)$/);
  if (!m || m[5] !== "be") return false;
  const de = (x) => x.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").normalize("NFD").replace(/[̀-ͯ]/g, "");
  const num = street.match(/ (\d+)\w*$/)?.[1], word = de(street).split(/[ -]/)[0];
  return (num ? m[2] === num : true) && m[1].includes(word) && (m[3] === plz || m[4].includes(de(town).split(/[ -]/)[0]));
}
assert(addrOk("bahnhofplatz 2 3011 bern 351 bern ch be", "Bahnhofplatz 2", "3001", "Bern"));
assert(!addrOk("bahnhofplatz 2 9100 herisau 3001 herisau ch ar", "Bahnhofplatz 2", "3001", "Bern"));
assert(!addrOk("bahnhofplatz 12 3011 bern 351 bern ch be", "Bahnhofplatz 2", "3011", "Bern"));
assert(addrOk("werkstrasse 16 3084 wabern 355 köniz ch be", "Werkstrasse 16", "3084", "Wabern"));
assert(addrOk("hodlerstrasse 5 3011 bern 351 bern ch be", "Hodlerstrasse", "3011", "Bern"));
assert(addrOk("buemplizstrasse 21 3027 bern 351 bern ch be", "Bümplizstrasse 21", "3027", "Bern"));

const items = [...curated, ...tdd, ...frigo, ...nette];
const unmatched = [];
for (const it of items) {
  if (!it.address) continue;
  const g = await geocode(it.address);
  const [sLat, sLon] = it._srcLatLon ?? [];
  if (g) Object.assign(it, g);
  else if (sLat && sLon) { // Madame Frigo's own map pin; its address is not a swisstopo address (e.g. house number on a park)
    Object.assign(it, { lat: +sLat.toFixed(6), lon: +sLon.toFixed(6) });
    it.notes = [it.notes, "Address not found in swisstopo; coordinates are the operator's map pin."].filter(Boolean).join(" ");
  } else unmatched.push(`${it.id}: ${it.address}`);
  delete it._srcLatLon;
}

// ---- supplements for rows already in data/offices.json (never duplicated as items) ----
const sup = (opening_hours, source_url, extra = {}) => ({ opening_hours, source_url, source_checked: CHECKED, ...extra });
const offices_supplement = {
  aufenthaltsraum: sup("Mon-Fri 08:30-11:00, 14:30-16:30; closed Tue afternoon and Sun. Free coffee/tea; soup on Saturday. Leaflet: 'Ab 16.12 geschlossen'.", SRC.ufdrgass),
  azzurro: sup("Mon, Wed, Thu, Fri café and meal from 11:30 (menu CHF 7); Sun from 15:00; closed Tue and Sat. First Monday of the month: free soup and bread for everyone from 18:00.", SRC.ufdrgass),
  "casa-marcello": sup("Mon-Sun from 15:00", SRC.ufdrgass),
  "la-gare": sup("Mon-Sat 11:00-18:00; meal about 13:30 (register by 12:00), menu CHF 5, soup and bread CHF 2. Meeting point for people with alcohol problems.", SRC.ufdrgass),
  dock8: sup("Mon-Wed 09:00-17:00, Thu-Fri 09:00-22:00, Sat-Sun closed; stay without buying anything. Sunday PINTO meal: see help.json pinto-sonntag-znacht.", SRC.ufdrgass),
  "la-prairie": sup("Tue-Fri 10:00-15:00; lunch CHF 5", SRC.ufdrgass),
  heiliggeist: sup("Tue-Fri 11:00-18:30, Sun 13:00-17:00; free coffee and tea", SRC.ufdrgass),
  "sleeper-kueche": sup("Mon-Sun from 18:00, warm menu CHF 5", SRC.ufdrgass),
  medina: sup("Thu, Fri 18:00-22:00", SRC.ufdrgass),
  sleeper: sup("Registration and check-in 22:00-01:00; wake-up 09:00, leave by 10:00. CHF 5 bed and breakfast.", SRC.ufdrgass),
  passantenheim: sup("Sun-Thu until 23:00, Fri-Sat until 24:00; new admissions around the clock only in exceptional cases. 50 beds, CHF 15 incl. breakfast; washing machine, kitchen.", SRC.ufdrgass),
  passantenhilfe: sup("Mon, Tue, Thu, Fri 09:00-11:30, 14:00-16:00; Wed 14:00-16:00. Free, anonymity possible.", SRC.ufdrgass),
  punkt6: sup("November to April, Mon-Sun 06:00-10:00 and 17:30-22:30. Coffee/tea, showers, laundry, internet, lockers, phone, laptop/printer, sleeping.", SRC.ufdrgass, { opening_hours_osm: "Nov-Apr Mo-Su 06:00-10:00,17:30-22:30" }),
  gassendusche: sup("Tue-Sat from 09:00, Sun from 10:00; shower CHF 2", SRC.ufdrgass),
  sozialdienst: sup("New registrations Mon-Thu 14:00-16:30, Fri 14:00-15:30; Schreibstube (help filling in forms) Mon-Wed 08:30-11:30, Fri 08:30-11:30, closed Thu. Phone 031 321 60 27.", SRC.ufdrgass),
  gvsp: sup("Sans-papiers health care: walk in without appointment Mon 13:30-17:00, Tue 13:30-17:00, Fri 08:30-12:00.", SRC.srkSp, {
    opening_hours_osm: "Mo,Tu 13:30-17:00; Fr 08:30-12:00", phone: "+41 58 400 47 77", email: "gi-ambulatorium@redcross.ch",
    note: "CHF 10 once at first visit, then free (small share for dental care). WhatsApp health chat 079 884 53 55 (answered Mon-Thu). Also in Biel (Haus pour Bienne, Kontrollstrasse 22). Trauma therapy: help.json srk-ambulatorium-folter-kriegsopfer." }),
  "caritas-markt": sup("Mon 14:00-18:30; Tue-Fri 10:00-12:00, 14:00-18:30; Sat 10:00-14:00", SRC.cmShops, { opening_hours_osm: "Mo 14:00-18:30; Tu-Fr 10:00-12:00,14:00-18:30; Sa 10:00-14:00", note: "Eligibility: help.json caritas-markt-zugang." }),
  isa: sup("Short advice without appointment Mon, Tue, Thu 14:00-17:00; phone advice Mon-Thu 10:00-12:00 on 031 310 12 72.", SRC.recht, { languages: "Azerbaijani, Dari, English, Farsi, French, Italian, Spanish, Turkish, German; others on request", email: "beratung@isabern.ch" }),
  rbs: sup("Short advice and appointments Mon-Thu 09:00-12:00", SRC.recht, { note: "Foreigners/migration law (AIG), social-aid law, racism/ethnic discrimination; for people living in Kanton Bern." }),
  "sans-papiers": sup("Mon 14:00-18:00; more hours on www.sanspapiersbern.ch", SRC.recht, { phone_mobile: "079 794 62 28", email: "beratung@sanspapiersbern.ch" }),
  "city-notfall": sup("Daily 07:00-22:00, also without appointment", SRC.notfall, { opening_hours_osm: "Mo-Su 07:00-22:00" }),
  "insel-notfall": sup("24/7", SRC.notfall, { note: "City page gives Rosenbühlgasse 27, 3010 Bern (offices.json has Freiburgstrasse 16c). Children and youth: +41 31 632 92 77." }),
};

// ---- checks ----
const offices = JSON.parse(readFileSync("data/offices.json", "utf8")).items;
const officeIds = new Set(offices.map((o) => o.id));
const ids = new Set();
for (const it of items) {
  assert(!ids.has(it.id), `duplicate id ${it.id}`); ids.add(it.id);
  assert(!officeIds.has(it.id), `id clashes with offices.json: ${it.id}`);
  assert(it.category && it.name && it.source_url && ["high", "medium", "low"].includes(it.confidence), `incomplete ${it.id}`);
  if (it.lat != null) assert(it.lat > 46.85 && it.lat < 47.05 && it.lon > 7.3 && it.lon < 7.6, `outside Bern area: ${it.id}`);
}
for (const id of Object.keys(offices_supplement)) assert(officeIds.has(id), `supplement for unknown office id ${id}`);

const counts = Object.fromEntries([...new Set(items.map((i) => i.category))].map((c) => [c, items.filter((i) => i.category === c).length]));
writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  source: "Hand-curated from official/organisation pages (see each source_url and docs/data-help.md); Tischlein deck dich and Madame Frigo scraped from their own maps; coordinates via swisstopo SearchServer.",
  counts, geocode_unmatched: unmatched, items, offices_supplement,
}, null, 1) + "\n");
console.log(`wrote ${OUT}: ${items.length} items`, counts, unmatched.length ? `unmatched: ${unmatched.join("; ")}` : "");
