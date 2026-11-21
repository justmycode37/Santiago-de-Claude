// ---- Places in the search (map-places.js: Bern, toilets everywhere): a kind of place ("pharmacy", "wc", "apotheke", "closest toilet")
//      lists the nearest ones; a name ("Migros", "Amavita") lists the places called that, nearest first ----
const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y'
  : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const wordsOf = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
// "closest pharmacy", "nächste Apotheke", "toilet near me" → pharmacy, apotheke, toilet
const NEAR_WORDS = new Set(['closest', 'nearest', 'near', 'nearby', 'me', 'next', 'the', 'a', 'an', 'find', 'where', 'is',
  'around', 'here', 'my', 'nachste', 'nachster', 'nachstes', 'nachsten', 'in', 'der', 'die', 'das', 'nahe', 'wo', 'ist',
  'ein', 'eine', 'mir', 'bei', 'plus', 'proche', 'le', 'la']);
const NEAR_PHRASE = /^(closest|nearest|next|n[aä]chste[rsn]?)\s+|\s+(near me|nearby|in der n[aä]he)$/gi;
const SEARCH_ALIASES = Object.fromEntries(Object.entries(MAP_LAYERS.SEARCH_ALIASES).map(([k, v]) => [stem(fold(k)), v]));
const NAMED_BY_PLACE = new Set(['Info stand / kiosk', 'Mobile recycling point', 'Recycling', 'Bike pump', 'Bike parking',
  'Disabled parking', 'Taxi rank', 'Car sharing', 'EV parking', 'Tactile paving', 'Acoustic crossing signal']);
let placeIndex = null;
function placeSearchIndex() {
  if (!placeIndex && PLACES) {
    const labelWords = (s) => wordsOf(s).map(stem);
    placeIndex = {
      cat: PLACES.cats.map(([, , , label]) => labelWords(label)),
      group: PLACES.cats.map(([g]) => labelWords(GROUP_BY_KEY[g].label)),
      names: PLACES.items.map((r) => (r[3] ? fold(r[3]) : '')),
      toilets: PLACES.items.filter((r) => PLACES.cats[r[2]][0] === 'toilets'),
    };
  }
  return placeIndex;
}
function placeResult(row, km) {
  const [g, glyph, , label] = PLACES.cats[row[2]];
  const group = GROUP_BY_KEY[g];
  return {
    title: row[3] || label,
    // "Pharmacy · 120 m · Neuengasse 15": the street tells apart branches with the same name
    subtitle: [row[3] ? label : '', fmtDist(km * 1000), row[4] && row[4].a && /\d/.test(row[4].a.split(',')[0]) ? row[4].a.split(',')[0] : ''].filter(Boolean).join(' · '),
    kind: 'place',
    origin: 'place',
    distance: km * 1000,
    icon: { color: `var(--${group.color})`, fg: group.color === 'sun' ? '#344D77' : '', svg: `<path d="${MAP_LAYERS.GLYPHS[glyph]}"/>` },
    lngLat: [row[0], row[1]],
  };
}
// → { kinds: nearest places of the kind asked for, names: places whose name matches, toilets: a toilet was asked for }
function searchPlaces(text) {
  const idx = placeSearchIndex();
  const plain = wordsOf(text).filter((w) => !NEAR_WORDS.has(w));
  if (!idx || !plain.length) return { kinds: [], names: [], toilets: false };
  const from = gpsOn() ? userLngLat : map.getCenter().toArray();
  const near = (rows, n) => rows.map((r) => [r, distKm(from, r)]).sort((a, b) => a[1] - b[1]).slice(0, n);

  // a kind of place: every word of the query (after aliases) starts a word of its label or of its group's name
  // ("health" → pharmacies, doctors, hospitals…)
  const tokens = plain.map(stem).flatMap((w) => (SEARCH_ALIASES[w] ? wordsOf(SEARCH_ALIASES[w]).map(stem) : [w]));
  const fits = (label) => tokens.every((t) => label.some((w) => w === t || (t.length >= 3 && w.startsWith(t))));
  let cats = idx.cat.map((label, i) => (fits(label) || fits(idx.group[i]) ? i : -1)).filter((i) => i >= 0);
  // A word that only starts a kind ("coop" → Cooperative) but is the whole name of places (Coop) asks for
  // those places: the kind needs a word of its own then ("cooperative")
  const whole = (label) => tokens.every((t) => label.some((w) => w === t));
  if (cats.length && !cats.some((i) => whole(idx.cat[i]) || whole(idx.group[i]))
    && idx.names.some((name) => name && plain.every((w) => wordsOf(name).includes(w)))) cats = [];
  const catSet = new Set(cats);
  // "closest toilet" is asked by someone who needs one now: not the ones for customers, with a key or a permit,
  // or that may be locked. "customer toilet" still lists those for customers.
  const toilets = cats.length > 0 && cats.every((i) => PLACES.cats[i][0] === 'toilets');
  const customerAsked = cats.length > 0 && cats.every((i) => PLACES.cats[i][3] === 'Customer toilet');
  const forAll = (r) => !(r[4] && r[4].k && r[4].k !== 'permissive' && PLACES.cats[r[2]][0] === 'toilets')
    || (customerAsked && r[4].k === 'customers');
  const kinds = cats.length ? near(PLACES.items.filter((r) => catSet.has(r[2]) && forAll(r)), 6) : [];

  // a name: every word appears in it. Stops and stations come from the swisstopo search instead, and some official
  // items are only named after where they stand ("Bahnhofplatz 1"), so they don't count as names.
  const names = [];
  if (plain.join('').length >= 3) {
    const shown = new Set(kinds.map(([r]) => r));
    const rows = [];
    idx.names.forEach((name, i) => {
      const r = PLACES.items[i];
      if (!name || shown.has(r) || catSet.has(r[2]) || !plain.every((w) => name.includes(w))) return;
      const [g, , , label] = PLACES.cats[r[2]];
      if (g === 'transit' || NAMED_BY_PLACE.has(label) || (r[4] && r[4].a && fold(r[4].a).startsWith(name))) return;
      rows.push(r);
    });
    const starts = (r) => (fold(r[3]).startsWith(plain[0]) ? 0 : 1);
    names.push(...rows.map((r) => [r, distKm(from, r)]).sort((a, b) => starts(a[0]) - starts(b[0]) || a[1] - b[1]).slice(0, 5));
  }
  return { kinds: kinds.map(([r, km]) => placeResult(r, km)), names: names.map(([r, km]) => placeResult(r, km)), toilets };
}

