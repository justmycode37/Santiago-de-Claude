// What you searched for, kept on this device only (localStorage): the places you picked, the categories you opened
// and the trips you planned between two places you picked. The empty search box lists them as "Recent" and
// "Frequent" (src/app/search-history-ui.ts). Whether anything is kept is the settings' switch; settings.ts hands it
// over (rememberWhen) as it starts. This module does nothing as it loads and touches no part of the page.
// docs/search-history.md has the rules.

/** The little a place needs to be shown and opened again. */
export interface HistoryPlace {
  title: string;
  /** The grey line, without what changes (distance, rating, open now). */
  sub: string;
  /** Which icon (a key of KIND in src/app/search.ts); an unknown one gets the plain pin. */
  kind: string;
  /** Where the result came from ('address', 'gazetteer', 'zipcode', 'gg25', 'kante', 'place'). */
  origin: string;
  ll: [lng: number, lat: number];
  /** The Kante engine's id ('st:…' a station): a station is planned to as the station. */
  kanteId?: string;
}
/** A category of the search ("Restaurants"): its key, its name, and for one typed by name ("dentist") the words. */
export interface HistoryCategory { key: string; label: string; query?: string }
/** What is recorded: a place, a category, or a trip between two places. */
export type HistoryItem =
  | { k: 'p'; p: HistoryPlace }
  | ({ k: 'c' } & HistoryCategory)
  | { k: 'j'; from: HistoryPlace; to: HistoryPlace };
/** A kept entry: what it is, when it was last used (ms) and how much it is used (uses, fading with time). */
export type HistoryEntry = HistoryItem & { id: string; t: number; s: number };
export type HistoryKind = HistoryItem['k'];

/** The part of localStorage used here (the tests hand in their own). */
interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const KEY = 'search-history-v1';
/** At most this many entries are kept. */
export const MAX_ENTRIES = 40;
/** The newest this many are never pushed out by older, much-used ones. */
const KEEP_NEWEST = 8;
/** A use counts half as much after this long. */
export const HALF_LIFE_MS = 30 * 24 * 3600e3;
/** Picking the same thing again within this time does not count as another use (only makes it recent). */
const REPEAT_MS = 15 * 60e3;
/** "Frequent" needs more than one use not long ago: two uses fall below this after 12 days, three after 30. */
export const FREQUENT_MIN = 1.5;
const ORIGINS = ['address', 'gazetteer', 'zipcode', 'gg25', 'kante', 'place'];
const MAX_TEXT = 160;

let enabled: () => boolean | undefined = () => true;
/** settings.ts: on() says whether searches are remembered now (its "Remember searches" switch). */
export function rememberWhen(on: () => boolean | undefined) { enabled = on; }
export const isOn = () => enabled() !== false;

let storageOverride: StorageLike | null | undefined;
/** Tests: use this storage instead of the browser's (null: none at all, as when it is blocked). */
export function useStorage(s: StorageLike | null | undefined) { storageOverride = s; }
function storage(): StorageLike | null {
  if (storageOverride !== undefined) return storageOverride;
  try { return (globalThis as { localStorage?: StorageLike }).localStorage ?? null; } catch { return null; } // a sandbox can throw on the getter
}

// ---- Places: the same place from two sources is one entry ----
export const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();
const metres = (a: readonly number[], b: readonly number[]) => Math.hypot((a[0] - b[0]) * 76000, (a[1] - b[1]) * 111000);
/** The same place: the same engine id, or (when one of them has none) the same name within 150 m (an address: 30 m). */
export function samePlace(a: { title: string; ll: readonly number[]; kanteId?: string; origin?: string },
  b: { title: string; ll: readonly number[]; kanteId?: string; origin?: string }) {
  if (a.kanteId && b.kanteId) return a.kanteId === b.kanteId;
  return fold(a.title) === fold(b.title) && metres(a.ll, b.ll) < (a.origin === 'address' || b.origin === 'address' ? 30 : 150);
}
const sameItem = (a: HistoryItem, b: HistoryItem) => a.k === 'p' ? b.k === 'p' && samePlace(a.p, b.p)
  : a.k === 'c' ? b.k === 'c' && a.key === b.key
  : b.k === 'j' && samePlace(a.from, b.from) && samePlace(a.to, b.to);

