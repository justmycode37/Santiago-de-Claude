// ---- Your searches in the search list: "Recent" and "Frequent" when nothing is typed, and the ones the text matches
//      while typing (above the results, so Enter opens what is on top). What is kept and how it is ranked:
//      search-history.ts. search-pins.ts render() calls the two render functions; choosing a result, a category or
//      a trip calls the remember functions. ----
import { KIND, inputs, list } from './search.ts';
import { onTap, render } from './search-pins.ts';
import { choose, chooseTrip } from './trip-ends.ts';
import { categoryFromHistory, enterCategory } from './categories.ts';
import { journey, searchState } from './state.ts';
import { clear, frequent, matching, recent, record, remove, samePlace } from '../search-history.ts';
import type { SearchCategory } from './categories.ts';
import type { HistoryEntry, HistoryFilter, HistoryPlace } from '../search-history.ts';
import type { SearchIcon, SearchKind, SearchOrigin, SearchResult, TripField } from './search.ts';
import type { JourneyDest } from './state.ts';

const RECENT = 4, FREQUENT = 3, TYPED = 2;

// ---- Remembering ----
/** A searched place as the history keeps it; null for what was not searched for (a pin, your location, a place
 *  tapped on the map). */
function historyPlace(d: JourneyDest & Partial<Pick<SearchResult, 'subtitle' | 'kind'>>): HistoryPlace | null {
  if (!d.origin || d.origin === 'pin' || !d.title) return null;
  const p: HistoryPlace = { title: d.title, sub: d.subtitle || '', kind: d.kind || 'other', origin: d.origin, ll: [d.lngLat[0], d.lngLat[1]] };
  if (d.kanteId) p.kanteId = d.kanteId;
  return p;
}
/** The trip on show, when both its ends are places you searched for. */
export function rememberTrip() {
  const from = searchState.tripStart && historyPlace(searchState.tripStart), to = journey.dest && historyPlace(journey.dest);
  if (from && to && !samePlace(from, to)) record({ k: 'j', from, to });
}
/** A result picked for either end of the trip, and the trip if both ends are now places you searched for. */
export function rememberChoice(r: SearchResult) {
  const p = historyPlace(r);
  if (p) record({ k: 'p', p });
  rememberTrip();
}
export function rememberCategory(c: SearchCategory) {
  record(c.query && c.key.startsWith('q:') ? { k: 'c', key: c.key, label: c.label, query: c.query } : { k: 'c', key: c.key, label: c.label });
}

// ---- Opening one again ----
const asResult = (p: HistoryPlace): SearchResult => ({ title: p.title, subtitle: p.sub, kind: p.kind as SearchKind,
  origin: p.origin as SearchOrigin, lngLat: [p.ll[0], p.ll[1]], ...(p.kanteId ? { kanteId: p.kanteId } : {}) });
function open(e: HistoryEntry, field: TripField) {
  if (e.k === 'p') choose(asResult(e.p), field);
  else if (e.k === 'j') chooseTrip(asResult(e.from), asResult(e.to));
  else {
    const c = categoryFromHistory(e.key, e.label, e.query);
    if (c) enterCategory(c);
    else { remove(e.id); render(); } // a category this version no longer has
  }
}

// Where the trip starts takes only places; where it goes also trips, and categories while no trip is on show (a
// category's places are not on the map during one)
const filterFor = (field: TripField, typed: boolean): HistoryFilter => (e) => e.k === 'p'
  || (field === 'to' && (e.k === 'j' || (e.k === 'c' && !typed && !journey.dest)));

