// Usage: node tools/build-help-ch.mjs [data/ch/help-ch.json]
// Basic-needs help for ALL of Switzerland, nationwide networks only (see docs/data-ch-help.md):
//  - live operator feeds: Tischlein deck dich (map JSON), Caritas-Markt (shop modals on caritas-markt.ch),
//    Essen für Alle (pick-up page), Madame Frigo (fridge list in its locations page), foodsharing Fairteiler
//    (public map API, Swiss points only, Madame Frigo duplicates dropped), Heilsarmee Brocki (branch list);
//  - hand-copied: Nette-Toilette flyers (Basel, Luzern, Solothurn), night shelters + soup kitchens in the largest
//    cities (Bern is in data/help.json and skipped here), national hotlines.
// Geocoding: swisstopo SearchServer; a hit counts only if house number, street word and postcode-or-town match.
// Canton comes from the swisstopo hit, else from the swissBOUNDARIES3D canton layer at the operator's pin.
// A failed live feed aborts the build (so a good file is never overwritten by a partial one) unless ALLOW_PARTIAL=1.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import assert from "node:assert/strict";

const OUT = process.argv[2] ?? "data/ch/help-ch.json";
const CHECKED = "2026-11-21";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36" };

// ---- sources (all read on CHECKED). gov = public authority page; everything else gets licence_unclear: true ----
const S = {
  tdd: { name: "Tischlein deck dich – operator map feed", url: "https://kkonlinerestapi.tischlein.ch/abgabestelle", live: true },
  caritas: { name: "Caritas-Markt – shop list on caritas-markt.ch", url: "https://caritas-markt.ch/de", live: true },
  efa: { name: "Essen für Alle – pick-up points", url: "https://www.essenfueralle.org/beziehen/", live: true },
  frigo: { name: "Madame Frigo – locations page", url: "https://www.madamefrigo.ch/de/standorte/", live: true },
  foodsharing: { name: "foodsharing – Fairteiler map API (Swiss points)", url: "https://foodsharing.de/api/map/markers/food-share-points", live: true },
  brocki: { name: "Heilsarmee brocki.ch – branch list", url: "https://www.brocki.ch/de/filialen/", live: true },
  ntBasel: { name: "Nette Toilette Basel flyer (Basel Tourismus / Kanton BS, Stand 06/24)", url: "https://www.basel.com/_Resources/Persistent/43e16ff08ce8b361ea8175385fc75924e10b1c14/netteToilette-Flyer-QR_2024-freigabe4_screen.pdf", gov: true },
  ntLuzern: { name: "Die netten Toiletten Luzern flyer 2025 (Stadt Luzern / Luzern Tourismus)", url: "https://www.luzern.com/fileadmin/Mediendatenbank/Luzern-Tourismus/PDF_Dokumente/LT_Nette-Toilette_Flyer_DE_2025.pdf", gov: true },
  ntSolothurn: { name: "nette Toilette Solothurn flyer (Stadtkanzlei Solothurn, 04.2025)", url: "https://mein.toubiz.de/api/v1/file/9e96098a-c9ed-4b55-a137-961dc0f67bba/dd5cde20e997189780e47418d7015a439c1ce7eb11c3a6ffa4ec0821f19c1f3c/view", gov: true },
  zhShelter: { name: "Heilsarmee Soziale Beratungsstelle Zürich – Notunterkünfte (akt. 30.06.2026)", url: "https://sozialberatung-zuerich.heilsarmee.ch/wp-content/uploads/sites/151/2026/07/2.1.-Wohnen-bei-drohender-Obdachlosigkeit-Notunterkuenfte.pdf" },
  zhFood: { name: "Heilsarmee Soziale Beratungsstelle Zürich – Lebensmittelhilfe & Mahlzeiten (akt. 30.09.2026)", url: "https://sozialberatung-zuerich.heilsarmee.ch/wp-content/uploads/sites/151/2026/10/1.1.-Lebensmittelhilfe-Mahlzeiten.pdf" },
  zhCity: { name: "Stadt Zürich – Notschlafstelle", url: "https://www.stadt-zuerich.ch/de/lebenslagen/unterstuetzung-und-beratung/persoenliche-beratung/wohnungs-obdachlosigkeit/notschlafstelle.html", gov: true },
  winShalom: { name: "Winterthur-Glossar – Associazione Shalom, Gassenküche", url: "https://www.winterthur-glossar.ch/mpdf/createPDF/associanzione-shalom" },
  bsShelter: { name: "Kanton Basel-Stadt – Notschlafstellen (aktualisiert 01.07.2026)", url: "https://www.bs.ch/themen/persoenliches-und-wohnen/wohnen/soziales-wohnen-und-notwohnen/notschlafstellen", gov: true },
  bsGk: { name: "Gassenküche Basel", url: "https://www.gassenkueche-basel.ch/" },
  geRichemont: { name: "Ville de Genève – Abri PC de Richemont (modifié 04.05.2026)", url: "https://www.geneve.ch/abri-richemont", gov: true },
  geLeaflet: { name: "Ville de Genève – Lieux d'accueil d'urgence, juillet 2026", url: "https://www.geneve.ch/document/feuillet-lieux-accueil-urgence-juillet-2026", gov: true },
  geDispositif: { name: "Ville de Genève – Dispositif d'hébergement d'urgence (modifié 20.11.2026)", url: "https://www.geneve.ch/themes/social/precarite-abri/hebergements-urgence/dispositif-ville-geneve", gov: true },
  lsShelter: { name: "Ville de Lausanne – Hébergement d'urgence (mise à jour 25.09.2026)", url: "https://www.lausanne.ch/hebergement-urgence", gov: true },
  lsSoupe: { name: "Fondation Mère Sofia – La Soupe populaire", url: "https://www.meresofia.ch/" },
  luShelter: { name: "Verein Jobdach – Notschlafstelle Luzern", url: "https://jobdach.ch/notschlafstelle/" },
  luGk: { name: "Tragwerk Luzern – Gassechuchi K+A", url: "https://www.tragwerk-luzern.ch/angebote/gassechuchi_ka" },
  sgUfo: { name: "Stadt St.Gallen – Angebote für Obdachlose", url: "https://www.stadt.sg.ch/home/gesellschaft-sicherheit/soziales/angebote-obdachlose.html", gov: true },
  sgGk: { name: "Stiftung Suchthilfe – Kontakt Gassenküche", url: "https://stiftung-suchthilfe.ch/kontakt-gassenkueche.html?articles=kontakt-gassenkueche" },
  lgBethlehem: { name: "Fondazione Francesco – Centro sociale Bethlehem", url: "https://fondazionefrancesco.ch/centro-bethlehem/" },
  biSleep: { name: "Sleep-In Biel/Bienne", url: "https://www.sleep-in-biel.ch/" },
  biGk: { name: "Gassenküche Biel – Öffnungszeiten / Preise", url: "http://www.gassenkueche-biel.ch/de/oeffnungszeiten.php" },
  caritasRules: { name: "Caritas-Markt – Günstig einkaufen (eligibility)", url: "https://caritas-markt.ch/de/guenstig-einkaufen" },
  kapoTg: { name: "Kantonspolizei Thurgau – Notrufnummern-Karte", url: "https://kapo.tg.ch/public/upload/assets/15256/Notrufnummern-Karte.pdf?fp=1", gov: true },
  tox: { name: "Tox Info Suisse", url: "https://www.toxinfo.ch/" },
  rega: { name: "Rega", url: "https://www.rega.ch/" },
  h143: { name: "Die Dargebotene Hand 143", url: "https://www.143.ch/" },
  h147: { name: "Pro Juventute 147", url: "https://www.147.ch/de/" },
  h142: { name: "Opferhilfe Schweiz 142", url: "https://www.opferhilfe-schweiz.ch/de/" },
};
const LICENCE_NOTE = null; // no source states a licence

