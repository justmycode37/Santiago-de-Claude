// ---- Categories: what the empty search bar offers ("Restaurants", "Hotels", "Supermarkets", …) ----
// A tap on one (or typing one and pressing Enter) lists the best places of that kind in the part of the map in view
// (the place sheet: photo, name, rating, open state, distance) with their pins; the one picked is shown as a card.
// "Best": Google's rating weighed by how many people rated it, with a Google key (config.js); otherwise how well
// known the place is on OpenStreetMap and Wikidata (PlaceSearch.enrich). Being near counts a little.
// With "New to Switzerland" on in Settings, categories for newcomers come first: language courses (the community
// events) and town halls & migration offices. Those events are not on the map otherwise (map-events.ts).
import { map } from './map.ts';
import { eventMarkers, updateCards } from './map-events.ts';
import { showToast, toast } from '../toast.ts';
import { KIND, inputs, list } from './search.ts';
import { NEAR_PHRASE, fold, searchOrigin, searchPlaces, searchPlacesOnline } from './search-places.ts';
import { areaChip, clearPlacePins, loadPlaceSheet, onTap } from './search-pins.ts';
import { closeSearch, setField } from './trip-ends.ts';
import { loadPlaces } from './map-places.ts';
import { distKm, endJourney } from './routing.ts';
import { rememberCategory } from './search-history-ui.ts';
import { journey, searchState } from './state.ts';
import { PlaceSearch } from '../places.ts';
import { SETTINGS } from '../settings.ts';
import { EVENTS } from '../events.ts';
import type { EventFeature, EventProperties } from '../events.ts';
import type { PlaceBbox } from '../places.ts';
import type { SearchIcon, SearchResult } from './search.ts';

export interface SearchCategory {
  key: string;
  label: string;
  icon: SearchIcon;
  /** Places: what the place search is asked for (a word PlaceSearch knows as a category). */
  query?: string;
  /** Events: which community events it shows. */
  events?: (event: EventProperties) => boolean;
  /** Typed words that pick it (places also match through PlaceSearch.matchCategory). */
  words?: string[];
  newcomer?: boolean;
}

const eventIcon = (glyph: keyof typeof EVENTS.GLYPHS, color: string, fg?: string): SearchIcon =>
  ({ color, fg, svg: `<path d="${EVENTS.GLYPHS[glyph]}"/>` });
const CATEGORY_LIST: SearchCategory[] = [
  { key: 'language', label: 'Language courses', icon: eventIcon('language', 'var(--navy)'), newcomer: true,
    events: (e) => e.tags.includes('language'),
    words: ['language course', 'language courses', 'language cafe', 'german course', 'german courses', 'learn german', 'learn french',
      'deutschkurs', 'deutschkurse', 'sprachkurs', 'sprachkurse', 'cours de francais', 'corso di italiano', 'integration course'] },
  { key: 'offices', label: 'Town halls & migration', icon: KIND.building!, newcomer: true, query: 'immigration office' },
  { key: 'restaurants', label: 'Restaurants', icon: KIND.food!, query: 'restaurant' },
  { key: 'cafes', label: 'Cafés', icon: KIND.cafe!, query: 'cafe' },
  { key: 'supermarkets', label: 'Supermarkets', icon: KIND.shop!, query: 'supermarket' },
  { key: 'hotels', label: 'Hotels', icon: KIND.bed!, query: 'hotel' },
  { key: 'bars', label: 'Bars', icon: KIND.bar!, query: 'bar' },
  { key: 'bakeries', label: 'Bakeries', icon: KIND.cafe!, query: 'bakery' },
  { key: 'pharmacies', label: 'Pharmacies', icon: KIND.health!, query: 'pharmacy' },
  { key: 'museums', label: 'Museums', icon: KIND.building!, query: 'museum' },
  { key: 'parks', label: 'Parks', icon: KIND.nature!, query: 'park' },
  { key: 'atms', label: 'Cash machines', icon: KIND.money!, query: 'atm' },
  { key: 'gyms', label: 'Gyms', icon: KIND.sport!, query: 'gym' },
];
const categoryByKey = (k: string) => CATEGORY_LIST.find((c) => c.key === k)!;
// For you: newcomer categories when that is switched on, then what people look for at this time of day
function categoriesForYou(): SearchCategory[] {
  const h = new Date().getHours();
  const order = h >= 5 && h < 10 ? ['cafes', 'bakeries', 'supermarkets', 'restaurants', 'pharmacies', 'parks', 'hotels', 'museums']
    : h < 15 ? ['restaurants', 'cafes', 'supermarkets', 'museums', 'parks', 'pharmacies', 'hotels', 'bars']
    : h < 21 ? ['restaurants', 'supermarkets', 'bars', 'cafes', 'hotels', 'pharmacies', 'gyms', 'museums']
    : ['bars', 'restaurants', 'hotels', 'atms', 'pharmacies', 'supermarkets', 'cafes', 'parks'];
  const newcomer = SETTINGS.prefs().newcomer ? CATEGORY_LIST.filter((c) => c.newcomer) : [];
  return [...newcomer, ...order.map(categoryByKey)];
}
// What was typed, as a category: ours by name or word, else any kind of place the place search knows ("dentist")
export function categoryForText(text: string): SearchCategory | null {
  const q = fold(text).replace(NEAR_PHRASE, '').trim();
  if (q.length < 3) return null;
  for (const c of CATEGORY_LIST) {
    if (fold(c.label) === q || (c.words || []).some((w) => fold(w) === q || (q.length >= 5 && fold(w).startsWith(q)))) return c;
  }
  const label = PlaceSearch ? PlaceSearch.matchCategory(text) : null;
  if (!label) return null;
  const ours = CATEGORY_LIST.find((c) => c.query && PlaceSearch.matchCategory(c.query) === label);
  return ours || { key: 'q:' + fold(label), label, icon: KIND.other, query: text.replace(NEAR_PHRASE, '').trim() || text };
}
// A category from the search history (search-history.ts): ours by key, else what its words name now, else as it was
export function categoryFromHistory(key: string, label: string, query?: string): SearchCategory | null {
  const ours = CATEGORY_LIST.find((c) => c.key === key);
  if (ours) return ours;
  if (!query) return null;
  return categoryForText(query) || { key, label, icon: KIND.other, query };
}

