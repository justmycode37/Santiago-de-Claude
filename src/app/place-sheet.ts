// ---- The place sheet, as in Google Maps: a list of places with their pins on the map, and a place's card ----
// Loaded the first time it is needed (search-pins.ts loadPlaceSheet()): a search for a kind of place or a name with
// several results ("pizza", "pharmacy open now", "Migros", a category chip), or a place picked in the search bar.
//
// List: photo, name, ★ rating (count) · price · kind, open or closed until when · distance · address, in the
// order given; each row has its pin on the map (the same .place-pin markers as before), and the two move together:
// a row or a pin picked opens its card and lifts its pin, shown as the category card (photo, name, rating).
// Card: photos (Google's load one at a time, each with its author), rating, price, open state and the week's hours,
// address, phone, website, Directions (the journey planner) and Start here, Google's reviews (author, stars, when,
// text), or, without Google's details, Google's own card in an iframe (Maps Embed: free) on request.
// Every part the data does not have is left out: no empty review section, no "rating: unknown".
//
// It is one panel: a bottom sheet on phones (a peek, half the screen, or up to the search card), a panel on the left
// on wide screens; never at the same time as the journey sheet (Directions closes it, opening it ends the trip on
// show). What the rest of the page needs to know of it is in state.ts (placeView), so nothing imports this file but
// through load().
import * as maplibregl from 'maplibre-gl';
import { map } from './map.ts';
import { KIND, inputs } from './search.ts';
import { clearPlacePins, drawPlacePins } from './search-pins.ts';
import { choose, setField, topUiBottom } from './trip-ends.ts';
import { fitCoords, mapPadding } from './pill.ts';
import { endJourney } from './routing.ts';
import { rememberPlace } from './search-history-ui.ts';
import { journey, placeView, searchState } from './state.ts';
import { PlaceSearch, openFirst } from '../places.ts';
import type { PlaceDetails, PlacePhoto, PlacePrediction, PlaceRef } from '../places.ts';
import type { SearchIcon, SearchResult } from './search.ts';

/** A list for the sheet: its title ('Restaurants', '“pizza”'), what was searched, and the places, best first. */
export interface PlaceList {
  title: string;
  text: string;
  places: SearchResult[];
  /** "open now" was asked: OpenStreetMap's places are kept open first, then those of unknown hours. */
  openNow?: boolean;
  /** What the destination field says meanwhile: what was typed, or the category's name (left out: as it is). */
  field?: string;
}