const FIELDS = ["id", "network", "category", "name", "organisation", "address", "postcode", "city", "canton", "lat", "lon", "phone", "website",
  "opening_hours", "who_for", "cost", "notes", "source_url", "source_checked", "confidence", "licence_unclear"];
const item = (src, o) => ({ ...Object.fromEntries(FIELDS.map((f) => [f, null])), source_url: S[src].url, source_checked: CHECKED,
  licence_unclear: !S[src].gov, _src: src, ...o });

function slug(s) {
  return s.toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
assert.equal(slug("Café Tscharni – Bümpliz"), "cafe-tscharni-bumpliz");

async function get(url, as = "text", tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return as === "json" ? await res.json() : await res.text();
    } catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 1000 * i)); }
  }
}
async function mapLimit(arr, n, fn) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(...(await Promise.all(arr.slice(i, i + n).map(fn))));
  return out;
}
const km = (a, b) => { // haversine, [lat, lon]
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
assert(Math.abs(km([46.948, 7.4474], [47.3769, 8.5417]) - 95.5) < 1);

// ---- live feeds ----
const fetched = {};
async function feed(key, fn) {
  try { const r = await fn(); fetched[key] = true; return r; } catch (e) {
    fetched[key] = false; console.error(`FEED FAILED ${key}: ${e.message}`);
    if (process.env.ALLOW_PARTIAL !== "1") throw e;
    return [];
  }
}
const DAY = { Montag: "Mon", Dienstag: "Tue", Mittwoch: "Wed", Donnerstag: "Thu", Freitag: "Fri", Samstag: "Sat", Sonntag: "Sun" };
function hm(t) { const [h, m] = t.split("."); return `${h.padStart(2, "0")}:${(m ?? "00").padEnd(2, "0")}`; }
assert.equal(hm("9.00"), "09:00"); assert.equal(hm("16.15"), "16:15");

const tdd = await feed("tdd", async () => {
  const rows = await get(S.tdd.url, "json");
  assert(rows.length >= 150, `Tischlein feed: only ${rows.length} rows`);
  return rows.map((r) => {
    const name = r.firma1.replace(/^AS /, "");
    const pin = r.koordinaten?.split(",").map(Number);
    return item("tdd", {
      id: "tdd-" + slug(name), network: "tischlein-deck-dich", category: "food_distribution", name: `Tischlein deck dich – ${name}`,
      organisation: ["Tischlein deck dich", r.firma2].filter(Boolean).join(" / "), _street: r.strasse, _plz: r.plz, _town: r.ort,
      phone: r.telefon_direkt || r.telefon || null, website: "https://www.tischlein.ch/",
      opening_hours: `${DAY[r.oeffnung_wochentag] ?? r.oeffnung_wochentag} ${hm(r.oeffnung_zeit_start)}-${hm(r.oeffnung_zeit_end)}` + (r.bemerkung_oeffnungszeit ? ` (${r.bemerkung_oeffnungszeit})` : ""),
      who_for: "People in need with a Tischlein deck dich customer card (issued by selected social agencies after checking the household's finances; valid one year)",
      cost: "CHF 1 per visit (per Heilsarmee Zürich directory 30.09.2026; not stated in the feed)",
      notes: "Bring your own bag. Card holders pick one fixed distribution point.", _pin: pin?.length === 2 && pin.every(Boolean) ? pin : null, confidence: "high",
    });
  });
});

const caritas = await feed("caritas", async () => {
  const h = await get(S.caritas.url);
  const out = [];
  for (const b of h.split('<div id="modal-').slice(1)) {
    const body = b.slice(0, b.indexOf("uk-modal-footer"));
    const title = body.match(/modal-title">(.*?)</)?.[1];
    const ps = [...body.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").split("\n").map((s) => s.trim()).filter(Boolean));
    const [addr, hours] = [ps[0], ps[1]];
    if (!addr) continue; // "Projekte" (Genf West, Zürich West) have no address
    const zi = addr.findIndex((l) => /^\d{4} /.test(l));
    assert(zi > 0, `Caritas-Markt ${title}: no postcode line`);
    const [, plz, town] = addr[zi].match(/^(\d{4}) (.+)$/);
    out.push(item("caritas", {
      id: "caritas-markt-" + slug(title), network: "caritas-markt", category: "food_distribution", name: `Caritas-Markt ${title}`, organisation: "Caritas-Markt (Genossenschaft)",
      _street: addr[0], _plz: plz, _town: town, phone: addr.slice(zi + 1).find((l) => /^\d{3} \d{3}/.test(l)) ?? null, website: "https://caritas-markt.ch/",
      opening_hours: hours?.slice(1).join("; ").replace(/\s*Uhr/g, "") || null,
      who_for: "Only people on social assistance, AHV/IV supplementary benefits, premium subsidies, scholarships, income at subsistence level, permit N/F/S, sans-papiers, or KulturLegi holders",
      cost: "Discount shop (low prices); customer card free (applied for via kulturlegi.ch)",
      notes: [addr.slice(1, zi).join(" ") || null, `Eligibility: ${S.caritasRules.url}`].filter(Boolean).join(". "), confidence: "high",
    }));
  }
  assert(out.length >= 20, `Caritas-Markt: only ${out.length} shops`);
  return out;
});

const efa = await feed("efa", async () => {
  const h = (await get(S.efa.url)).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  // shortcut: rows hand-listed from the page and checked against it on each build; upgrade to a parser if the page layout is stable
  const rows = [["Zürich", "Im Holzerhurd 60", "8046", "Zürich", "Sat 11:00-16:00 (by card colour)"], ["Schwyz", "Franzosenstrasse 46", "6423", "Seewen SZ", "Sat 11:00-13:00"],
    ["Chur", "Planaterra 11", "7000", "Chur", "Sat 11:00-13:00"], ["Glarus", "Burgstrasse 26", "8750", "Glarus", "Sat 11:00-12:00"],
    ["Biel/Bienne", "Quai du Bas 28", "2503", "Biel/Bienne", "Sat 11:00-13:00"]];
  for (const r of rows) assert(h.includes(r[1]), `Essen für Alle page no longer lists ${r[1]}`);
  return rows.map(([n, street, plz, town, oh]) => item("efa", {
    id: "essen-fuer-alle-" + slug(n), network: "essen-fuer-alle", category: "food_distribution", name: `Essen für Alle – ${n}`, organisation: "Verein Essen für Alle",
    _street: street, _plz: plz, _town: town, website: "https://www.essenfueralle.org/", opening_hours: oh,
    who_for: "People who depend on free food; people without papers welcome", cost: "free; one-off CHF 5 registration (cash) for the pick-up card",
    notes: "First visit: ID or health-insurance card for every family member; bring sturdy bags.", confidence: "high",
  }));
});

const frigo = await feed("frigo", async () => {
  const fh = await get(S.frigo.url);
  // each fridge is printed as a PHP array dump: [ID], [title], [address] => Array([street], [plz], [city]), [lat]/[lng]
  const out = fh.split("<pre>Array").slice(1).map((b) => {
    const g = (re) => b.match(re)?.[1]?.trim();
    const street = g(/\[street\] => (.*)/), title = g(/\[title\] => (.*)/);
    return item("frigo", {
      id: "frigo-" + g(/\[ID\] => (\d+)/), network: "madame-frigo", category: "public_fridge", name: `Madame Frigo – ${title}`, organisation: "Madame Frigo (volunteers)",
      _street: street.replace(/\s+[–-]\s+.*$/, ""), _plz: g(/\[plz\] => (.*)/), _town: g(/\[city\] => (.*)\n\s*\[link\]/),
      _pin: [+g(/\[lat\] =>\s*([\d.]+)/), +g(/\[lng\] =>\s*([\d.]+)/)], website: "https://www.madamefrigo.ch/", cost: "free", who_for: "Everyone",
      notes: ["Bring food you don't need, take what you need.", /[–-]\s/.test(street) ? `Location detail: ${street}` : null].filter(Boolean).join(" "), confidence: "medium",
    });
  });
  assert(out.length >= 150, `Madame Frigo: only ${out.length} fridges`);
  return out;
});

// ---- canton lookup at a point (also our "inside Switzerland" test: no canton = outside) ----
const cantonAt = async ([lat, lon]) => (await get(`https://api3.geo.admin.ch/rest/services/api/MapServer/identify?geometry=${lon},${lat}&geometryType=esriGeometryPoint&sr=4326&layers=all:ch.swisstopo.swissboundaries3d-kanton-flaeche.fill&tolerance=0&returnGeometry=false`, "json")).results[0]?.attributes.ak ?? null;

const foodsharing = await feed("foodsharing", async () => {
  const markers = (await get(S.foodsharing.url, "json")).filter((p) => p.lat > 45.8 && p.lat < 47.85 && p.lon > 5.9 && p.lon < 10.5
    && !/frigo|geschlossen|aufgehoben/i.test(p.name)); // Madame Frigo fridges are already in the frigo feed
  const swiss = (await mapLimit(markers, 8, async (p) => ({ p, canton: await cantonAt([p.lat, p.lon]) }))).filter((x) => x.canton);
  const out = await mapLimit(swiss, 8, async ({ p, canton }) => {
    const d = await get(`https://foodsharing.de/api/food-share-points/${p.id}`, "json"); // creator/manager names deliberately not kept
    if (d.status !== 1) return null;
    return item("foodsharing", {
      id: "foodsharing-" + p.id, network: "foodsharing", category: "public_fridge", name: d.name.trim(), organisation: "foodsharing (volunteers)",
      _street: d.address?.street?.trim() || null, _plz: d.address?.postalCode?.trim() || null, _town: d.address?.city?.trim() || null,
      _pin: [d.location.lat, d.location.lon], _canton: canton, website: `https://foodsharing.de/fairteiler/${p.id}`, cost: "free", who_for: "Everyone",
      notes: "foodsharing Fairteiler (shared food cupboard/fridge). Rules and access times are in the free-text description on the website.",
      source_url: `https://foodsharing.de/fairteiler/${p.id}`, confidence: "medium",
    });
  });
  return out.filter(Boolean);
});

const brocki = await feed("brocki", async () => {
  const h = await get(S.brocki.url);
  const seen = [];
  const out = [];
  for (const m of h.matchAll(/data-lat="([\d.]+)" data-lng="([\d.]+)"><a class="filialen__item-title" href="([^"]+)">([^<]+)<\/a>(?:<div class="filialen__item-extra">(.*?)<\/div>)?/g)) {
    const [, lat, lon, href, title, extra] = m, pin = [+lat, +lon];
    if (seen.some((p) => km(p, pin) < 0.1)) continue; // Biel/Bienne is listed in both the German and French lists
    seen.push(pin);
    const lines = extra?.split("<br>").map((s) => s.trim()) ?? [];
    const [, plz, town] = lines.at(-1)?.match(/^(\d{4}) (.+)$/) ?? [];
    // the site gives Baar the Bern address: drop an address whose town has nothing to do with the branch name
    const sameTown = town && slug(town).split("-").some((w) => w.length > 3 && slug(title).includes(w));
    out.push(item("brocki", {
      id: "brocki-" + slug(title), network: "heilsarmee-brocki", category: "second_hand", name: `Heilsarmee Brocki ${title}`, organisation: "Stiftung Heilsarmee Schweiz (brocki.ch)",
      _street: sameTown ? lines.slice(0, -1).join(", ") : null, _plz: sameTown ? plz : null, _town: sameTown ? town : title.replace(/ (SG|AG)$/, ""), _pin: pin,
      website: href, cost: "paid (second-hand shop prices)", who_for: "Everyone",
      notes: [sameTown || !town ? null : `brocki.ch lists the address '${lines.join(", ")}' for this branch, which does not match its name; coordinates are the site's map pin.`,
        "Second-hand clothing, furniture and household goods; not free."].filter(Boolean).join(" "), confidence: town && !sameTown ? "low" : "medium",
    }));
  }
  assert(out.length >= 15, `brocki.ch: only ${out.length} branches`);
  return out;
});

// ---- hand-copied: Nette Toilette flyers ----
const nette = (src, cityName, rows, cost) => rows.map(([name, street, oh, notes]) => item(src, {
  id: `nette-toilette-${slug(cityName)}-${slug(name)}`, network: "nette-toilette", category: "toilets_partner", name: `Nette Toilette – ${name}`,
  _street: street, _town: cityName, opening_hours: oh, cost, who_for: "Everyone (no purchase needed per the scheme)",
  notes: ["Look for the 'nette Toilette' sticker at the entrance; only during the venue's opening hours.", notes].filter(Boolean).join(" "),
  confidence: "medium",
}));
const A = "Flyer icons: wheelchair accessible", W = "baby changing table";
const ntBasel = nette("ntBasel", "Basel", [
  ["Restaurant Gundeli Casino", "Tellplatz 6", "Mo-Sa 8-24; Su/PH 8-24", `${A}, ${W}. Flyer spells the street 'Tellpaltz'.`],
  ["Zum Kuss", "Elisabethenstrasse 59", "Mo-Tu 9.30-22; We-Fr 9.30-23; Sa 9.30-18; Su/PH closed", `${A}, ${W}.`],
  ["Nomad Design & Lifestyle Hotel", "Brunngässlein 8", "Mo-Sa 6.30-23; Su/PH 6.30-23", `${A}, ${W}.`],
  ["Bistro Kunstmuseum", "St. Alban-Graben 16", "Mo closed; Tu-Su 9-19, We 9-20; Sa, Su/PH 9-19", `${A}.`],
  ["Offene Kirche Elisabethen", "Elisabethenstrasse 10", "Mo-Sa 10-19; Su/PH 12-19", `Flyer icons: ${W}.`],
  ["kult.kino.atelier", "Theaterstrasse 7", "Mo-Sa 11.30-22; Su/PH 11.30-22", `${A}.`],
  ["Brasserie Küchlin", "Steinenvorstadt 55", "Mo-Th 11-23; Fr-Sa 11-1.30; Su/PH closed", `${A}.`],
  ["Warenhaus Coop Restaurant Pfauen", "Freie Strasse 75", "Mo-We 8.30-19; Th-Fr 8.30-20; Sa 8.30-18; Su/PH closed", `${A}, ${W}.`],
  ["Restaurant Schlüsselzunft", "Freie Strasse 25", "Mo-Sa 9-23.30; Su/PH 11.30-22", `${A}, ${W}.`],
  ["Coop Restaurant City am Marktplatz", "Gerbergasse 4", "Mo-We 8.30-19; Th-Fr 8.30-20; Sa 8.30-18; Su/PH closed", `${A}, ${W}.`],
  ["Confiserie Schiesser", "Marktplatz 19", "Mo-Sa 9-18; Su/PH 10-18", null],
  ["Brasserie Baselstab", "Marktplatz 30", "Mo-Fr 9-22; Sa 9-23; Su/PH 9-22", null],
  ["Restaurant Schnabel", "Trillengässlein 2", "Mo-Tu 10-14, 17-23; We-Fr 10-14, 17-24; Sa 10-24; Su/PH closed", null],
  ["Restaurant Löwenzorn", "Gemsberg 2", "Mo-Fr 11-14, 16.30-24; Sa 12-01; Su/PH 14-23", `Flyer icons: ${W}. Flyer address: 'Gembsberg 2-4'.`],
  ["Spale Bar", "Spalenberg 53", "Tu-We 9-22; Th-Fr 9-24; Sa 9-24; Su, Mo closed", null],
  ["Restaurant zur Harmonie", "Petersgraben 71", "Mo-Fr 11.30-14, 17-22; Sa 11.30-22; Su/PH closed", null],
  ["East West Hotel", "Rheingasse 8", "Mo-Sa 11-23; Su/PH 11-23", `${A}, ${W}.`],
  ["Hotel Krafft Basel", "Rheingasse 12", "Mo-Sa 12-23; Su/PH 12-23", `Flyer icons: ${W}.`],
  ["Consum Basel", "Rheingasse 19", "Mo-Fr 17-23; Sa 14-23; Su/PH 15-23", null],
  ["Restaurant Fischerstube", "Rheingasse 45", "Mo-Fr 16-22; Sa 14-22; Su/PH 14-22", null],
  ["Volkshaus Basel", "Rebgasse 12", "Mo 7-22; Tu-Th 7-23; Fr 7-24; Sa 8-24; Su/PH 8-11", `${A}, ${W}. Flyer address: 'Rebgasse 12-14'.`],
  ["LILY'S MAXIM", "Rebgasse 1", "Mo-Sa 11-22; Su/PH 11-22", `Flyer icons: ${W}.`],
  ["Klara Basel", "Clarastrasse 13", "Su-Th 11-24; Fr-Sa 11-1; Su/PH 11-24", `${A}, ${W}.`],
  ["Restaurant Café Papiermühle", "St. Alban-Tal 35", "Tu-Fr 11.30-18; Sa 11.30-18; Su/PH 10-18", `Flyer icons: ${W}.`],
  ["Gasthof zum Goldenen Sternen", "St. Alban-Rheinweg 70", "Summer Mo-Fr 11-23; winter Mo-Fr 11-14, 18-23; Sa 11-23; Su/PH 11-22", `${A}, ${W}.`],
  ["Spatz Basel Birskopf", "Birskopfweglein 7", "Mo-Th 14-23; Fr-Sa 14-24; Su/PH 10-23", null],
], "free (scheme by Kanton Basel-Stadt and Basel Tourismus)");
const ntLuzern = nette("ntLuzern", "Luzern", [
  ["Bacio della Mamma", "Seidenhofstrasse 5", "daily 08:00-22:00", "Flyer icon: wheelchair accessible."],
  ["Bar Capitol", "Zentralstrasse 45a", "Su-We 16:00-24:00; Th-Sa 16:00-02:00", null],
  ["Restaurant Ammos", "Reusssteg 11", "Mo/We/Th 11:30-22:00; Fr/Sa 11:30-22:30; Su 11:30-21:00", null],
  ["Hotel Rebstock", "St. Leodegar-Strasse 3", "daily 07:00-24:00", null],
  ["Ristorante La Fenice", "Rössligasse 2", "Mo-Fr 11:00-15:00, 17:00-23:00; Sa 11:00-23:00; Su 11:30-22:00", null],
  ["Krienbrüggli", "Bruggerstrasse 8", "daily 10:00-22:00", null],
  ["Wirtschaft Ente", "Buobenmatt 2", "Mo-We 11:00-22:00; Th/Fr 11:00-23:00; Sa 09:00-23:00; Su closed", null],
  ["Barbès-Restaurant-Bar", "Winkelriedstrasse 62", "Mo-Sa 10:00-24:30; Su closed", null],
  ["Restaurant Jodlerwirt", "Rütligasse 4", "Th 18:00-24:30; Fr/Sa 18:00-02:30", null],
  ["Hotel Ibis Styles Luzern City", "Friedenstrasse 8", "daily 10:00-23:00", null],
  ["Restaurant Basilico / Jeff's Burger", "Hirschmattstrasse 29", "Basilico Mo-Th 11:30-14:00, 17:30-22:30; Fr 11:30-14:00, 17:30-23:30; Sa 11:30-23:00; Su closed. Jeff's Burger daily 11:00-23:00", "Flyer icon: wheelchair accessible."],
  ["Bierliebe & Friends", "Rathausquai 10", "Su-We 11:00-23:00; Th-Sa 11:00-24:30", "Flyer icon: wheelchair accessible."],
  ["Restaurant Mill'Feuille", "Mühlenplatz 6", "Mo-Sa 07:30-23:00; Su 09:00-22:00", null],
  ["Restaurant Bar California", "Alpenstrasse 6", "Mo-Th 11:30-14:00, 17:30-24:00; Fr 11:30-14:00, 17:30-02:00; Sa 15:00-22:00; Su 14:00-24:00", null],
  ["Bottega Icilio", "Löwengraben 6", "Tu-Th 09:30-21:00; Fr 09:30-19:00; Sa 11:00-17:00; Su/Mo closed", null],
  ["Restaurant Parterre", "Mythenstrasse 7", "Mo-We 11:00-23:00; Th/Fr 11:00-24:30; Sa 09:00-24:30; Su 09:00-23:00", "Flyer icon: wheelchair accessible."],
  ["Hotel Beau Séjour Luzern", "Haldenstrasse 53", "Mo-Su 08:00-23:00", null],
  ["Restaurant Bündnerland", "Eisengasse 15", "Mo-We 17:30-22:00; Th/Fr 11:30-14:30, 17:30-22:00; Sa 11:30-22:30; Su 12:00-20:00", null],
  ["Hotel de la Paix", "Museggstrasse 2", "daily 09:00-22:00", null],
], null);
const ntSolothurn = nette("ntSolothurn", "Solothurn", [ // flyer items 1, 6, 16, 18 are public WCs, not partner venues: left out
  ["Hotel/Restaurant Baseltor", "Hauptgasse 79", "Mo-Sa 09:00-14:00, 17:45-23:00; Su 17:30-21:00", `Flyer icons: ${W}.`],
  ["Confiserie Suteria", "Hauptgasse 65", "Mo-Fr 07:00-18:30; Sa 07:00-17:00; Su/PH 09:00-17:00", `${A}, ${W}.`],
  ["Kino Palace", "Hauptgasse 57", "Mo-Su 19:15-22:00, during screenings", null],
  ["Cafébar Viktor", "Gurzelngasse 1", "Mo/We/Th/Fr 09:00-18:30; Sa 08:00-17:30; Tu, Su closed", null],
  ["Restaurant du Commerce", "Friedhofplatz 4", "Tu-Fr 09:30-23:00; Sa 09:00-23:00; Su, Mo closed", null],
  ["Cafébar Barock", "Landhausquai 5", "Mo-Th 07:00-00:30; Fr/Sa 07:00-02:30; Su 09:00-22:00", `Flyer icons: ${W}.`],
  ["Jugendherberge", "Landhausquai 23", "Mo-Su 08:00-21:00; closed December to February", null],
  ["Absinthe Bar Die Grüne Fee", "Kronengasse 11", "We/Th/Fr 17:00-00:30; Sa 16:00-00:30", null],
  ["Solheure Bar Restaurant Lounge", "Ritterquai 10", "Mo 17:00-23:00; Tu-Th 11:30-24:00; Fr/Sa 11:30-01:00; Su 11:30-21:00", `${A}, ${W}.`],
  ["Hafebar", "Kreuzackerquai", "April-September only, in good weather (days and hours vary by month, see flyer)", "No house number on the flyer; coordinates are a point on the street."],
  ["Vini al Grappolo", "Prisongasse 4", "Mo-Th 11:00-23:30; Fr/Sa 11:00-00:30; Su/PH closed", `${A}, ${W}.`],
  ["Restaurant Stadtrösterei", "Hauptbahnhofstrasse 7", "Mo-Fr 06:30-18:30; Sa 07:00-15:00; Su closed", `${A} (flyer: only partly), ${W}.`],
  ["H4 Hotel Solothurn", "Schänzlistrasse 5", "24 hours", `${A}.`],
  ["Alterszentrum Wengistein", "Kirchweg 2", "Mo-Su 08:00-17:00", `${A}, ${W}.`],
  ["Pizzeria & Restaurant Sternen", "Baselstrasse 47", "Tu-Sa 10:00-14:00, 17:00-23:30; Su 10:00-22:00", `Flyer icons: ${W}.`],
], null);

// ---- hand-copied: night shelters and soup kitchens in the largest cities (Bern: see data/help.json) ----
const local = (city, src, category, name, o) => item(src, { id: `${slug(city)}-${slug(name)}`, network: `local-${slug(city)}`, category, name, _town: city, ...o });
const LS_ACCESS = "Free. Adults living in Lausanne and accompanied minors with no other place to sleep. Reserve in person by day at the Bureau des réservations, Rue Saint-Martin 12 (Mon, Wed, Fri 14:00-16:45, closed on public holidays); no ID papers needed; shelters are often full.";
const GE = "Ville de Genève leaflet 'Lieux d'accueil d'urgence', July 2026 (no postcodes in the leaflet).";
const city = [
  // Zürich
  local("Zürich", "zhShelter", "shelter", "Notschlafstelle Rosengartenstrasse", { organisation: "Stadt Zürich", _street: "Rosengartenstrasse 30", _plz: "8037", phone: "044 415 77 14",
    opening_hours: "Open 365 days. 1 Oct-31 Mar 20:30-10:00; 1 Apr-30 Sep 21:00-10:00; admission until 00:30", cost: "free, no registration",
    who_for: "Adults (18+) living in the City of Zürich, with personal ID; no animals. The team decides on non-residents (one night in documented emergencies).",
    notes: `Men's site (LGBTIQ room available); normal stay one night, max. four months. Not wheelchair accessible (per ${S.zhCity.url}).`, confidence: "high" }),
  local("Zürich", "zhShelter", "shelter", "Notschlafstelle für Frauen Gerechtigkeitsgasse", { organisation: "Stadt Zürich", _street: "Gerechtigkeitsgasse 26", _plz: "8001", phone: "044 415 36 11",
    opening_hours: "Same as the men's site per stadt-zuerich.ch: 1 Oct-31 Mar 20:30-10:00; 1 Apr-30 Sep 21:00-10:00; admission until 00:30", cost: "free, no registration",
    who_for: "Women and female-read people (18+, living in the City of Zürich, with ID); female staff only",
    notes: "The Heilsarmee list calls it 'Winter-Notschlafstelle für Frauen'; the city page lists it as the women's Notschlafstelle (opened winter 2025/26). Confirm it is open.", confidence: "medium" }),
  local("Zürich", "zhShelter", "shelter", "Pfuusbus", { organisation: "Sozialwerk Pfarrer Sieber", _street: "Uetlibergstrasse 311a", _plz: "8045", phone: "044 537 58 90",
    opening_hours: "15 Nov-15 Apr, daily 19:00-09:00; admission until 00:00", cost: "free", who_for: "Homeless people 18+ with a residence permit",
    notes: "Dinner, breakfast, shower. Referrals also via the cold patrol (Kältepatrouille). Source writes 'Uetlibergerstrasse'; the official street name is Uetlibergstrasse.", confidence: "high" }),
  local("Zürich", "zhShelter", "shelter", "Notschlafstelle Iglu", { organisation: "Sozialwerk Pfarrer Sieber", _street: "Seebacherstrasse 15", _plz: "8052", phone: "044 537 58 80",
    opening_hours: "15 Nov-15 Apr, daily 19:00-08:00; admission until 00:00", cost: "free", who_for: "Job-seekers from abroad; max. 14 nights", notes: "Snacks, drinks, breakfast.", confidence: "high" }),
  local("Zürich", "zhShelter", "shelter", "Notschlafstelle Nemo", { organisation: "Sozialwerk Pfarrer Sieber", _street: "Döltschiweg 177", _plz: "8055", phone: "044 537 58 70",
    opening_hours: "Daily 17:00-09:00; admission 17:00-22:30", cost: "free", who_for: "Young people aged 16-23 with a settled residence status",
    notes: "Shower, laundry, dinner and breakfast; social work support.", confidence: "high" }),
  local("Zürich", "zhShelter", "shelter", "Ä Nacht schänke", { organisation: "Netz4 der EMK", _street: "Stauffacherstrasse 54", _plz: "8004", phone: "078 331 88 21",
    opening_hours: "Wednesday 21:00 to Thursday 08:00", cost: "free", who_for: "Homeless people", notes: "One night a week, in a church.", confidence: "high" }),
  local("Zürich", "zhFood", "soup_kitchen", "Gassencafé Sunestube", { organisation: "Sozialwerk Pfarrer Sieber", _street: "Konradstrasse 62", _plz: "8005", phone: "044 537 58 00",
    opening_hours: "Mon 11:00-18:00 (women only); Tue-Sun 06:30-11:00, 12:00-15:00", cost: "free", who_for: "People who are homeless or at risk of homelessness", notes: "Meals, snacks, drinks, information.", confidence: "high" }),
  local("Zürich", "zhFood", "soup_kitchen", "Gassenküche Speak-Out", { _street: "Häringstrasse 3", _plz: "8001", phone: "076 815 12 90",
    opening_hours: "Mon-Fri 18:30-21:30, warm meal from 20:00 (April-October closed Wednesday)", cost: "free", who_for: "People in an emergency situation", confidence: "high" }),
  local("Zürich", "zhFood", "soup_kitchen", "Gassenlokal Zueflucht Pace", { organisation: "Franziskanische Gassenarbeit", _street: "Magnusstrasse 20", _plz: "8004", phone: "043 488 61 29",
    opening_hours: "Winter (1 Nov-31 Mar): Mon-Sat 21:00-06:00 'Pace Nacht'; food distribution Wed 14:00-16:00. Summer (1 Apr-31 Oct): Fri 18:00-00:00, food distribution Wed 14:00-16:00",
    cost: "free", who_for: "People without a home", notes: "Free soup, tea and pastries; in winter also a place to sleep without beds; clothing store.", confidence: "high" }),
  local("Zürich", "zhFood", "soup_kitchen", "Café Yucca", { organisation: "Solidara Zürich", _street: "Häringstrasse 20", _plz: "8001", phone: "043 244 74 88",
    opening_hours: "Mon-Sat 10:30-13:00, 15:15-22:00; Sun 15:15-22:00", cost: "free soup; low-cost dinner", who_for: "Everyone", notes: "Also social advice.", confidence: "high" }),
  local("Zürich", "zhFood", "soup_kitchen", "Chrischtehüsli", { organisation: "Verein inklusiv", _street: "Cramerstrasse 11", _plz: "8004", phone: "044 241 62 42",
    opening_hours: "Tue, Thu 12:30-13:30 (lunch)", cost: "free", who_for: "People affected by poverty", confidence: "high" }),
  local("Zürich", "zhFood", "soup_kitchen", "Begegnungslokal Primero", { organisation: "Verein Incontro", _street: "Müllerstrasse 71", _plz: "8004",
    opening_hours: "Mon, Fri, Sat, Sun 15:00-19:30", cost: "free", who_for: "Everyone", notes: "Free coffee, cake and dinner; free medical advice Mondays from 15:00.", confidence: "high" }),
  local("Zürich", "zhFood", "soup_kitchen", "Imbiss HOPE", { organisation: "Heilsarmee Zürich Zentral", _street: "Ankerstrasse 31", _plz: "8004", phone: "044 242 53 89",
    opening_hours: "Mon, Wed 12:00-13:00", cost: "CHF 3", who_for: "People in need", notes: "Lunch followed by food distribution.", confidence: "high" }),
  local("Zürich", "zhFood", "soup_kitchen", "Imbiss54", { organisation: "Netz4", _street: "Stauffacherstrasse 54", _plz: "8004", phone: "078 331 66 22",
    opening_hours: "Fri 11:00-14:00", cost: "CHF 3", who_for: "People in need", notes: "Lunch followed by food distribution.", confidence: "high" }),
  local("Zürich", "zhFood", "soup_kitchen", "Suneboge", { organisation: "Wohn- und Arbeitsgemeinschaft Suneboge", _street: "Gerechtigkeitsgasse 5", _plz: "8001", phone: "044 202 13 66",
    opening_hours: "Lunch at 12:00", cost: "soup free; salad buffet with bread CHF 5; lunch or dinner CHF 8", who_for: "People affected by poverty", confidence: "high" }),
  local("Zürich", "zhFood", "soup_kitchen", "Treffpunkt City", { organisation: "Stadt Zürich", _street: "Wildbachstrasse 42", _plz: "8008", phone: "044 415 69 09",
    opening_hours: "Daily 10:15-17:30 (Tuesday women only)", cost: "free soup; low-cost meals", who_for: "Adults with social or mental-health difficulties",
    notes: "Also showers, laundry, internet, clothes swap.", confidence: "high" }),
  local("Zürich", "zhFood", "soup_kitchen", "Heilsarmee Molkenstrasse – free soup", { organisation: "Heilsarmee Zürich (Wohnen und Begleiten)", _street: "Molkenstrasse 6", _plz: "8004", phone: "044 298 90 00",
    opening_hours: "Daily at 17:00 except Saturday", cost: "free", who_for: null, confidence: "high" }),
  // Winterthur
  local("Winterthur", "zhShelter", "shelter", "Durchgangsheim Anker", { organisation: "Heilsarmee Winterthur", _street: "Habsburgstrasse 29", _plz: "8400", phone: "052 226 01 61",
    opening_hours: "Daily 19:00-09:00; admission until 23:00; closed during the day", cost: "cost guarantee (Kostengutsprache) needed",
    who_for: "Homeless and roofless people", notes: "Dormitory beds, breakfast, washing, basic medical care.", confidence: "high" }),
  local("Winterthur", "winShalom", "soup_kitchen", "Gassenküche Associazione Shalom", { organisation: "Associazione Shalom", _street: "Geiselweidstrasse 53", _plz: "8400",
    opening_hours: "Weekdays, lunch (exact times not stated)", cost: "CHF 4 for people in need, more for others (as described in the glossary article)",
    who_for: "Everyone; mainly people in financial hardship", notes: "Source is a city-library encyclopaedia article (photo 2017), not the operator; confirm before relying on it.", confidence: "low" }),
  // Basel
  ...[["Notschlafstelle für Frauen", "Mittlere Strasse 37", "4056", "+41 61 267 49 39", "Women; 18 places in 2-3 bed rooms with own shower/WC"],
    ["Notschlafstelle für Männer", "Alemannengasse 1", "4058", "+41 61 681 18 19", "Men; 76 places, 4-6 beds per room"]].map(([n, st, plz, ph, w]) =>
    local("Basel", "bsShelter", "shelter", n, { organisation: "Kanton Basel-Stadt", _street: st, _plz: plz, phone: ph,
      opening_hours: "Mon-Sat 20:00-08:00; Sun 20:00-09:00; last admission midnight", cost: "CHF 7.50 per night (cash or cost guarantee)",
      who_for: `Homeless people registered in Basel-Stadt (people from other cantons are not admitted). ${w}`, notes: "No registration needed; no pets; free laundry.", confidence: "high" })),
  local("Basel", "bsGk", "soup_kitchen", "Gassenküche Basel", { _street: "Markgräflerstrasse 14a", _plz: "4057", phone: "061 691 16 78",
    opening_hours: "Mon-Fri breakfast 07:30-09:15, dinner 17:15-19:15; Sun brunch 09:30-11:00", cost: "breakfast and brunch free; dinner free or CHF 3 for a warm plate",
    who_for: "Everyone in need, no questions asked", confidence: "high" }),
  // Genève
  local("Genève", "geRichemont", "shelter", "Abri PC de Richemont", { organisation: "Ville de Genève, Service social", _street: "Route de Frontenex 72", _plz: "1208", phone: "+41 22 418 97 86",
    opening_hours: "Daily 19:00-08:00", cost: "free, subject to admission criteria",
    who_for: "Homeless people; 80 places (50 men, 27 women, 3 emergency)",
    notes: "No direct admission: first call the free line 0800 22 22 10 (Mon-Fri 10:30-20:00, Sat-Sun 15:00-20:00), then reception at the Club social rive droite. Evening meal, breakfast, showers, luggage storage.", confidence: "high" }),
  ...[["Club social rive gauche", "Ville de Genève, Service social", "Rue Hugo-de-Senger 4", "Mon-Fri breakfast 08:00-09:15, lunch in 3 services 11:00/12:00/13:00; Sat lunch 11:00-12:00 (take-away only); Sun lunch 11:00/12:00/13:00", "Meal tickets Mon-Fri from 08:00, Sun from 10:30."],
    ["Le CARÉ", null, "Rue du Grand-Bureau 13", "Mon, Tue, Wed, Fri brunch 08:40-10:00 and 13:30-15:00; Thu brunch 08:40-10:00; Mon-Fri lunch at table 12:00-13:00; Sat lunch 11:45-13:00 (December-March)", "Closed the 3rd Thursday of the month. Also showers and emergency clothing on request."],
    ["Jardin de Montbrillant / Bus Car Touche", "Carrefour-Rue", "Rue de Montbrillant 3", "Tue, Wed breakfast 09:00-11:00 and lunch 11:00-12:30; Thu-Sat lunch 11:00-12:30; Sun lunch 11:00-12:30 (1st Sunday of the month)", "Breakfast at the Bus Car Touche, meals at the Jardin de Montbrillant."],
    ["Le Bateau Genève", null, "Quai Gustave-Ador", "Mon-Fri breakfast 07:30-09:30; Mon, Thu hot meal 10:00-11:00; Tue, Wed, Fri hot drinks 09:30-11:00; Sun dinner 17:00-19:30 (twice a month, alternating with Resto'Scout)", "No house number on the leaflet; coordinates are a point on the quay."],
    ["La Galerie / Resto'Scout", null, "Rue de l'Industrie 13", "La Galerie: Sun lunch 12:00-13:00. Resto'Scout: Sun meal 17:00-19:30 (twice a month, alternating with Le Bateau)", null],
    ["Espace Parents-Enfants de Saint-Gervais", "Ville de Genève", "Rue du Temple 8", "Mon-Fri lunch 12:00", "Leaflet address: 'Rue du Temple 8-10'."],
    ["Le Phare", "Armée du Salut", "Rue Jean-Jacques-de-Sellon 3", "Tue, Thu café-soupe 10:00-14:00; Fri café-soupe-repas 10:00-14:00; Sat breakfast 09:00-11:30", "Eat on site."],
    ["Caravane de solidarité", null, "Rue de la Navigation 19", "Sat hot meal 12:00", "Social advice and emergency help Mon-Fri 15:00-19:00."],
    ["SGS Solidarité Pâquis", null, "Place de la Navigation", "Sat lunch 12:00", "No house number on the leaflet; coordinates are a point on the square."],
    ["Refettorio Geneva", null, "Rue de Lyon 120", "Mon-Fri lunch 12:00-13:30 (doors 11:30), dinner 18:00 (doors 17:30)", "Meal tickets: lunch at Le Phare and on site; dinner tickets at Le CARÉ, La Roseraie, and Tue-Fri also Jardin de Montbrillant, Le Phare, Le Bateau."],
    ["Femmes à Bord", null, "Avenue de Riant-Parc 23", "Mon, Thu meal 10:30-14:30; Tue hot drinks and snack 14:00-17:00", "Women only, no children. 1st Tuesday of the month: outing."],
  ].map(([n, org, st, oh, nt]) => local("Genève", "geLeaflet", "soup_kitchen", n, { organisation: org, _street: st, opening_hours: oh, cost: null,
    who_for: n === "Femmes à Bord" ? "Women" : "People who are homeless or in precarious situations", notes: [nt, GE].filter(Boolean).join(" "), confidence: "high" })),
  // Lausanne
  ...[["Etape Saint-Martin", null, "Rue Saint-Martin 16", "1003", "+41 21 315 72 69", "Every night 21:00-08:00", "45 places."],
    ["La Marmotte", "Armée du Salut", "Rue du Vallon 17", "1005", "+41 21 311 79 12", "Every night 21:00-08:00", "Up to 31 people; evening meal and morning snack for residents."],
    ["Sleep-In", null, "Chemin de l'Usine à gaz 10", "1020", "+41 21 625 66 77", "Every night 21:00-09:00", "Up to 26 people. In Renens."],
    ["Tivoli 12", "Ville de Lausanne", "Avenue de Tivoli 12", "1007", "+41 79 890 27 71", "Every night 21:00-08:00", "49 places, all year."],
    ["Berne 34", "Ville de Lausanne", "Route de Berne 34", null, "+41 79 669 98 97", "Every night 21:00-08:00", "62 places, some reserved for women."]]
    .map(([n, org, st, plz, ph, oh, nt]) => local(n === "Sleep-In" ? "Renens" : "Lausanne", "lsShelter", "shelter", n, { id: `lausanne-${slug(n)}`, network: "local-lausanne",
      organisation: org, _street: st, _plz: plz, phone: ph, opening_hours: oh, cost: "free", who_for: LS_ACCESS, notes: nt, confidence: "high" })),
  local("Lausanne", "lsSoupe", "soup_kitchen", "La Soupe populaire", { organisation: "Fondation Mère Sofia", _street: "Rue Saint-Martin 12", _plz: "1003", phone: "078 626 43 22",
    opening_hours: "Mon-Tue 19:30-21:30; Wed-Sun 12:00-13:30 and 19:30-21:30", cost: null, who_for: null, website: "https://meresofia.ch/la-soupe-populaire", confidence: "high" }),
  // Luzern
  local("Luzern", "luShelter", "shelter", "Notschlafstelle Luzern", { organisation: "Verein Jobdach", _street: "Neuweg 3", _plz: "6003", phone: "041 202 03 30",
    opening_hours: "Daily 21:00-10:00; admission until midnight", cost: "CHF 10 incl. dinner and breakfast (two CHF 5 vouchers, cash, or paid by social services)",
    who_for: "People with a Swiss residence permit in an emergency", notes: "Separate sleeping rooms for women and men.", confidence: "high" }),
  local("Luzern", "luGk", "soup_kitchen", "Gassechuchi", { organisation: "Tragwerk Luzern", _street: "Geissensteinring 24", _plz: "6005", phone: "041 252 26 40",
    opening_hours: "Mon, Wed, Thu, Fri 09:30-17:00; Tue 10:30-17:00; Sat-Sun 10:00-16:45; lunch daily 12:00-13:30", cost: "lunch CHF 5",
    who_for: "People affected by addiction and poverty", notes: "Same building as the K+A contact point (from 17:00/17:15).", confidence: "high" }),
  // St. Gallen
  local("St. Gallen", "sgUfo", "shelter", "Unterkunft für Obdachlose (UFO), Haus zur Grünhalde", { organisation: "Stadt St.Gallen, Soziale Dienste", _street: "Grünhaldenstrasse 3", _plz: "9000", phone: "+41 71 224 61 90",
    opening_hours: "19:00-09:00", cost: null, who_for: "Homeless people", notes: "8 places in 2-3 bed rooms, 2 reserve places, 1 emergency bed; bed, meals, washing, basic medical care.", confidence: "high" }),
  local("St. Gallen", "sgGk", "soup_kitchen", "Gassenküche St.Gallen", { organisation: "Stiftung Suchthilfe", _street: "Linsebühlstrasse 82", _plz: "9000", phone: "071 222 30 03",
    opening_hours: "Daily 11:00-17:00", cost: "low-cost meals (price not stated on source)", who_for: "Adults; focus on people with addiction or mental-health problems", confidence: "high" }),
  // Lugano
  local("Lugano", "lgBethlehem", "soup_kitchen", "Centro sociale Bethlehem", { organisation: "Fondazione Francesco per l'aiuto sociale", _street: "Via Trevano 2", _plz: "6948", _town: "Porza", phone: "091 605 30 40",
    opening_hours: "Mon, Wed, Fri 09:30-19:30; Tue, Thu, holidays 09:30-14:30. Lunch 11:30-13:00 (take-away 12:30-13:00), dinner 18:00-19:00",
    cost: "small contribution, or help with a practical task", who_for: "Everyone, regardless of social or legal status", notes: "At the Masseria della Solidarietà (Porza, next to Lugano). Also shower and luggage storage.", confidence: "high" }),
  // Biel/Bienne
  local("Biel/Bienne", "biSleep", "shelter", "Sleep-In Biel/Bienne", { _street: "Mattenstrasse 13", _plz: "2503", phone: "+41 32 322 02 03",
    opening_hours: "Evening 20:00-00:30; morning 09:00-10:30; closed during the day", cost: null, who_for: null, notes: "Source page has no date.", confidence: "medium" }),
  local("Biel/Bienne", "biGk", "soup_kitchen", "Gassenküche Biel / Cuisine populaire", { _street: "Oberer Quai 52", _plz: "2503", phone: "+41 32 322 84 85",
    opening_hours: "Summer (1 May-30 Oct): Sun-Fri 12:00-13:30 (Tue 12:00-13:00), daily 18:00-21:00. Winter (1 Nov-30 Apr): Sun-Fri 12:00-21:00, Tue 12:00-13:00 and 17:00-21:00, Sat 14:00-21:00",
    cost: "menu CHF 5 with salad and drink (children up to 12 free); soup and bread free in winter; coffee CHF 1; shower free; laundry CHF 2", who_for: "Everyone", confidence: "high" }),
];

// ---- national hotlines (no addresses; never a domestic-violence shelter address) ----
const hl = (number, name, purpose, src, o = {}) => ({ id: "hotline-" + number.replace(/\D/g, ""), number, name, purpose, hours: null, cost: null, scope: "Switzerland",
  notes: null, source_url: S[src].url, source_checked: CHECKED, ...o });
const hotlines = [
  hl("112", "European emergency number", "General emergency; handled by the police", "kapoTg", { hours: "24/7" }),
  hl("117", "Police", "Police emergency", "kapoTg", { hours: "24/7" }),
  hl("118", "Fire service", "Fire emergency", "kapoTg", { hours: "24/7" }),
  hl("144", "Ambulance", "Medical emergency", "kapoTg", { hours: "24/7" }),
  hl("145", "Tox Info Suisse", "Poisoning: medical advice", "tox", { hours: "24/7" }),
  hl("1414", "Rega", "Air rescue", "rega"),
  hl("143", "Die Dargebotene Hand / La Main Tendue / Telefono Amico", "Anonymous emotional support by phone; also chat and mail", "h143",
    { notes: "English: 0800 143 000, 18:00-23:00. Cost per call not stated on the source page." }),
  hl("147", "Pro Juventute", "Counselling for children and young people", "h147",
    { hours: "Phone 24/7; WhatsApp daily 07:30-22:00", cost: "free, does not show on the phone bill", notes: "Email beratung@147.ch (reply within 24 h); peer chat Mon-Thu 19:00-22:00." }),
  hl("142", "Opferhilfe (victim support)", "Advice for people harmed by physical, psychological or sexual violence and their relatives; not an emergency number", "h142",
    { cost: "free and anonymous", notes: "Nationwide since 1 May 2026. In acute danger call 117 or 144." }),
  hl("0800 22 22 10", "Genève – emergency accommodation line", "Entry point to all emergency night shelters of the Ville de Genève", "geDispositif",
    { hours: "Mon-Fri 10:30-20:00; Sat-Sun 15:00-20:00", cost: "free call", scope: "Ville de Genève" }),
];

// ---- geocoding ----
const de = (x) => x.toLowerCase().replace(/ß/g, "ss").replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").normalize("NFD").replace(/[̀-ͯ]/g, "");
// detail looks like "rosengartenstrasse 30 8037 zuerich 261 zuerich ch zh". Same house number (if any), the street's longest
// word, and same postcode or same town (postbox postcodes are not address postcodes, so town alone is enough).
function addrOk(detail, street, plz, town) {
  const m = de(detail).match(/^(.*?) (?:(\d+)[\w.]* )?(\d{4}) (.*) ch (\w\w)$/);
  if (!m) return false;
  const num = street.match(/ (\d+)[a-z]?(?:-\d+)?$/i)?.[1];
  const word = de(street).replace(/\d.*$/, "").split(/[ \-'’.]+/).sort((a, b) => b.length - a.length)[0];
  const t = de(town ?? "").split(/[ \-/]+/)[0].replace(/[^a-z]/g, "");
  return (num ? m[2] === num : true) && m[1].includes(word) && (m[3] === plz || (t.length > 1 && m[4].replace(/[^a-z ]/g, "").split(" ").some((w) => w === t)));
}
assert(addrOk("rosengartenstrasse 30 8037 zuerich 261 zuerich ch zh", "Rosengartenstrasse 30", "8037", "Zürich"));
assert(addrOk("rue hugo-de-senger 4 1205 geneve 6621 geneve ch ge", "Rue Hugo-de-Senger 4", null, "Genève"));
assert(addrOk("schwamendingenstrasse 41 8050 zuerich 261 zuerich ch zh", "Schwamendingenstrasse 41", "8050", "Zürich-Oerlikon"));
assert(addrOk("freie strasse 75 4051 basel 2701 basel ch bs", "Freie Straße 75", null, "Basel"));
assert(addrOk("rebgasse 12 4058 basel 2701 basel ch bs", "Rebgasse 12-14", null, "Basel"));
assert(!addrOk("bahnhofplatz 2 9100 herisau 3001 herisau ch ar", "Bahnhofplatz 2", "3001", "Bern"));
assert(!addrOk("bahnhofplatz 12 3011 bern 351 bern ch be", "Bahnhofplatz 2", "3011", "Bern"));
assert(!addrOk("rue de carouge 53 1227 carouge 6608 carouge ch ge", "Rue de Carouge 53", "1205", "Genf"));

async function geocode(street, plz, town) {
  const q = [street, plz, town].filter(Boolean).join(" ");
  const j = await get(`https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=${encodeURIComponent(q)}&type=locations&origins=address&sr=4326&limit=5`, "json");
  const hit = j.results.find((r) => addrOk(r.attrs.detail, street, plz, town));
  if (!hit) return null;
  const m = de(hit.attrs.detail).match(/ (\d{4}) .* ch (\w\w)$/);
  return { lat: +hit.attrs.lat.toFixed(6), lon: +hit.attrs.lon.toFixed(6), postcode: m[1], canton: m[2].toUpperCase() };
}

const items = [...tdd, ...caritas, ...efa, ...frigo, ...foodsharing, ...brocki, ...ntBasel, ...ntLuzern, ...ntSolothurn, ...city];
const unmatched = [], pinConflicts = [];
await mapLimit(items, 8, async (it) => {
  const g = it._street && await geocode(it._street, it._plz, it._town);
  const pin = it._pin, d = g && pin ? km([g.lat, g.lon], pin) : 0;
  if (d > 1) pinConflicts.push(`${it.id}: ${d.toFixed(1)} km`);
  if (g) Object.assign(it, { lat: g.lat, lon: g.lon, canton: g.canton, postcode: it._plz ?? g.postcode });
  else if (pin) {
    Object.assign(it, { lat: +pin[0].toFixed(6), lon: +pin[1].toFixed(6), canton: it._canton ?? await cantonAt(pin), postcode: it._plz ?? null });
    if (it._street) it.notes = [it.notes, "Address not found in swisstopo; coordinates are the operator's map pin."].filter(Boolean).join(" ");
  } else { unmatched.push(`${it.id}: ${[it._street, it._plz, it._town].join(" ")}`); it.postcode = it._plz ?? null; }
  if (d > 1) {
    it.confidence = "low";
    it.notes = [it.notes, `Operator's map pin is ${d.toFixed(1)} km from the geocoded address; coordinates follow the address.`].filter(Boolean).join(" ");
  }
  if (g && !it._plz && it._street) it.notes = [it.notes, "Postcode added from swisstopo."].filter(Boolean).join(" ");
  if (g && it._street && !/\d/.test(it._street) && !/point on the/.test(it.notes ?? "")) it.notes = [it.notes, "No house number; coordinates are a point on the street."].filter(Boolean).join(" ");
  it.address = it._street ?? null; it.city = it._town ?? null;
});
// drop foodsharing points that duplicate a Madame Frigo fridge (within 75 m)
const frigoPts = items.filter((i) => i.network === "madame-frigo" && i.lat != null).map((i) => [i.lat, i.lon]);
const dupFs = new Set(items.filter((i) => i.network === "foodsharing" && i.lat != null && frigoPts.some((p) => km(p, [i.lat, i.lon]) < 0.075)).map((i) => i.id));
// Tischlein also serves Liechtenstein: no Swiss canton at the point = not in this file
const isOut = (i) => i.lat != null && (!i.canton || i.canton === "LI");
const outsideCh = items.filter(isOut).map((i) => `${i.id}: ${i.address}, ${i.postcode} ${i.city}`);
const out = items.filter((i) => !dupFs.has(i.id) && !isOut(i)).map((i) => Object.fromEntries(FIELDS.map((f) => [f, i[f]])));
const srcOf = Object.fromEntries(items.map((i) => [i.id, i._src]));

// ---- checks ----
const ids = new Set();
for (const it of out) {
  assert(!ids.has(it.id), `duplicate id ${it.id}`); ids.add(it.id);
  assert(it.network && it.category && it.name && it.source_url && it.source_checked === CHECKED, `incomplete ${it.id}`);
  assert(["high", "medium", "low"].includes(it.confidence), `bad confidence ${it.id}`);
  assert(!/frauenhaus|women'?s refuge|foyer pour femmes battues/i.test(it.name), `domestic-violence shelter must not be listed: ${it.id}`);
  if (it.lat != null) {
    assert(it.lat > 45.81 && it.lat < 47.81 && it.lon > 5.95 && it.lon < 10.5, `outside Switzerland bbox: ${it.id}`);
    assert(/^[A-Z]{2}$/.test(it.canton ?? ""), `no canton (outside CH?): ${it.id}`);
  }
}
assert(new Set(hotlines.map((h) => h.number)).size === hotlines.length, "duplicate hotline number");
const byNet = (n) => out.filter((i) => i.network === n).length;
assert(byNet("tischlein-deck-dich") >= 150 || !fetched.tdd); assert(byNet("madame-frigo") >= 150 || !fetched.frigo);
assert(unmatched.length <= out.length * 0.05, `too many items without coordinates: ${unmatched.length}`);

const count = (key) => out.filter((i) => srcOf[i.id] === key).length;
const sources = Object.entries(S).map(([key, s]) => ({ key, name: s.name, url: s.url, licence: LICENCE_NOTE, method: s.live ? "live" : "manual",
  count: count(key) + hotlines.filter((h) => h.source_url === s.url).length, fetched_ok: s.live ? fetched[key] ?? false : true }));
const tally = (f) => Object.fromEntries(Object.entries(out.reduce((a, i) => ((a[i[f] ?? "?"] = (a[i[f] ?? "?"] ?? 0) + 1), a), {})).sort());
const counts = { network: tally("network"), category: tally("category"), canton: tally("canton"), confidence: tally("confidence") };

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  note: "Nationwide networks plus shelters/soup kitchens in the largest cities (Bern: data/help.json). See docs/data-ch-help.md. Unknown = null.",
  counts, geocode_unmatched: unmatched, pin_conflicts: pinConflicts, outside_switzerland_dropped: outsideCh, foodsharing_dropped_as_frigo_duplicates: [...dupFs].sort(),
  sources, hotlines, items: out,
}, null, 1) + "\n");
console.log(`wrote ${OUT}: ${out.length} items, ${hotlines.length} hotlines`, counts, `unmatched ${unmatched.length}, pin conflicts ${pinConflicts.length}, fs dups ${dupFs.size}`);
