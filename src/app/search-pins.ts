// ---- The places of a search as pins on the map ("Show on map"): tap one to make it that end of the trip ----
import * as maplibregl from 'maplibre-gl';
import { map } from './map.ts';
import { showToast } from '../toast.ts';
import { COLLAPSED_COUNT, KIND, inputs, isPlaceResult, list } from './search.ts';
import { combineResults, searchKante, searchPlaces, searchPlacesOnline } from './search-places.ts';
import { blurSearch, choose, select } from './trip-ends.ts';
import { categoryForText, categoryRow, exitCategory, loadCategory, renderCategories } from './categories.ts';
import { loadPlaces } from './map-places.ts';
import { mapPadding } from './pill.ts';
import { renderHistory, renderTypedHistory } from './search-history-ui.ts';
import { journey, searchState } from './state.ts';
import { PlaceSearch } from '../places.ts';
import { lineRows } from './line-search.ts';
import type { PlaceBbox } from '../places.ts';
import type { FieldSearch, SearchResult, TripField } from './search.ts';
const placeMarkers: maplibregl.Marker[] = [];
export const areaChip = document.getElementById('areaChip')!;
export let pins: FieldSearch | null = null; // { text, field }: the search whose places are on the map
export function clearPlacePins() {
  exitCategory();
  for (const m of placeMarkers) m.remove();
  placeMarkers.length = 0;
  pins = null;
  areaChip.hidden = true;
}
function drawPlacePins(places: SearchResult[], text: string, field: TripField) {
  clearPlacePins();
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
    el.addEventListener('click', (e) => { e.stopPropagation(); choose(r, field); });
    placeMarkers.push(new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, -14] }).setLngLat(r.lngLat).addTo(map));
  }
  pins = { text, field };
}
export function showPlacesOnMap() {
  const places = searchState.results.filter(isPlaceResult);
  if (!places.length) return;
  const field = searchState.field;
  drawPlacePins(places, inputs[field].value.trim(), field);
  list.classList.remove('open');
  blurSearch();
  // Stay where you are looking when some of them are there; otherwise show them all
  const view = map.getBounds();
  if (places.some((r) => view.contains(r.lngLat))) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const r of places) bounds.extend(r.lngLat);
  const pad = mapPadding();
  map.fitBounds(bounds, { padding: { ...pad, left: pad.left + 12, right: pad.right + 12, bottom: pad.bottom + 30 }, maxZoom: 16.5, duration: 900 });
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
  drawPlacePins(found, text, field);
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

export function render(emptyText = 'No results') {
  list.innerHTML = '';
  if (!inputs[searchState.field].value.trim()) {
    // nothing typed: your recent and frequent searches (search-history-ui.ts), then the categories (where to, not
    // where from, and not while a trip is on show)
    const focused = document.activeElement === inputs[searchState.field];
    const history = focused && renderHistory(searchState.field);
    if (searchState.field === 'to' && !journey.dest && focused) renderCategories();
    else if (!history) list.classList.remove('open');
    return;
  }
  const typedCategory = categoryForText(inputs[searchState.field].value);
  if (typedCategory && searchState.field === 'to') list.appendChild(categoryRow(typedCategory));
  const history = renderTypedHistory(); // searches of yours the text matches (search-history-ui.ts)
  const lines = lineRows(); // "Tram 9": the lines of that name nearby (line-search.ts)
  list.append(...lines);
  // (one letter is not searched for: no "No results" under your own searches)
  if (!searchState.results.length && !lines.length && !(history && inputs[searchState.field].value.trim().length < 2)) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    list.appendChild(li);
  }
  const placeCount = searchState.results.filter(isPlaceResult).length;
  let onMapLast: HTMLElement | null = null;
  if (placeCount >= 2 && isPlaceResult(searchState.results[0]) && !(typedCategory && searchState.field === 'to')) {
    const onMap = document.createElement('li');
    onMap.className = 'on-map';
    onMap.setAttribute('role', 'option');
    onMap.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5zM9 4v13.5M15 6.5V20"/></svg>';
    onMap.append(searchState.placeCategory ? `Show ${placeCount} ${searchState.placeCategory.toLowerCase()} on the map` : `Show ${placeCount} places on the map`);
    onTap(onMap, showPlacesOnMap);
    // a kind of place ("restaurant"): all of them on the map comes first; a name ("Migros"): its matches come first
    if (searchState.placeCategory) list.appendChild(onMap);
    else onMapLast = onMap;
  }
  const visible = searchState.expanded ? searchState.results : searchState.results.slice(0, searchState.placeCategory ? 5 : COLLAPSED_COUNT);
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
    onTap(li, () => select(i));
    list.appendChild(li);
  });
  if (onMapLast) list.appendChild(onMapLast);
  if (!searchState.expanded && searchState.results.length > visible.length) {
    const more = document.createElement('li');
    more.className = 'more';
    more.textContent = 'Show more…';
    onTap(more, () => { searchState.expanded = true; render(); });
    list.appendChild(more);
  }
  if (PlaceSearch && visible.some((r) => r.source)) { // places from places.ts: credit their source
    const attr = document.createElement('li');
    attr.className = 'attr';
    attr.textContent = PlaceSearch.attribution;
    list.appendChild(attr);
  }
  list.classList.add('open');
  if (!searchState.expanded) list.scrollTop = 0;
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  areaChip.addEventListener('click', searchArea);
}