// ---------------------------------------------------------------- the panel
const el = (tag: string, cls?: string | null, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const svg = (inner: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const ICON = {
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  go: svg('<path d="M12 3l8 8-8 8M20 11H4"/>'),
  start: svg('<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>'),
  phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'),
  web: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>'),
  maps: svg('<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  pin: svg('<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
  wheel: svg('<circle cx="11" cy="4.5" r="1.6"/><path d="M11 7.5v6h5l2.5 5M11 10.5h5M8 11.5a5 5 0 1 0 6.5 6.3"/>'),
  photo: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>'),
};

const sheetEl = el('section', 'kj psheet');
sheetEl.id = 'placeSheet';
sheetEl.setAttribute('aria-label', 'Places');
const top = el('div', 'ps-top');
const handle = el('button', 'sheet-handle') as HTMLButtonElement;
handle.type = 'button';
handle.setAttribute('aria-label', 'Show more of the list');
handle.append(el('span'));
const headRow = el('div', 'ps-head');
const backBtn = el('button', 'ps-btn') as HTMLButtonElement;
backBtn.type = 'button';
backBtn.innerHTML = ICON.back;
backBtn.setAttribute('aria-label', 'Back to the list');
const headTitle = el('div', 'ps-title');
const closeBtn = el('button', 'ps-btn') as HTMLButtonElement;
closeBtn.type = 'button';
closeBtn.innerHTML = ICON.close;
closeBtn.setAttribute('aria-label', 'Close');
headRow.append(backBtn, headTitle, closeBtn);
top.append(handle, headRow);
const body = el('div', 'ps-body');
sheetEl.append(top, body);
document.body.append(sheetEl);

type Detent = 'peek' | 'mid' | 'full';
let detent: Detent = 'mid';
const wide = () => window.innerWidth >= 700;
function heights() {
  const h = window.innerHeight;
  const full = Math.max(260, h - topUiBottom() - 10);
  return { peek: Math.min(full, 168), mid: Math.min(full, Math.round(h * 0.46)), full };
}
function setDetent(d: Detent, animate = true) {
  detent = d;
  sheetEl.dataset.detent = d;
  placeView.side = wide();
  if (placeView.side) {
    sheetEl.style.height = '';
    placeView.covered = 0;
    return;
  }
  const px = heights()[d];
  sheetEl.style.transition = animate ? '' : 'none';
  sheetEl.style.height = `${px}px`;
  placeView.covered = px;
  handle.setAttribute('aria-label', d === 'full' ? 'Show more of the map' : 'Show more of the list');
}
let isOpen = false;
function openPanel(fieldText?: string) {
  // one sheet at a time: a trip on show gives way (the destination field is being searched again); ending it
  // clears the search's state, which this list is
  if (journey.dest) {
    const category = searchState.category, text = fieldText ?? inputs.to.value;
    endJourney(true);
    searchState.category = category;
    setField('to', text);
  } else if (fieldText != null) setField('to', fieldText);
  if (!isOpen) {
    isOpen = true;
    document.body.classList.add('places-open');
    sheetEl.classList.add('open');
    setDetent('mid', false);
  }
}
function hidePanel() {
  if (!isOpen) return;
  isOpen = false;
  req++;
  document.body.classList.remove('places-open');
  sheetEl.classList.remove('open');
  placeView.covered = 0;
  placeView.side = false;
  current = null;
  listState = null;
  setSelected(null);
}
// Closing it (the button, a pick, a new search): the places leave the map with it (clearPlacePins calls back here)
placeView.close = hidePanel;
closeBtn.addEventListener('click', () => { clearPlacePins(); if (!journey.dest) setField('to', ''); });
backBtn.addEventListener('click', () => { if (listState) renderList(true); });
handle.addEventListener('click', () => setDetent(detent === 'full' ? 'mid' : detent === 'mid' ? 'full' : 'mid'));
addEventListener('resize', () => { if (isOpen) setDetent(detent, false); });

// Dragging the top of the sheet between its three heights (phones)
(function drag() {
  let startY = 0, startH = 0, dragging = false;
  top.addEventListener('touchstart', (e) => {
    if (wide() || e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    startH = sheetEl.getBoundingClientRect().height;
    dragging = false;
  }, { passive: true });
  top.addEventListener('touchmove', (e) => {
    if (wide() || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - startY;
    if (!dragging && Math.abs(dy) < 6) return;
    dragging = true;
    if (e.cancelable) e.preventDefault();
    const hs = heights();
    sheetEl.style.transition = 'none';
    sheetEl.style.height = `${Math.max(hs.peek - 40, Math.min(hs.full, startH - dy))}px`;
  }, { passive: false });
  top.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    const h = sheetEl.getBoundingClientRect().height, hs = heights();
    const best = (['peek', 'mid', 'full'] as Detent[]).reduce((a, b) => (Math.abs(hs[b] - h) < Math.abs(hs[a] - h) ? b : a));
    setDetent(best);
  });
})();

// ---------------------------------------------------------------- what the rows and the card show
const fmtDist = (m: number) => PlaceSearch.formatDistance(m);
const count = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const PRICE_WORDS = ['Free', 'Inexpensive', 'Moderate', 'Expensive', 'Very expensive'];
const iconOf = (r: SearchResult): SearchIcon => r.icon || KIND[r.kind] || KIND.other;
function iconEl(r: SearchResult, cls: string) {
  const k = iconOf(r);
  const i = el('span', cls);
  i.style.background = k.color;
  if (k.fg) i.style.color = k.fg;
  i.innerHTML = svg(k.svg);
  return i;
}
function stars(rating: number) {
  const s = el('span', 'ps-stars');
  s.style.setProperty('--r', String(Math.max(0, Math.min(5, rating))));
  s.setAttribute('aria-label', `${rating.toFixed(1)} of 5 stars`);
  s.append(el('i'));
  return s;
}
/** What Google said of a place opened on this page, else what the row knows. */
function known(r: SearchResult) {
  const d = r.googleId ? PlaceSearch.seen(r.googleId) : r.id && r.id.startsWith('google:') ? PlaceSearch.seen(r.id.slice(7)) : null;
  return {
    rating: d ? d.rating : r.rating ?? null,
    ratingCount: d ? d.ratingCount : r.ratingCount || 0,
    priceLevel: d ? d.priceLevel : r.priceLevel ?? null,
    open: d && d.open ? d.open : r.openText ? { open: !!r.openNow, text: r.openText } : null,
    // a photo it already has: a free one, or Google's that its card has fetched (never a new request for a row)
    photo: (d && d.photos.map((p) => p.url || (p.googleName ? PlaceSearch.photoKnown(p.googleName, 640) : '')).find(Boolean)) || '',
  };
}
function openLine(o: { open: boolean; text: string }) {
  const s = el('span', o.open ? 'ps-open' : 'ps-closed');
  const [state, ...rest] = o.text.split(' · ');
  s.append(el('b', null, state));
  if (rest.length) s.append(` · ${rest.join(' · ')}`);
  return s;
}

// ---- photos: a free one (OpenStreetMap, Wikimedia) as it is; Google's fetched (and counted) once, when shown ----
function img(src: string, cls: string) {
  const i = document.createElement('img');
  i.className = cls;
  i.alt = '';
  i.decoding = 'async';
  i.referrerPolicy = 'no-referrer';
  i.addEventListener('error', () => i.remove());
  i.src = src;
  return i;
}

// ---------------------------------------------------------------- the list
let req = 0; // bumped for every list or card: answers for an older one are dropped
let listState: { list: PlaceList; scroll: number } | null = null;
let current: SearchResult | null = null; // the place whose card is open
let pinEls: HTMLElement[] = [];

// What a list shows of the places given: not a name found far away too ("Pizza" in Kloten) when there are enough
// near (within 30 km); for "open now", the open ones first, then those of unknown hours
function shown(places: SearchResult[], openNow?: boolean) {
  const near = places.filter((r) => r.distance == null || r.distance <= 30000);
  const all = near.length >= 5 ? near : places;
  return openNow ? openFirst(all) : all;
}
/** Opens the sheet with a list of places and puts them on the map; fit: show them all (unless some are in view).
 *  Returns the list, for updateResults(). */
export function showResults(list: PlaceList, fit = true): object {
  openPanel(list.field);
  const places = shown(list.places, list.openNow);
  listState = { list: { ...list, places }, scroll: 0 };
  const shownList = listState;
  pinEls = drawPlacePins(places, list.text, 'to', (r) => showPlace(r, true));
  renderList(false);
  if (fit && places.length) {
    const view = map.getBounds();
    if (!places.slice(0, 5).some((r) => view.contains(r.lngLat))) requestAnimationFrame(() => fitCoords(places.slice(0, 8).map((r) => r.lngLat), 16));
  }
  return shownList;
}
/** The same list (as showResults() returned it) with more known of its places (photos, hours after enrich()): the
 *  rows again, where they were, and the card that is open stays open. A list no longer shown is left alone. */
export function updateResults(list: object | null, places: SearchResult[]) {
  if (!listState || (list && list !== listState)) return;
  const before = listState.list.places;
  const kept = shown(places, listState.list.openNow);
  listState.list.places = kept;
  // the place whose card is open, in the new rows (a category ranks new objects for the same places)
  if (current && !kept.includes(current)) current = kept.find((x) => x.title === current!.title && x.lngLat[0] === current!.lngLat[0] && x.lngLat[1] === current!.lngLat[1]) || current;
  // the pins follow the rows (now known to be closed: gone from both)
  if (kept.length !== before.length || kept.some((r, i) => r !== before[i])) pinEls = drawPlacePins(kept, listState.list.text, 'to', (r) => showPlace(r, true));
  if (!current) { const s = body.scrollTop; renderList(false); body.scrollTop = s; }
  else setSelected(current);
}

function renderList(restore: boolean) {
  if (!listState) return;
  req++;
  current = null;
  setSelected(null);
  sheetEl.classList.remove('card');
  backBtn.hidden = true;
  const { list } = listState;
  headTitle.replaceChildren(el('b', null, list.title), el('small', null, list.places.length === 1 ? '1 place' : `${list.places.length} places`));
  const ul = el('ul', 'ps-list');
  ul.setAttribute('role', 'list');
  if (!list.places.length) ul.append(el('li', 'ps-empty', list.openNow ? 'Nothing open found here right now.' : 'Nothing found here.'));
  list.places.forEach((r, i) => {
    const li = el('li', 'ps-row');
    const btn = el('button', 'ps-row-btn') as HTMLButtonElement;
    btn.type = 'button';
    const k = known(r);
    const text = el('span', 'ps-row-text');
    text.append(el('b', 'ps-name', r.title));
    const l2 = el('span', 'ps-line');
    if (k.rating) l2.append(el('span', 'ps-rating', k.rating.toFixed(1)), stars(k.rating), k.ratingCount ? ` (${count(k.ratingCount)})` : '');
    const words = [k.priceLevel != null && k.priceLevel > 0 ? '$'.repeat(k.priceLevel) : '', r.category || r.subtitle.split(' · ')[0]].filter(Boolean);
    if (words.length) l2.append(`${k.rating ? ' · ' : ''}${words.join(' · ')}`);
    const l3 = el('span', 'ps-line');
    if (k.open) l3.append(openLine(k.open));
    const rest = [r.distance != null ? fmtDist(r.distance) : '', r.address || ''].filter(Boolean).join(' · ');
    if (rest) l3.append(`${k.open ? ' · ' : ''}${rest}`);
    text.append(l2);
    if (l3.childNodes.length) text.append(l3);
    btn.append(text);
    const src = k.photo || r.photo || '';
    if (src) btn.append(img(src, r.photoIsLogo && !k.photo ? 'ps-thumb logo' : 'ps-thumb'));
    else btn.append(iconEl(r, 'ps-thumb ps-thumb-icon'));
    btn.addEventListener('click', () => { listState!.scroll = body.scrollTop; showPlace(r, true); });
    btn.addEventListener('mouseenter', () => pinEls[i]?.classList.add('hover'));
    btn.addEventListener('mouseleave', () => pinEls[i]?.classList.remove('hover'));
    li.append(btn);
    ul.append(li);
  });
  body.replaceChildren(ul, attribution(list.places.some((r) => r.source === 'google') ? 'google' : 'osm'));
  body.scrollTop = restore ? listState.scroll : 0;
}

function attribution(source: 'google' | 'osm', photoFromCommons = false) {
  const p = el('p', 'ps-attr', source === 'google' ? 'Google Maps' : 'Places © OpenStreetMap contributors');
  if (photoFromCommons) p.append(' · Photo: Wikimedia Commons');
  return p;
}

// ---------------------------------------------------------------- the selected place on the map
let cardMarker: maplibregl.Marker | null = null;
function setSelected(r: SearchResult | null) {
  pinEls.forEach((p) => p.classList.remove('sel'));
  if (cardMarker) { cardMarker.remove(); cardMarker = null; }
  if (!r) return;
  const i = listState ? listState.list.places.indexOf(r) : -1;
  if (pinEls[i]) pinEls[i].classList.add('sel');
  cardMarker = new maplibregl.Marker({ element: mapCard(r), anchor: 'bottom', offset: [0, -16] }).setLngLat(r.lngLat).addTo(map);
}
// The category card (.ev-card.place-card) above the selected place: photo, name, rating, open state
function mapCard(r: SearchResult) {
  const k = known(r);
  const card = el('div', 'ev-card place-card ps-mapcard');
  const inner = el('div', 'ev-inner');
  const b = el('button', 'ev-body') as HTMLButtonElement;
  b.type = 'button';
  b.setAttribute('aria-label', `${r.title}: show its card`);
  const src = k.photo || r.photo || '';
  const photo = document.createElement('img');
  photo.alt = '';
  photo.referrerPolicy = 'no-referrer';
  photo.addEventListener('error', () => b.classList.add('no-photo'));
  const caption = el('span', 'ev-caption');
  caption.append(el('strong', null, r.title));
  const line = [k.rating ? `★ ${k.rating.toFixed(1)}${k.ratingCount ? ` (${count(k.ratingCount)})` : ''}` : '', r.category || ''].filter(Boolean).join(' · ');
  if (line) caption.append(el('small', null, line));
  if (k.open) caption.append(el('small', null, k.open.text.split(' · ')[0]));
  b.append(photo, iconEl(r, 'pc-icon'), caption);
  b.classList.toggle('no-photo', !src);
  if (src) photo.src = src;
  b.addEventListener('click', (e) => { e.stopPropagation(); if (!wide() && detent === 'peek') setDetent('mid'); });
  inner.append(b);
  card.append(inner);
  return card;
}
// The place in the part of the map the sheet leaves free
function reveal(ll: LngLat) {
  const pad = mapPadding();
  const p = map.project(ll), c = map.getContainer();
  if (p.x > pad.left && p.x < c.clientWidth - pad.right && p.y > pad.top + 170 && p.y < c.clientHeight - pad.bottom) return;
  map.easeTo({ center: ll, zoom: Math.max(map.getZoom(), 15.5), padding: { ...pad, top: pad.top + 170 }, duration: 600 });
}

// ---------------------------------------------------------------- a place's card
/** A place's card in the sheet. fromList: opened from the list (Back returns to it). */
export async function showPlace(r: SearchResult, fromList = false) {
  openPanel(fromList ? undefined : r.title);
  if (!fromList) { listState = null; pinEls = drawPlacePins([r], r.title, 'to', () => {}); }
  current = r;
  rememberPlace(r); // in Recent and Frequent (search-history-ui.ts)
  const id = ++req;
  sheetEl.classList.add('card');
  backBtn.hidden = !fromList || !listState;
  // the card has the name; the header says what list it belongs to
  headTitle.replaceChildren(el('b', null, fromList && listState ? listState.list.title : ''));
  setSelected(r);
  reveal(r.lngLat);
  if (!wide() && detent === 'peek') setDetent('mid');
  body.replaceChildren(el('p', 'ps-loading', `Loading ${r.title}…`));
  body.scrollTop = 0;
  let d = await PlaceSearch.details(refOf(r)).catch(() => null);
  if (id !== req) return;
  // a Google prediction matched to this row by name and distance, but Google's place is elsewhere (another branch):
  // not this place's details
  if (d && d.source === 'google' && d.lngLat && r.source !== 'google' && metres(d.lngLat, r.lngLat) > 250) {
    r.googleId = undefined;
    d = await PlaceSearch.details(refOf(r)).catch(() => null);
    if (id !== req) return;
  }
  renderCard(r, d);
  // Google's details: the row and the card on the map show its rating and the photo the card has paid for
  if (d && d.source === 'google') { if (fromList && listState) updateResults(null, listState.list.places); else setSelected(r); }
}
/** A prediction of Google's picked in the search bar: its details give its point, then its card. */
export async function showPrediction(p: PlacePrediction) {
  openPanel(p.title);
  listState = null;
  const id = ++req;
  sheetEl.classList.add('card');
  backBtn.hidden = true;
  headTitle.replaceChildren();
  body.replaceChildren(el('p', 'ps-loading', `Loading ${p.title}…`));
  const d = await PlaceSearch.details({ title: p.title, address: p.subtitle, googleId: p.placeId }).catch(() => null);
  if (id !== req) return;
  const ll = (d && d.lngLat) || await PlaceSearch.resolve(p.placeId);
  if (id !== req) return;
  if (!ll) { body.replaceChildren(el('p', 'ps-loading', 'This place could not be found.')); return; }
  const r: SearchResult = { title: (d && d.title) || p.title, subtitle: p.subtitle, kind: p.kind, origin: 'place', lngLat: ll, source: 'google',
    googleId: p.placeId, address: (d && d.address) || p.subtitle, category: (d && d.category) || '', distance: p.distance };
  pinEls = drawPlacePins([r], r.title, 'to', () => {});
  current = r;
  rememberPlace(r);
  reveal(ll);
  renderCard(r, d);
  setSelected(r);
}

const refOf = (r: SearchResult): PlaceRef => ({
  title: r.title, category: r.category || r.subtitle.split(' · ')[0] || '', address: r.address || '', lngLat: r.lngLat,
  id: r.id, googleId: r.googleId || (r.id && r.id.startsWith('google:') ? r.id.slice(7) : undefined),
  info: r.info ? { openingHours: r.info.openingHours, website: r.info.website, phone: r.info.phone, image: r.info.image, wikidata: r.info.wikidata, cuisine: r.info.cuisine } : undefined,
  photo: r.photo, photoIsLogo: r.photoIsLogo,
});

function renderCard(r: SearchResult, d: PlaceDetails | null) {
  const parts: HTMLElement[] = [];
  const photos = d ? d.photos : r.photo ? [{ url: r.photo, logo: r.photoIsLogo }] : [];
  if (photos.length) parts.push(photoStrip(photos, d));

  // name, rating, kind and price, open state
  const head = el('div', 'ps-card-head');
  head.append(el('h2', 'ps-card-title', (d && d.title) || r.title));
  if (d && d.rating) {
    const line = el('div', 'ps-line ps-rating-line');
    line.append(el('span', 'ps-rating', d.rating.toFixed(1)), stars(d.rating));
    if (d.ratingCount) line.append(` (${d.ratingCount.toLocaleString('en')})`);
    head.append(line);
  }
  const what = [d && d.category || r.category || '', d ? (d.priceRange || (d.priceLevel != null && d.priceLevel > 0 ? PRICE_WORDS[d.priceLevel] : '')) : '',
    r.distance != null ? fmtDist(r.distance) : ''].filter(Boolean);
  if (what.length) head.append(el('div', 'ps-line', what.join(' · ')));
  const open = d ? d.open : r.openText ? { open: !!r.openNow, text: r.openText } : null;
  if (open) { const l = el('div', 'ps-line'); l.append(openLine(open)); head.append(l); }
  if (d && d.summary) head.append(el('p', 'ps-summary', d.summary));
  parts.push(head);

  // what you can do: get there, start here, call, the website, Google Maps
  const actions = el('div', 'ps-actions');
  const action = (label: string, icon: string, primary: boolean, fn: (() => void) | string) => {
    const a = el(typeof fn === 'string' ? 'a' : 'button', primary ? 'ps-action primary' : 'ps-action');
    a.innerHTML = icon;
    a.append(el('span', null, label));
    if (typeof fn === 'string') {
      (a as HTMLAnchorElement).href = fn;
      if (/^https?:/.test(fn)) { (a as HTMLAnchorElement).target = '_blank'; (a as HTMLAnchorElement).rel = 'noopener noreferrer'; }
    } else { (a as HTMLButtonElement).type = 'button'; a.addEventListener('click', fn); }
    actions.append(a);
  };
  const dest: SearchResult = { ...r, title: (d && d.title) || r.title }; // its own point: the row's
  action('Directions', ICON.go, true, () => choose(dest, 'to'));
  action('Start here', ICON.start, false, () => choose(dest, 'from'));
  if (d && d.phone) action('Call', ICON.phone, false, 'tel:' + d.phone.replace(/[^\d+]/g, ''));
  if (d && d.website) action('Website', ICON.web, false, d.website);
  if (d && d.mapsUri) action('Google Maps', ICON.maps, false, d.mapsUri);
  parts.push(actions);

  // the details: address, hours, phone, website, wheelchair
  const rows = el('ul', 'ps-info');
  const row = (icon: string, content: Node | string) => { const li = el('li'); li.innerHTML = icon; const s = el('div'); s.append(content); li.append(s); rows.append(li); return s; };
  const address = (d && d.address) || r.address;
  if (address) row(ICON.pin, address);
  if (d && d.weekHours.length) {
    const det = el('details', 'ps-hours') as HTMLDetailsElement;
    const sum = el('summary');
    sum.append(open ? openLine(open) : 'Opening hours');
    const ul = el('ul');
    const today = (new Date().getDay() + 6) % 7;
    d.weekHours.forEach((line, i) => { const li = el('li', i === today ? 'today' : null, line); ul.append(li); });
    det.append(sum, ul);
    row(ICON.clock, det);
  } else if (d && d.hoursText) row(ICON.clock, d.hoursText);
  if (d && d.phone) { const a = el('a', null, d.phone) as HTMLAnchorElement; a.href = 'tel:' + d.phone.replace(/[^\d+]/g, ''); row(ICON.phone, a); }
  if (d && d.website) {
    const a = el('a', null, hostOf(d.website)) as HTMLAnchorElement;
    a.href = d.website; a.target = '_blank'; a.rel = 'noopener noreferrer';
    row(ICON.web, a);
  }
  if (d && d.wheelchair) row(ICON.wheel, d.wheelchair);
  if (rows.children.length) parts.push(rows);

  // Google's reviews (as Google orders them: most relevant first)
  if (d && d.reviews.length) parts.push(reviews(d));

  // no details from Google (none for this place, or not now): Google's own card, when asked for (free, but heavy)
  if (d && d.embed && d.source === 'osm') parts.push(embedBox(d));

  parts.push(attribution(d ? d.source : r.source === 'google' ? 'google' : 'osm', photos.some((p) => p.url && p.url.includes('wikimedia'))));
  body.replaceChildren(...parts);
}
/** A link that opens in a new tab, or the text alone when there is no address. */
function link(href: string, text: string, cls?: string) {
  if (!href) return el('b', cls || null, text);
  const a = el('a', cls || null, text) as HTMLAnchorElement;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}
const metres = (a: LngLat, b: LngLat) => Math.hypot((a[0] - b[0]) * 76000, (a[1] - b[1]) * 111000);
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function photoStrip(photos: PlacePhoto[], d: PlaceDetails | null) {
  const strip = el('div', 'ps-photos');
  photos.forEach((p, i) => {
    const fig = el('figure', 'ps-photo');
    const show = async () => {
      const src = p.url || (p.googleName ? await PlaceSearch.photo(p.googleName, 640) : '');
      if (!src) { // today's photo budget is used (or it failed): Google Maps has them
        const more = el('a', 'ps-photo-more', 'Photos on Google Maps') as HTMLAnchorElement;
        const link = p.mapsUri || (d && d.mapsUri) || '';
        if (link) { more.href = link; more.target = '_blank'; more.rel = 'noopener noreferrer'; }
        fig.replaceChildren(more);
        return;
      }
      fig.replaceChildren(img(src, p.logo ? 'logo' : ''));
      if (i === 0 && p.googleName && current) setSelected(current); // the card on the map shows it too
      // every author's credit, on the photo, and the photo on Google Maps (Google's terms)
      if (p.credits && p.credits.length) {
        const cap = el('span', 'ps-credit');
        p.credits.forEach((c, n) => {
          if (n) cap.append(', ');
          cap.append(link(c.uri, c.name));
        });
        if (p.mapsUri) cap.append(' · ', link(p.mapsUri, 'Google Maps'));
        fig.append(cap);
      }
    };
    // the first one at once; Google's others when tapped (each one is a billed request), free ones at once
    if (i === 0 || !p.googleName || PlaceSearch.photoKnown(p.googleName, 640)) show();
    else {
      const b = el('button', 'ps-photo-load') as HTMLButtonElement;
      b.type = 'button';
      b.innerHTML = ICON.photo;
      b.append(el('span', null, 'Show photo'));
      b.addEventListener('click', show);
      fig.append(b);
    }
    strip.append(fig);
  });
  return strip;
}

function reviews(d: PlaceDetails) {
  const sec = el('section', 'ps-reviews');
  sec.append(el('h3', null, 'Reviews'));
  for (const rv of d.reviews) {
    const item = el('article', 'ps-review');
    const who = el('div', 'ps-review-head');
    if (rv.avatar) who.append(img(rv.avatar, 'ps-avatar'));
    const name = link(rv.authorUri, rv.author, 'ps-author');
    const meta = el('div', 'ps-line');
    if (rv.rating) meta.append(stars(rv.rating));
    if (rv.when) meta.append(' ', rv.mapsUri ? link(rv.mapsUri, rv.when, 'ps-when') : rv.when);
    const col = el('div');
    col.append(name, meta);
    who.append(col);
    item.append(who);
    if (rv.text) {
      const t = el('p', 'ps-review-text', rv.text);
      item.append(t);
      if (rv.text.length > 220) {
        const more = el('button', 'ps-more', 'More') as HTMLButtonElement;
        more.type = 'button';
        more.addEventListener('click', () => { t.classList.add('full'); more.remove(); });
        item.append(more);
      }
    }
    sec.append(item);
  }
  return sec;
}

function embedBox(d: PlaceDetails) {
  const box = el('div', 'ps-embed');
  const b = el('button', 'ps-action') as HTMLButtonElement;
  b.type = 'button';
  b.innerHTML = ICON.maps;
  b.append(el('span', null, d.limited ? 'Ratings and reviews on Google Maps' : 'See it on Google Maps'));
  b.addEventListener('click', () => {
    const f = document.createElement('iframe');
    f.src = d.embed;
    f.title = `${d.title} on Google Maps`;
    f.loading = 'lazy';
    f.referrerPolicy = 'no-referrer-when-downgrade'; // the key is restricted to the site's address
    f.allowFullscreen = true;
    box.replaceChildren(f);
  });
  box.append(b);
  return box;
}

