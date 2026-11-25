// ---- Categories: what the empty search bar offers ("Restaurants", "Hotels", "Supermarkets", …) ----
// A tap on one (or typing one and pressing Enter) puts the best places of that kind in the part of the map in view on
// the map as cards, in the format of the event cards: photo, name, rating, distance, website. Not every place: the
// best few that fit on the screen without covering each other.
// "Best": Google's rating weighed by how many people rated it, with a Google key (config.js); otherwise how well
// known the place is on OpenStreetMap and Wikidata (PlaceSearch.enrich). Being near counts a little.
// With "New to Switzerland" on in Settings, categories for newcomers come first: language courses (the community
// events) and town halls & migration offices. Those events are not on the map otherwise (map-events.ts).
import * as maplibregl from 'maplibre-gl';
import { map } from './map.ts';
import { eventMarkers, updateCards } from './map-events.ts';
import { showToast, toast } from '../toast.ts';
import { KIND, inputs, list } from './search.ts';
import { NEAR_PHRASE, fold, searchOrigin, searchPlaces, searchPlacesOnline } from './search-places.ts';
import { areaChip, clearPlacePins, onTap } from './search-pins.ts';
import { choose, closeSearch, setField, topUiBottom } from './trip-ends.ts';
import { loadPlaces } from './map-places.ts';
import { mapPadding } from './pill.ts';
import { distKm } from './routing.ts';
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
/** A place of a category, ranked, with what its card shows. */
interface CategoryPlace { result: SearchResult; photo: string; website: string; lines: string[]; score: number; id: string }

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

// ---- A category on the map ----
// 'Restaurant, italian' → 'Italian': the kind of food says more than the kind of place
const cuisineOr = (category: string) => { const [kind, extra] = category.split(', '); return extra ? extra[0].toUpperCase() + extra.slice(1) : kind; };
const categoryMarkers = new Map<string, maplibregl.Marker>();
let categoryPlaces: CategoryPlace[] = [];
let categoryReq = 0;
export const CATEGORY_CARDS = 6; // at most this many cards at once: the map stays readable

export function enterCategory(c: SearchCategory) {
  clearPlacePins(); // also leaves the category before (exitCategory)
  searchState.category = c;
  searchState.results = [];
  searchState.last = null;
  searchState.reqId++;
  setField('to', c.label);
  closeSearch();
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
  categoryPlaces = [];
  clearCategoryCards();
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

export async function loadCategory(c: SearchCategory, areaOnly: boolean) {
  const id = ++categoryReq;
  const view = map.getBounds();
  const bbox: PlaceBbox | undefined = areaOnly ? [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()] : undefined;
  showToast(`Finding the best ${c.label.toLowerCase()} here…`, 8000);
  const [online] = await Promise.all([searchPlacesOnline(c.query!, bbox).catch(() => null), loadPlaces()]);
  if (id !== categoryReq || searchState.category !== c) return;
  const from = searchOrigin();
  // the 30 nearest: their details come in one request, so the best of them can be told apart
  const found = (online ? online.results : []).slice().sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0)).slice(0, 30);
  const rank = () => {
    const ranked: CategoryPlace[] = found.map((p) => {
      const km = distKm(from, p.lngLat);
      const n = p.ratingCount || 0;
      // Google: stars weighed by how many rated (a 5.0 from 3 people is not better than a 4.6 from 900)
      const quality = p.rating ? ((p.rating * n + 3.8 * 15) / (n + 15)) * 2 + Math.log10(n + 1) * 0.6 : (p.score || 0);
      const rating = p.rating ? `★ ${p.rating.toFixed(1)}${n ? ` (${n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n})` : ''}` : '';
      const open = p.openNow === true ? 'Open' : p.openNow === false ? 'Closed' : '';
      return {
        id: p.id,
        result: { title: p.title, subtitle: p.subtitle, kind: p.kind, origin: 'place', lngLat: p.lngLat, distance: p.distance, source: p.source },
        photo: p.photo || '',
        website: p.website || '',
        lines: [[rating, cuisineOr(p.category)].filter(Boolean).join(' · '), [PlaceSearch.formatDistance(km * 1000), open].filter(Boolean).join(' · ')],
        score: quality - km * (p.rating ? 0.25 : 0.6) - (view.contains(p.lngLat) ? 0 : 3)
          + (c.key === 'offices' && /migra|einwohner|integration|population/i.test(p.title) ? 4 : 0), // the office newcomers go to first
      };
    });
    // Bern's own places (map-places.js) when nothing was found online
    if (!ranked.length) {
      for (const r of searchPlaces(c.query!, true).kinds) {
        ranked.push({ id: r.title + r.lngLat.join(), result: r, photo: '', website: '', lines: [r.subtitle], score: -distKm(from, r.lngLat) });
      }
    }
    return ranked.sort((a, b) => b.score - a.score).slice(0, 15);
  };
  // First the places as found (Google already has ratings and photos), then again once OpenStreetMap's details are in
  categoryPlaces = rank();
  toast.classList.remove('show');
  if (!categoryPlaces.length) { showToast(`No ${c.label.toLowerCase()} found here.`); return; }
  if (categoryPlaces.some((p) => view.contains(p.result.lngLat))) updateCategoryCards();
  else {
    // none where you are looking: show where the best of them are
    const bounds = new maplibregl.LngLatBounds();
    for (const p of categoryPlaces.slice(0, 5)) bounds.extend(p.result.lngLat);
    const pad = mapPadding();
    map.fitBounds(bounds, { padding: { ...pad, top: pad.top + 200, left: pad.left + 80, right: pad.right + 80, bottom: pad.bottom + 20 }, maxZoom: 16, duration: 900 });
  }
  if (!found.some((p) => !p.details)) return;
  await PlaceSearch.enrich(found).catch(() => found);
  if (id !== categoryReq || searchState.category !== c) return;
  categoryPlaces = rank();
  clearCategoryCards(); // the cards again, now with photos and websites
  updateCategoryCards();
}