// ---- Drawing ----
const TRIP_ICON: SearchIcon = { color: 'var(--navy)', svg: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"/>' };
const CLOCK_ICON: SearchIcon = { color: 'var(--pressed)', fg: 'var(--bar-secondary)', svg: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>' };
const X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
function iconOf(e: HistoryEntry): SearchIcon {
  if (e.k === 'p') return KIND[e.p.kind as SearchKind] || KIND.other;
  if (e.k === 'j') return TRIP_ICON;
  return categoryFromHistory(e.key, e.label, e.query)?.icon || KIND.other;
}
/** Words of the app's own (not a name): in a span of their own, so the page's translation reaches them. */
const words = (s: string) => { const span = document.createElement('span'); span.textContent = s; return span; };
function row(e: HistoryEntry, field: TripField, icon = iconOf(e)) {
  const li = document.createElement('li');
  li.className = 'hist';
  const main = document.createElement('div');
  main.className = 'hist-main';
  main.setAttribute('role', 'option');
  const ic = document.createElement('div');
  ic.className = 'icon';
  ic.style.background = icon.color;
  if (icon.fg) ic.style.color = icon.fg;
  ic.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon.svg}</svg>`; // our own icons only, never stored ones
  const text = document.createElement('div');
  text.className = 'text';
  const t = document.createElement('div');
  t.className = 'title';
  const s = document.createElement('div');
  s.className = 'subtitle';
  if (e.k === 'p') { t.textContent = e.p.title; s.textContent = e.p.sub; }
  else if (e.k === 'j') { t.textContent = `${e.from.title} → ${e.to.title}`; s.append(words('Trip')); }
  else { t.append(words(e.label)); s.append(words('Category')); }
  text.append(t, s);
  main.append(ic, text);
  onTap(main, () => open(e, field));
  // beside the row, not in it: a tap on it must not also open the entry
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'hist-del';
  del.setAttribute('aria-label', 'Remove from history');
  del.innerHTML = X_SVG;
  onTap(del, () => { remove(e.id); render(); });
  li.append(main, del);
  return li;
}
function head(title: string, withClear: boolean) {
  const li = document.createElement('li');
  li.className = 'hist-head';
  li.append(words(title));
  if (withClear) {
    // twice to clear: once by mistake does nothing
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hist-clear';
    b.textContent = 'Clear';
    let armed = 0;
    onTap(b, () => {
      if (armed) { clearTimeout(armed); clear(); render(); return; }
      b.textContent = 'Clear all?';
      b.classList.add('armed');
      armed = setTimeout(() => { armed = 0; b.textContent = 'Clear'; b.classList.remove('armed'); }, 4000);
    });
    li.append(b);
  }
  return li;
}

/** Nothing typed: "Recent" and "Frequent". Returns whether there was anything to show (the list is then open). */
export function renderHistory(field: TripField): boolean {
  const filter = filterFor(field, false);
  const rec = recent(RECENT, filter);
  if (!rec.length) return false;
  const freq = frequent(FREQUENT, rec, filter);
  list.appendChild(head('Recent', true));
  for (const e of rec) list.appendChild(row(e, field));
  if (freq.length) {
    list.appendChild(head('Frequent', false));
    for (const e of freq) list.appendChild(row(e, field));
  }
  list.classList.add('open');
  list.scrollTop = 0;
  return true;
}

// While typing: your searches the text matches, those the results do not already have
function typedEntries(field: TripField) {
  const text = inputs[field].value.trim();
  if (!text) return [];
  const inResults = (p: HistoryPlace) => searchState.results.some((r) => samePlace(p, { title: r.title, ll: r.lngLat, kanteId: r.kanteId, origin: r.origin }));
  return matching(text, TYPED + 3, filterFor(field, true)).filter((e) => !(e.k === 'p' && inResults(e.p))).slice(0, TYPED);
}
/** While typing: the searches of yours the text matches, marked with a clock, above the results. */
export function renderTypedHistory() {
  const field = searchState.field;
  for (const e of typedEntries(field)) list.appendChild(row(e, field, CLOCK_ICON));
}
/** Enter: the search of yours on top of the list, if there is one. Returns whether one was opened. */
export function pickTypedHistory(): boolean {
  const e = typedEntries(searchState.field)[0];
  if (!e) return false;
  open(e, searchState.field);
  return true;
}