/** The grey line without what was true only then and there: "Café · 120 m · ★ 4.5 · Open · Kramgasse 12" → "Café · Kramgasse 12". */
export function stableSubtitle(sub: string) {
  return sub.split(' · ').map((x) => x.trim())
    .filter((x) => x && !/^\d+(?:[.,]\d+)?\s?k?m$/i.test(x) && !/^★/.test(x) && !/^(open|closed)(\s+now)?$/i.test(x)).join(' · ');
}

// ---- Reading and writing: every value checked, what is not right left out ----
const text = (v: unknown, max = MAX_TEXT): string | null => typeof v === 'string' && v.length <= max ? v : null;
function cleanPlace(v: unknown): HistoryPlace | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const title = text(o.title), sub = text(o.sub) ?? '', kind = text(o.kind, 20), origin = text(o.origin, 20);
  const ll = o.ll as unknown[];
  if (!title || !title.trim() || !kind || !/^[a-z]+$/.test(kind) || !origin || !ORIGINS.includes(origin)) return null;
  if (!Array.isArray(ll) || ll.length !== 2 || !ll.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const [lng, lat] = ll as number[];
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
  const p: HistoryPlace = { title, sub, kind, origin, ll: [lng, lat] };
  const kanteId = text(o.kanteId, 80);
  if (kanteId) p.kanteId = kanteId;
  return p;
}
function cleanItem(v: unknown): HistoryItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.k === 'p') { const p = cleanPlace(o.p); return p && { k: 'p', p }; }
  if (o.k === 'c') {
    const key = text(o.key, 80), label = text(o.label), query = text(o.query);
    if (!key || !label || !label.trim()) return null;
    return query ? { k: 'c', key, label, query } : { k: 'c', key, label };
  }
  if (o.k === 'j') {
    const from = cleanPlace(o.from), to = cleanPlace(o.to);
    return from && to && !samePlace(from, to) ? { k: 'j', from, to } : null;
  }
  return null;
}
function cleanEntry(v: unknown): HistoryEntry | null {
  const item = cleanItem(v);
  if (!item) return null;
  const o = v as Record<string, unknown>;
  const id = text(o.id, 40), t = o.t, s = o.s;
  if (!id || typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return null;
  return { ...item, id, t, s: Math.min(s, 1000) };
}

/** Every kept entry, newest first; [] when storage is blocked or holds something else. */
export function list(): HistoryEntry[] {
  try {
    const raw = storage()?.getItem(KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (!saved || !Array.isArray(saved.items)) return [];
    const ids = new Set<string>();
    const out: HistoryEntry[] = [];
    for (const v of saved.items) {
      const e = cleanEntry(v);
      if (e && !ids.has(e.id)) { ids.add(e.id); out.push(e); }
    }
    return out.sort((a, b) => b.t - a.t);
  } catch { return []; }
}
function save(items: HistoryEntry[]) {
  try {
    const s = storage();
    if (!s) return false;
    if (items.length) s.setItem(KEY, JSON.stringify({ v: 1, items }));
    else s.removeItem(KEY);
    return true;
  } catch { return false; } // full or blocked: the history stays as it was
}

// ---- Ranking ----
/** How much an entry is used now: its uses, each counting half as much every HALF_LIFE_MS. */
export const score = (e: HistoryEntry, now = Date.now()) => e.s * 0.5 ** (Math.max(0, now - e.t) / HALF_LIFE_MS);

const keepId = (p: HistoryPlace, old: HistoryPlace): HistoryPlace => (!p.kanteId && old.kanteId ? { ...p, kanteId: old.kanteId } : p);
const round = (p: HistoryPlace): HistoryPlace => ({ ...p, sub: stableSubtitle(p.sub), ll: [+p.ll[0].toFixed(5), +p.ll[1].toFixed(5)] });
let seq = 0;
const newId = (now: number) => `${now.toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}`;

/**
 * One more use of `item` (a place picked, a category opened, a trip planned): it becomes the most recent, and counts
 * once more unless it was used a moment ago. Nothing is kept while the switch is off. Returns whether it was saved.
 */
export function record(item: HistoryItem, now = Date.now()): boolean {
  if (!isOn()) return false;
  const clean = cleanItem(item.k === 'p' ? { k: 'p', p: round(item.p) } : item.k === 'j' ? { k: 'j', from: round(item.from), to: round(item.to) } : item);
  if (!clean) return false;
  const items = list();
  const i = items.findIndex((e) => sameItem(e, clean));
  let entry: HistoryEntry;
  if (i >= 0) {
    const old = items.splice(i, 1)[0];
    // what it is now (a newer name), keeping the engine's id when this source has none; used once more, unless a
    // moment ago (then only recent, its score fading on as before)
    const merged: HistoryItem = clean.k === 'p' && old.k === 'p' ? { k: 'p', p: keepId(clean.p, old.p) }
      : clean.k === 'j' && old.k === 'j' ? { k: 'j', from: keepId(clean.from, old.from), to: keepId(clean.to, old.to) } : clean;
    entry = { ...merged, id: old.id, t: Math.max(now, old.t), s: score(old, now) + (now - old.t < REPEAT_MS ? 0 : 1) };
  } else entry = { ...clean, id: newId(now), t: now, s: 1 };
  items.unshift(entry);
  // too many: the least used go, never the newest few
  while (items.length > MAX_ENTRIES) {
    let worst = -1;
    for (let j = KEEP_NEWEST; j < items.length; j++) if (worst < 0 || score(items[j], now) <= score(items[worst], now)) worst = j;
    items.splice(worst, 1);
  }
  return save(items);
}

/** Which entries a field offers: where the trip starts takes only places; where it goes, all (or what `kinds` says). */
export type HistoryFilter = (e: HistoryEntry) => boolean;
const all: HistoryFilter = () => true;

/** The `n` most recent entries (while the switch is on). */
export function recent(n: number, filter: HistoryFilter = all): HistoryEntry[] {
  return isOn() ? list().filter(filter).slice(0, n) : [];
}
/** The `n` most used entries that are used more than once lately, leaving out those already shown (`except`). */
export function frequent(n: number, except: HistoryEntry[] = [], filter: HistoryFilter = all, now = Date.now()): HistoryEntry[] {
  if (!isOn()) return [];
  const skip = new Set(except.map((e) => e.id));
  return list().filter((e) => filter(e) && !skip.has(e.id) && score(e, now) >= FREQUENT_MIN)
    .sort((a, b) => score(b, now) - score(a, now) || b.t - a.t).slice(0, n);
}
/** What an entry is called, as typed text is matched against it. */
export const entryTitle = (e: HistoryItem) => e.k === 'p' ? e.p.title : e.k === 'c' ? e.label : `${e.from.title} → ${e.to.title}`;
/** Entries whose name has every typed word at the start of one of its words ("zur hb", "hb" → "Zürich HB"), most used first. */
export function matching(typed: string, n: number, filter: HistoryFilter = all, now = Date.now()): HistoryEntry[] {
  if (!isOn()) return [];
  const words = fold(typed).split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return [];
  return list().filter((e) => {
    if (!filter(e)) return false;
    const tw = fold(entryTitle(e)).split(/[^a-z0-9]+/).filter(Boolean);
    return words.every((w) => tw.some((t) => t.startsWith(w)));
  }).sort((a, b) => score(b, now) - score(a, now) || b.t - a.t).slice(0, n);
}
/** Forgets one entry. Returns whether that could be saved. */
export function remove(id: string): boolean {
  const items = list();
  const left = items.filter((e) => e.id !== id);
  return left.length === items.length || save(left);
}
/** Forgets everything. Returns whether that could be saved. */
export function clear(): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.removeItem(KEY);
    return true;
  } catch { return false; }
}
/** How many entries are kept (also while the switch is off: Settings offers to clear them). */
export const count = () => list().length;

export const SEARCH_HISTORY = { KEY, record, recent, frequent, matching, remove, clear, count, list, rememberWhen, isOn };