function clearCategoryCards() {
  for (const m of categoryMarkers.values()) m.remove();
  categoryMarkers.clear();
}
// The best places that fit on the screen without covering each other, like the event cards
function updateCategoryCards() {
  if (!searchState.category || searchState.category.events || journey.dest) { clearCategoryCards(); return; }
  const { clientWidth, clientHeight } = map.getContainer();
  const shown: { p: CategoryPlace; point: maplibregl.Point }[] = [];
  const height = (p: CategoryPlace) => (p.photo ? 180 : 125); // the card and its tail, above its place
  for (const p of categoryPlaces) {
    const point = map.project(p.result.lngLat);
    if (point.x < 20 || point.x > clientWidth - 20 || point.y < topUiBottom() + height(p) - 40 || point.y > clientHeight) continue;
    // a card covers the cards whose place is up to one card's height below or above it
    if (shown.some((o) => Math.abs(o.point.x - point.x) < 158
      && (o.point.y > point.y ? o.point.y - point.y < height(o.p) : point.y - o.point.y < height(p)))) continue;
    shown.push({ p, point });
    if (shown.length >= CATEGORY_CARDS) break;
  }
  const next = new Map<string, maplibregl.Marker>();
  for (const { p } of shown) {
    let marker = categoryMarkers.get(p.id);
    if (marker) categoryMarkers.delete(p.id);
    else marker = new maplibregl.Marker({ element: makePlaceCard(p), anchor: 'bottom' }).setLngLat(p.result.lngLat).addTo(map);
    next.set(p.id, marker);
  }
  clearCategoryCards();
  for (const [k, m] of next) categoryMarkers.set(k, m);
}

const GLOBE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>';
function makePlaceCard(p: CategoryPlace) {
  const k = p.result.icon || KIND[p.result.kind] || KIND.other;
  const card = document.createElement('div');
  card.className = 'ev-card place-card';
  const inner = document.createElement('div');
  inner.className = 'ev-inner';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ev-body';
  button.setAttribute('aria-label', `${p.result.title}, ${p.lines.join(', ')}. Plan a trip there`);
  const photo = document.createElement('img');
  photo.loading = 'lazy';
  photo.alt = '';
  photo.addEventListener('error', () => button.classList.add('no-photo'));
  const icon = document.createElement('span');
  icon.className = 'pc-icon';
  icon.style.background = k.color;
  if (k.fg) icon.style.color = k.fg;
  icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${k.svg}</svg>`;
  const caption = document.createElement('span');
  caption.className = 'ev-caption';
  const title = document.createElement('strong');
  title.textContent = p.result.title;
  caption.append(title);
  for (const line of p.lines.filter(Boolean)) {
    const small = document.createElement('small');
    small.textContent = line;
    caption.append(small);
  }
  button.append(photo, icon, caption);
  button.classList.toggle('no-photo', !p.photo);
  if (p.photo) photo.src = p.photo;
  button.addEventListener('click', (e) => { e.stopPropagation(); choose(p.result, 'to'); });
  inner.append(button);
  if (p.website) {
    const web = document.createElement('a');
    web.className = 'pc-web';
    web.href = p.website;
    web.target = '_blank';
    web.rel = 'noopener';
    web.setAttribute('aria-label', `Website of ${p.result.title}`);
    web.innerHTML = GLOBE;
    web.addEventListener('click', (e) => e.stopPropagation());
    inner.append(web);
  }
  card.append(inner);
  return card;
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  map.on('moveend', updateCategoryCards);
  map.on('resize', updateCategoryCards);
}