// ---- The chips in the empty search list ----
function chipFor(c: SearchCategory) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cat-chip';
  const icon = document.createElement('span');
  icon.className = 'cat-icon';
  icon.style.background = c.icon.color;
  if (c.icon.fg) icon.style.color = c.icon.fg;
  icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${c.icon.svg}</svg>`;
  b.append(icon, c.label);
  onTap(b, () => enterCategory(c));
  return b;
}
export function renderCategories() {
  const all = categoriesForYou();
  const groups: [string, SearchCategory[]][] = [
    ['New to Switzerland', all.filter((c) => c.newcomer)],
    ['Nearby', all.filter((c) => !c.newcomer)],
  ];
  for (const [title, cats] of groups) {
    if (!cats.length) continue;
    const li = document.createElement('li');
    li.className = 'cats';
    const h = document.createElement('div');
    h.className = 'cats-title';
    h.textContent = title;
    const row = document.createElement('div');
    row.className = 'cats-row';
    row.append(...cats.map(chipFor));
    li.append(h, row);
    list.appendChild(li);
  }
  list.classList.add('open');
  list.scrollTop = 0;
}
// While typing: the category the text names, as the first row ("Restaurants · the best nearby")
export function categoryRow(c: SearchCategory) {
  const li = document.createElement('li');
  li.setAttribute('role', 'option');
  li.className = 'cat-row';
  const icon = document.createElement('div');
  icon.className = 'icon';
  icon.style.background = c.icon.color;
  if (c.icon.fg) icon.style.color = c.icon.fg;
  icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${c.icon.svg}</svg>`;
  const text = document.createElement('div');
  text.className = 'text';
  const t = document.createElement('div');
  t.className = 'title';
  t.textContent = c.label;
  const s = document.createElement('div');
  s.className = 'subtitle';
  s.textContent = c.events ? 'Show them on the map' : 'The best ones in this area';
  text.append(t, s);
  li.append(icon, text);
  onTap(li, () => enterCategory(c));
  return li;
}

// ---- A category: its events as cards on the map, its places as a list (the place sheet) with their pins ----
// 'Restaurant, italian' → 'Italian': the kind of food says more than the kind of place
const cuisineOr = (category: string) => { const [kind, extra] = category.split(', '); return extra ? extra[0].toUpperCase() + extra.slice(1) : kind; };
let categoryReq = 0;
export const CATEGORY_CARDS = 6; // at most this many event cards at once: the map stays readable

