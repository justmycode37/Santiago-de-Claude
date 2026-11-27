// ---- The search's places on the map, the results list below the search bar, and the place sheet ----
// Places as pins on the map: tap one for its card (place-sheet.ts). The results list (render()) is what the search
// bar shows while you type; nothing typed, it shows renderEmptyQuery().
import * as maplibregl from 'maplibre-gl';
import { map } from './map.ts';
import { showToast } from '../toast.ts';
import { COLLAPSED_COUNT, KIND, inputs, isPlaceResult, list } from './search.ts';
import { combineResults, searchKante, searchPlaces, searchPlacesOnline } from './search-places.ts';
import { blurSearch, choose, select } from './trip-ends.ts';
import { categoryForText, categoryRow, exitCategory, loadCategory, renderCategories } from './categories.ts';
import { loadPlaces } from './map-places.ts';
import { renderHistory, renderTypedHistory } from './search-history-ui.ts';
import { journey, placeView, searchState } from './state.ts';
import { PlaceSearch, splitOpenNow } from '../places.ts';
import { lineRows } from './line-search.ts';
import { load, reloadNote } from '../lazy.ts';
import type { PlaceBbox, PlacePrediction } from '../places.ts';
import type { FieldSearch, SearchResult, TripField } from './search.ts';
const placeMarkers: maplibregl.Marker[] = [];
export const areaChip = document.getElementById('areaChip')!;
export let pins: FieldSearch | null = null; // { text, field }: the search whose places are on the map

/** The place sheet (list and card), loaded the first time it is needed; null (and a toast) when it could not be. */
export async function loadPlaceSheet() {
  try {
    return await load(import.meta.url, () => import('./place-sheet.ts'));
  } catch (e) {
    showToast(reloadNote(e, 'to see these places') || 'The places could not be shown. Check the connection and try again.');
    return null;
  }
}

let clearing = false;
/** The search's places leave the map, and their sheet closes (it calls back here when closed by hand). */
export function clearPlacePins() {
  if (clearing) return;
  clearing = true;
  exitCategory();
  removePins();
  pins = null;
  areaChip.hidden = true;
  if (placeView.close) placeView.close();
  clearing = false;
}
function removePins() {
  for (const m of placeMarkers) m.remove();
  placeMarkers.length = 0;
}
/** Places as pins (replacing those there); onPick: a pin tapped. Returns their elements, in the order given. */
export function drawPlacePins(places: SearchResult[], text: string, field: TripField, onPick: (r: SearchResult) => void): HTMLElement[] {
  removePins();
  const els = places.map((r) => {
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
    el.addEventListener('click', (e) => { e.stopPropagation(); onPick(r); });
    placeMarkers.push(new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, -14] }).setLngLat(r.lngLat).addTo(map));
    return el;
  });
  pins = { text, field };
  return els;
}

// "See results": the places for what was typed as a list (the sheet) and pins. With Google, its Text Search (one
// request, Pro fields) gives the list; otherwise the places the search bar found, with OpenStreetMap's details.
export async function showPlacesOnMap() {
  const field = searchState.field;
  const text = inputs[field].value.trim();
  const typed = searchState.results.filter(isPlaceResult);
  clearTimeout(searchState.debounce); // a search still waiting for a pause in typing: not any more
  const id = ++searchState.reqId; // a newer search or pick (or a trip chosen) drops this one
  list.classList.remove('open');
  blurSearch();
  PlaceSearch.endSession(); // a list, not a pick: the typing session ends here
  if (field === 'from') { // a start: the pins only, a tap picks it
    if (!typed.length) return;
    drawPlacePins(typed, text, field, (r) => choose(r, 'from'));
    return;
  }
  const mod = await loadPlaceSheet();
  if (!mod || id !== searchState.reqId) return;
  const online = PlaceSearch.source === 'google' ? await searchPlacesOnline(text).catch(() => null) : null;
  if (id !== searchState.reqId) return;
  const google = online && online.results.some((r) => r.source === 'google');
  const places = google ? withOwnDetails(online!.results, typed) : typed;
  const title = searchState.placeCategory || (online && online.category) || `“${text}”`;
  enrichList(places, mod, mod.showResults({ title, text, field: text, places, openNow: !!(online && online.openNow) || splitOpenNow(text)[1] }));
}
// Google's list (Pro fields: no hours, no photos) takes what the free sources know of the same places
function withOwnDetails(google: SearchResult[], own: SearchResult[]): SearchResult[] {
  const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const near = (a: LngLat, b: LngLat) => Math.hypot((a[0] - b[0]) * 76000, (a[1] - b[1]) * 111000) < 150;
  return google.map((g) => {
    const o = own.find((r) => fold(r.title) === fold(g.title) && near(r.lngLat, g.lngLat));
    return o ? { ...g, photo: g.photo || o.photo, photoIsLogo: g.photo ? false : o.photoIsLogo, info: o.info,
      openNow: g.openNow ?? o.openNow, openText: g.openText || o.openText } : g;
  });
}
// OpenStreetMap's places: their photos, hours and websites join the rows when they arrive (one request per type)
async function enrichList(places: SearchResult[], mod: NonNullable<Awaited<ReturnType<typeof loadPlaceSheet>>>, list: object) {
  const osm = places.filter((r) => r.id && /^osm:[NWR]\d+$/.test(r.id));
  if (!osm.length) return;
  const asResults = osm.map((r) => ({ ...r, id: r.id!, category: r.category || '', address: r.address || '', source: 'osm' as const, origin: 'place' as const,
    kind: r.kind === 'place' || r.kind === 'address' || r.kind === 'city' || r.kind === 'postcode' || r.kind === 'water' ? 'other' as const : r.kind, distance: r.distance ?? null }));
  const done = await PlaceSearch.enrich(asResults).catch(() => null);
  if (!done) return;
  done.forEach((e, i) => Object.assign(osm[i], { photo: osm[i].photo || e.photo || undefined, openNow: e.openNow ?? osm[i].openNow, openText: e.openText || osm[i].openText,
    info: { ...(osm[i].info || {}), openingHours: e.hours || undefined, website: e.website || undefined, phone: e.phone || undefined } }));
  mod.updateResults(list, places); // only if that list is still the one shown
}