// Addresses, towns, postcodes, mountains, lakes: swisstopo
async function searchSwisstopo(text) {
  const url = 'https://api3.geo.admin.ch/rest/services/api/SearchServer?' + new URLSearchParams({
    searchText: text,
    type: 'locations',
    origins: 'zipcode,gg25,gazetteer,address',
    sr: '4326',
    limit: '15',
    lang: 'en',
  });
  const res = await fetch(url);
  const data = await res.json();
  const seen = new Set();
  return (data.results || []).map((r) => ({
    ...parseResult(r.attrs),
    origin: r.attrs.origin,
    lngLat: [r.attrs.lon, r.attrs.lat],
  })).filter((r) => {
    const key = (r.title + '|' + r.subtitle).toLowerCase();
    if (!r.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Restaurants, shops, cafés, … anything with a name, all over Switzerland (places.js: OpenStreetMap, or Google
// with a key): around the part of the map in view, with distances from you
function searchPlacesOnline(text) {
  if (!window.PlaceSearch) return Promise.resolve(null);
  const center = map.getCenter().toArray();
  const corner = map.getBounds().getNorthEast().toArray();
  const viewKm = Math.hypot((corner[0] - center[0]) * 76, (corner[1] - center[1]) * 111); // km at Swiss latitudes
  const radiusKm = Math.min(Math.max(viewKm, 1), 10);
  const timeout = new Promise((_, fail) => setTimeout(() => fail(new Error('timeout')), 4000));
  return Promise.race([PlaceSearch.search(text, { center, origin: userLngLat, radiusKm }), timeout]);
}

const nearM = (a, b, m) => Math.hypot((a[0] - b[0]) * 76000, (a[1] - b[1]) * 111000) < m;

// One list from the three sources: our own places (map-places.js), places online (places.js), swisstopo
function combineResults(text, swiss, online, local) {
  const { kinds, names } = local;
  const bern = [...kinds, ...names];
  // a place in both the Bern data and online keeps the Bern entry
  // Toilets: ours cover Switzerland and know which are for customers only or locked, so an online toilet that
  // is one of ours (within 50 m) is left out, whatever it is called there. The others (Liechtenstein, a new one)
  // stay, and are listed with ours by distance.
  const ownToilet = (p) => local.toilets && placeSearchIndex().toilets.some((r) => nearM(r, p.lngLat, 50));
  const found = (online ? online.results : [])
    .filter((p) => !ownToilet(p) && !bern.some((b) => fold(b.title) === fold(p.title) && nearM(b.lngLat, p.lngLat, 150)));
  const byDistance = local.toilets && !!online && online.category === 'Toilets' && found.every((p) => p.distance != null);
  // A name ("Coop", "Migros"): ours and those found online are the same kind of match, so all of them nearest first
  // (online ones have a distance only when we know where you are)
  const namesByDistance = !kinds.length && names.length > 0 && gpsOn() && found.every((p) => p.distance != null);
  const places = byDistance ? [...[...kinds, ...found].sort((a, b) => a.distance - b.distance), ...names]
    : namesByDistance ? [...found, ...names].sort((a, b) => a.distance - b.distance)
    : [...kinds, ...found, ...names];
  // a place swisstopo also knows keeps the place (it has the category and the distance)
  const s = (swiss || []).filter((r) => !places.some((p) => fold(p.title) === fold(r.title) && nearM(p.lngLat, r.lngLat, 150)));
  placeCategory = (online && online.category) || null;
  // Places first for "restaurant", "Migros", "Einstein Kaffee"; swisstopo first for "Bern", "3011", "Kramgasse 1":
  // whichever top result has more of the typed words in its name, swisstopo on a tie if its name is the query
  const qw = wordsOf(text);
  const matched = (r) => {
    if (!r) return 0;
    const tw = wordsOf(r.title);
    return qw.filter((w) => tw.some((t) => t.startsWith(w) || (t.length >= 3 && w.startsWith(t)))).length / (qw.length || 1);
  };
  const pm = matched(places[0]), sm = matched(s[0]);
  const placesFirst = kinds.length > 0 || !!placeCategory || (!/\d/.test(text) && places.length > 0
    && (pm > sm || (pm === sm && pm > 0 && fold(s[0] ? s[0].title : '') !== fold(text))));
  return placesFirst ? [...places, ...s] : [...s, ...places];
}

async function search(text) {
  const id = ++reqId;
  const remoteText = text.replace(NEAR_PHRASE, '').trim() || text;
  let online = null;
  let onlineDone = false;
  const onlineReq = searchPlacesOnline(text).catch(() => null).then((v) => { online = v; onlineDone = true; });
  const [swiss] = await Promise.all([
    searchSwisstopo(remoteText).catch(() => null),
    loadPlaces(), // usually loaded already (downloaded after the first map view)
  ]);
  if (id !== reqId) return; // a newer query is in flight
  const local = searchPlaces(text);
  const show = (final) => {
    results = combineResults(text, swiss, online, local);
    render(!final ? 'Searching…' : swiss || online ? 'No results' : 'Search unavailable');
  };
  // Addresses and Bern places at once; places from the web join the list when they arrive, so a slow
  // answer from one source never holds up the others
  if (!onlineDone) await Promise.race([onlineReq, new Promise((ok) => setTimeout(ok, 250))]);
  if (id !== reqId) return;
  expanded = false;
  show(onlineDone);
  if (onlineDone) return;
  await onlineReq;
  if (id === reqId) show(true);
}

// "Show on map": every place result as a pin; tap one to plan the trip there
const placeMarkers = [];
function clearPlacePins() {
  for (const m of placeMarkers) m.remove();
  placeMarkers.length = 0;
}
function showPlacesOnMap() {
  clearPlacePins();
  const places = results.filter((r) => r.origin === 'place');
  if (!places.length) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const r of places) {
    const k = r.icon || KIND[r.kind] || KIND.other;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'place-pin';
    el.setAttribute('aria-label', `${r.title}, ${r.subtitle}`);
    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.style.background = k.color;
    if (k.fg) icon.style.color = k.fg;
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${k.svg}</svg>`;
    const name = document.createElement('span');
    name.textContent = r.title;
    el.append(icon, name);
    el.addEventListener('click', (e) => { e.stopPropagation(); showDestinationJourney(r); });
    placeMarkers.push(new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, -14] }).setLngLat(r.lngLat).addTo(map));
    bounds.extend(r.lngLat);
  }
  list.classList.remove('open');
  input.blur();
  const bottom = window.innerHeight * 0.2 + 90; // clear of the search bar
  map.fitBounds(bounds, { padding: { top: 90, left: 50, right: 50, bottom }, maxZoom: 16.5, duration: 900 });
}

// A tap on a result row. On phones the click only comes after the browser has moved focus away from the
// search box, and that blur hides the list (and on iOS the closing keyboard slides the bar down), so the
// click never reaches the row. Touches are therefore handled on touchend, before any of that happens, and
// the click that would follow is cancelled. Mouse, keyboard and screen readers still use the click.
function onTap(el, fn) {
  let start = null;
  el.addEventListener('pointerdown', (e) => e.preventDefault()); // mouse: keep focus in the search box
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    start = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) start = null; // scrolling the list
  }, { passive: true });
  el.addEventListener('touchcancel', () => { start = null; });
  el.addEventListener('touchend', (e) => {
    if (!start || !e.cancelable) return; // not cancelable: leave it to the click
    start = null;
    e.preventDefault(); // no focus change, no late click on whatever opens underneath
    fn();
  });
  el.addEventListener('click', fn);
}

function render(emptyText = 'No results') {
  list.innerHTML = '';
  if (!input.value.trim()) { list.classList.remove('open'); return; }
  if (!results.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    list.appendChild(li);
  }
  const placeCount = results.filter((r) => r.origin === 'place').length;
  if (placeCount >= 2 && results[0].origin === 'place') {
    const onMap = document.createElement('li');
    onMap.className = 'on-map';
    onMap.setAttribute('role', 'option');
    onMap.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5zM9 4v13.5M15 6.5V20"/></svg>';
    onMap.append(placeCategory ? `Show ${placeCount} ${placeCategory.toLowerCase()} on the map` : `Show ${placeCount} places on the map`);
    onTap(onMap, showPlacesOnMap);
    list.appendChild(onMap);
  }
  const visible = expanded ? results : results.slice(0, placeCategory ? 5 : COLLAPSED_COUNT);
  visible.forEach((r, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    const icon = document.createElement('div');
    const k = r.icon || KIND[r.kind] || KIND.other;
    icon.className = 'icon';
    icon.style.background = k.color;
    if (k.fg) icon.style.color = k.fg;
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${k.svg}</svg>`;
    const text = document.createElement('div');
    text.className = 'text';
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = r.title;
    const s = document.createElement('div');
    s.className = 'subtitle';
    s.textContent = r.subtitle;
    text.append(t, s);
    li.append(icon, text);
    onTap(li, () => select(i));
    list.appendChild(li);
  });
  if (!expanded && results.length > visible.length) {
    const more = document.createElement('li');
    more.className = 'more';
    more.textContent = 'Show more…';
    onTap(more, () => { expanded = true; render(); });
    list.appendChild(more);
  }
  if (window.PlaceSearch && results.some((r) => r.source)) { // places from places.js: credit their source
    const attr = document.createElement('li');
    attr.className = 'attr';
    attr.textContent = PlaceSearch.attribution;
    list.appendChild(attr);
  }
  list.classList.add('open');
  if (!expanded) list.scrollTop = 0;
}

function select(i) {
  const r = results[i];
  if (r) showDestinationJourney(r);
}

function showDestinationJourney(r) {
  input.value = r.title;
  clearBtn.classList.add('show');
  list.classList.remove('open');
  input.blur();
  clearPlacePins();
  destMarker.setLngLat(r.lngLat).addTo(map);
  startJourney(r);
}

input.addEventListener('input', () => {
  const text = input.value.trim();
  clearBtn.classList.toggle('show', !!input.value);
  clearTimeout(debounce);
  clearPlacePins();
  if (text.length < 2) { reqId++; results = []; placeCategory = null; render(); return; }
  // Google Places is paid per request: wait a little longer for a pause in typing
  debounce = setTimeout(() => search(text), window.PlaceSearch && PlaceSearch.source === 'google' ? 350 : 200);
});

input.addEventListener('focus', () => {
  setMenu(false);
  loadPlaces(); // so places (toilets, pharmacies…) are ready to be searched
  if (input.value.trim()) render();
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  // "restaurants" + Enter shows them all on the map; a name or address goes straight there
  if (placeCategory && results.filter((r) => r.origin === 'place').length >= 2) showPlacesOnMap();
  else if (results.length) select(0);
});

clearBtn.addEventListener('pointerdown', (e) => e.preventDefault());
clearBtn.addEventListener('click', () => {
  input.value = '';
  results = [];
  placeCategory = null;
  reqId++;
  clearBtn.classList.remove('show');
  render();
  clearPlacePins();
  destMarker.remove();
  if (userLngLat) map.flyTo({ center: userLngLat, zoom: 15 });
  input.focus();
});

// Collapse the bar into a circle when the user moves the map; tap the circle to expand it again
map.on('movestart', (e) => {
  if (!e.originalEvent) return; // ignore programmatic moves (flyTo after a search)
  if (wrap.classList.contains('journey-open')) { setMenu(false); return; } // keep the journey widget open
  input.blur();
  setMenu(false);
  wrap.classList.add('collapsed');
});
form.addEventListener('click', () => {
  if (!wrap.classList.contains('collapsed')) return;
  wrap.classList.remove('collapsed');
  input.focus();
});

// Tapping the map closes the keyboard, results and menu
map.on('mousedown', () => { input.blur(); setMenu(false); });
map.on('touchstart', () => { input.blur(); setMenu(false); });
input.addEventListener('blur', () => list.classList.remove('open'));