export function enterCategory(c: SearchCategory) {
  rememberCategory(c);
  clearTimeout(searchState.debounce);
  if (!c.events && journey.dest) endJourney(true); // its places' list takes the trip's place (the sheet)
  clearPlacePins(); // also leaves the category before (exitCategory)
  searchState.category = c;
  searchState.results = [];
  searchState.last = null;
  searchState.reqId++;
  setField('to', c.label);
  closeSearch();
  PlaceSearch.endSession(); // a list, not a pick
  if (c.events) {
    updateCards();
    if (!eventMarkers.size) showNearestEvents(c);
    return;
  }
  loadCategory(c, false);
}
export function exitCategory() {
  if (!searchState.category) return;
  const label = searchState.category.label;
  searchState.category = null;
  categoryReq++;
  areaChip.hidden = true;
  if (inputs.to.value === label) setField('to', '');
  updateCards();
}
// No such event in view: go to the nearest ones
function showNearestEvents(c: SearchCategory) {
  const from = searchOrigin();
  const near = EVENTS.features.filter((f) => EVENTS.matches(f, []) && c.events!(f.properties))
    .map((f): [EventFeature, number] => [f, distKm(from, f.geometry.coordinates)]).sort((a, b) => a[1] - b[1]);
  if (!near.length) { showToast(`No ${c.label.toLowerCase()} found.`); return; }
  map.flyTo({ center: near[0][0].geometry.coordinates, zoom: Math.max(map.getZoom(), 14), speed: 1.4 });
}

/** How good a place is, for ranking a category: Google's stars weighed by how many rated (a 5.0 from 3 people is not
 *  better than a 4.6 from 900), else how well known it is on OpenStreetMap; being near counts a little. */
export function placeScore(p: { rating?: number | null; ratingCount?: number; score?: number }, km: number, inView: boolean) {
  const n = p.ratingCount || 0;
  const quality = p.rating ? ((p.rating * n + 3.8 * 15) / (n + 15)) * 2 + Math.log10(n + 1) * 0.6 : (p.score || 0);
  return quality - km * (p.rating ? 0.25 : 0.6) - (inView ? 0 : 3);
}

export async function loadCategory(c: SearchCategory, areaOnly: boolean) {
  const id = ++categoryReq;
  const view = map.getBounds();
  const bbox: PlaceBbox | undefined = areaOnly ? [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()] : undefined;
  showToast(`Finding the best ${c.label.toLowerCase()} here…`, 8000);
  const [online, , mod] = await Promise.all([searchPlacesOnline(c.query!, bbox).catch(() => null), loadPlaces(), loadPlaceSheet()]);
  if (id !== categoryReq || searchState.category !== c || !mod) { toast.classList.remove('show'); return; }
  const from = searchOrigin();
  // the 30 nearest: their details come in one request, so the best of them can be told apart
  const found = (online ? online.results : []).slice().sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0)).slice(0, 30);
  // Google's Text Search (Pro fields) has no ratings: its own order (relevance) counts then, as a rating would
  const googleOrder = new Map((online ? online.results : []).map((p, i) => [p, i]));
  const rank = (): SearchResult[] => {
    const ranked = found.map((p) => {
      const km = distKm(from, p.lngLat);
      const relevance = p.source === 'google' && !p.rating ? 7.5 - (googleOrder.get(p) ?? 20) * 0.25 : 0;
      const result: SearchResult = { title: p.title, subtitle: p.subtitle, kind: p.kind, origin: 'place', lngLat: p.lngLat, distance: p.distance, source: p.source,
        id: p.id, category: cuisineOr(p.category), address: p.address, rating: p.rating, ratingCount: p.ratingCount, priceLevel: p.priceLevel,
        openNow: p.openNow, openText: p.openText, photo: p.photo || undefined,
        info: { openingHours: p.hours || undefined, website: p.website || undefined, phone: p.phone || undefined } };
      return { result, score: placeScore(p, km, view.contains(p.lngLat)) + relevance
        + (c.key === 'offices' && /migra|einwohner|integration|population/i.test(p.title) ? 4 : 0) }; // the office newcomers go to first
    });
    // Bern's own places (map-places.js) when nothing was found online
    if (!ranked.length) for (const r of searchPlaces(c.query!, true).kinds) ranked.push({ result: r, score: -distKm(from, r.lngLat) });
    return ranked.sort((a, b) => b.score - a.score).slice(0, 15).map((x) => x.result);
  };
  // First the places as found, then again once OpenStreetMap's details (photos, hours, how well known) are in
  let places = rank();
  toast.classList.remove('show');
  if (!places.length) { showToast(`No ${c.label.toLowerCase()} found here.`); return; }
  const shown = mod.showResults({ title: c.label, text: c.query!, field: c.label, places, openNow: !!(online && online.openNow) }, !areaOnly);
  if (!found.some((p) => !p.details)) return;
  await PlaceSearch.enrich(found).catch(() => found);
  if (id !== categoryReq || searchState.category !== c) return;
  places = rank();
  mod.updateResults(shown, places); // the card opened meanwhile stays open
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() { /* nothing: the place sheet keeps a category's places on the map */ }