// "Search this area": the same search again, for the part of the map now in view. The camera stays put.
async function searchArea() {
  if (searchState.category && !searchState.category.events) { areaChip.hidden = true; loadCategory(searchState.category, true); return; }
  if (!pins) return;
  const { text, field } = pins, id = ++searchState.reqId, view = map.getBounds();
  areaChip.hidden = true;
  const bbox: PlaceBbox = [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()];
  // the engine measures from the middle of the map once it shows somewhere else than you (searchOrigin)
  const [online, , kante] = await Promise.all([searchPlacesOnline(text, bbox).catch(() => null), loadPlaces(),
    searchKante(text).catch(() => null)]);
  if (id !== searchState.reqId || !pins || pins.text !== text) return;
  const found = combineResults(text, null, online, searchPlaces(text, true), kante)
    .filter((r) => isPlaceResult(r) && view.contains(r.lngLat));
  if (!found.length) { showToast(`Nothing found for “${text}” in this part of the map.`); return; }
  searchState.results = found;
  searchState.last = { field, text };
  if (field === 'from') { drawPlacePins(found, text, field, (r) => choose(r, 'from')); return; }
  const mod = await loadPlaceSheet();
  if (!mod || id !== searchState.reqId) return;
  enrichList(found, mod, mod.showResults({ title: searchState.placeCategory || `“${text}”`, text, places: found, openNow: !!(online && online.openNow) }, false));
}

// A tap on a result row. On phones the click only comes after the browser has moved focus away from the
// search box, and that blur hides the list, so the click never reaches the row. Touches are therefore handled
// on touchend, before any of that happens, and the click that would follow is cancelled. Mouse, keyboard and
// screen readers still use the click.
export function onTap(el: HTMLElement, fn: () => void) {
  let start: { x: number; y: number } | null = null;
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

// A place picked in the list: its card (Directions and Start are on it); a stop, an address or a town, and any pick
// for the start, is planned at once, as before
function pick(r: SearchResult, i: number) {
  clearTimeout(searchState.debounce);
  if (searchState.field === 'to' && isPlaceResult(r)) {
    const id = ++searchState.reqId;
    list.classList.remove('open');
    blurSearch();
    loadPlaceSheet().then((mod) => { if (mod && id === searchState.reqId) mod.showPlace(r); });
  } else select(i);
}
// One of Google's predictions: its card (destination), or its point as the start
function pickPrediction(p: PlacePrediction) {
  clearTimeout(searchState.debounce);
  const id = ++searchState.reqId;
  list.classList.remove('open');
  blurSearch();
  if (searchState.field === 'from') {
    PlaceSearch.resolve(p.placeId).then((ll) => {
      if (id !== searchState.reqId) return;
      if (ll) choose({ title: p.title, subtitle: p.subtitle, kind: p.kind, origin: 'place', lngLat: ll, googleId: p.placeId }, 'from');
      else showToast('This place could not be found.');
    });
    return;
  }
  loadPlaceSheet().then((mod) => { if (mod && id === searchState.reqId) mod.showPrediction(p); });
}

function row(icon: { color: string; fg?: string; svg: string }, title: string, subtitle: string, cls?: string) {
  const li = document.createElement('li');
  li.setAttribute('role', 'option');
  if (cls) li.className = cls;
  const i = document.createElement('div');
  i.className = 'icon';
  i.style.background = icon.color;
  if (icon.fg) i.style.color = icon.fg;
  i.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon.svg}</svg>`;
  const text = document.createElement('div');
  text.className = 'text';
  const t = document.createElement('div');
  t.className = 'title';
  t.textContent = title;
  const s = document.createElement('div');
  s.className = 'subtitle';
  s.textContent = subtitle;
  text.append(t, s);
  li.append(i, text);
  return li;
}

/**
 * Nothing typed in a field: what the list offers. Sections are added here in this order; each is skipped when it
 * has nothing to show: your recent and frequent searches first, then the categories.
 */
export function renderEmptyQuery() {
  const focused = document.activeElement === inputs[searchState.field];
  // your recent and frequent searches (search-history-ui.ts)
  if (focused) renderHistory(searchState.field);
  // where to (not where from, and not while a trip is on show): the categories
  if (searchState.field === 'to' && !journey.dest && focused) renderCategories();
  if (!list.children.length) list.classList.remove('open');
}

export function render(emptyText = 'No results') {
  list.innerHTML = '';
  if (!inputs[searchState.field].value.trim()) { renderEmptyQuery(); return; }
  const typedCategory = categoryForText(inputs[searchState.field].value);
  if (typedCategory && searchState.field === 'to') list.appendChild(categoryRow(typedCategory));
  const history = renderTypedHistory(); // searches of yours the text matches (search-history-ui.ts)
  const lines = lineRows(); // "Tram 9": the lines of that name nearby (line-search.ts)
  list.append(...lines);
  const predictions = searchState.predictions;
  // (one letter is not searched for: no "No results" under your own searches)
  if (!searchState.results.length && !predictions.length && !lines.length && !(history && inputs[searchState.field].value.trim().length < 2)) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    list.appendChild(li);
  }
  const placeCount = searchState.results.filter(isPlaceResult).length;
  let onMapLast: HTMLElement | null = null;
  const google = PlaceSearch.source === 'google';
  const enough = searchState.field === 'from' ? placeCount >= 2 : placeCount >= 2 || (google && placeCount + predictions.length >= 2);
  if (enough && (isPlaceResult(searchState.results[0] || {} as SearchResult) || !searchState.results.length)
    && !(typedCategory && searchState.field === 'to')) {
    const onMap = document.createElement('li');
    onMap.className = 'on-map';
    onMap.setAttribute('role', 'option');
    onMap.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5zM9 4v13.5M15 6.5V20"/></svg>';
    const text = inputs[searchState.field].value.trim();
    onMap.append(searchState.field === 'from' ? `Show ${placeCount} places on the map`
      : google ? `See results for “${text}”`
      : searchState.placeCategory ? `See ${placeCount} ${searchState.placeCategory.toLowerCase()} on the map` : `See ${placeCount} places on the map`);
    onTap(onMap, showPlacesOnMap);
    // a kind of place ("restaurant"): all of them on the map comes first; a name ("Migros"): its matches come first
    if (searchState.placeCategory) list.appendChild(onMap);
    else onMapLast = onMap;
  }
  const visible = searchState.expanded ? searchState.results : searchState.results.slice(0, searchState.placeCategory ? 5 : COLLAPSED_COUNT);
  visible.forEach((r, i) => {
    const li = row(r.icon || KIND[r.kind] || KIND.other, r.title, r.subtitle);
    if (r.photo) { // a photo of the place, or its brand's logo
      const img = document.createElement('img');
      img.className = r.photoIsLogo ? 'thumb logo' : 'thumb';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.remove());
      img.src = r.photo;
      li.append(img);
    }
    onTap(li, () => pick(r, i));
    list.appendChild(li);
  });
  // Google's predictions that are none of the rows above: name, distance and where; no point until picked
  for (const p of searchState.expanded ? predictions : predictions.slice(0, 3)) {
    const li = row(KIND[p.kind] || KIND.other, p.title, [p.distance != null ? PlaceSearch.formatDistance(p.distance) : '', p.subtitle].filter(Boolean).join(' · '), 'prediction');
    onTap(li, () => pickPrediction(p));
    list.appendChild(li);
  }
  if (onMapLast) list.appendChild(onMapLast);
  if (!searchState.expanded && (searchState.results.length > visible.length || predictions.length > 3)) {
    const more = document.createElement('li');
    more.className = 'more';
    more.textContent = 'Show more…';
    onTap(more, () => { searchState.expanded = true; render(); });
    list.appendChild(more);
  }
  const fromOsm = visible.some((r) => r.source === 'osm'), fromGoogle = predictions.length > 0 || visible.some((r) => r.source === 'google');
  if (fromOsm || fromGoogle) { // places from places.ts: credit their source
    const attr = document.createElement('li');
    attr.className = 'attr';
    attr.textContent = [fromGoogle ? 'Google Maps' : '', fromOsm ? 'Places © OpenStreetMap contributors' : ''].filter(Boolean).join(' · ');
    list.appendChild(attr);
  }
  list.classList.add('open');
  if (!searchState.expanded) list.scrollTop = 0;
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  areaChip.addEventListener('click', searchArea);
}
