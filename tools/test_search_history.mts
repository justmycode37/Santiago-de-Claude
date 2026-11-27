// The search history (src/search-history.ts): what is kept, how it is ranked, and that nothing breaks without
// storage. Offline; exit code 1 on any failure.
//
//   node tools/test_search_history.mts
import * as H from '../src/search-history.ts';
import type { HistoryItem, HistoryPlace } from '../src/search-history.ts';

let passed = 0, failed = 0;
const check = (ok: unknown, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.has(k) ? this.data.get(k)! : null; }
  setItem(k: string, v: string) { this.data.set(k, String(v)); }
  removeItem(k: string) { this.data.delete(k); }
}
const fresh = () => { const s = new MemoryStorage(); H.useStorage(s); H.rememberWhen(() => true); return s; };
const DAY = 24 * 3600e3, MIN = 60e3;
const T0 = Date.UTC(2026, 10, 27, 12);
const place = (title: string, ll: [number, number], extra: Partial<HistoryPlace> = {}): HistoryPlace =>
  ({ title, sub: '', kind: 'station', origin: 'kante', ll, ...extra });
const P = (title: string, ll: [number, number], extra: Partial<HistoryPlace> = {}): HistoryItem => ({ k: 'p', p: place(title, ll, extra) });
const titles = (es: H.HistoryEntry[]) => es.map(H.entryTitle).join(', ');

console.log('recent, de-duplicated');
fresh();
H.record(P('Bern', [7.4391, 46.9488], { kanteId: 'st:8507000' }), T0);
H.record(P('Zürich HB', [8.5402, 47.3782], { kanteId: 'st:8503000' }), T0 + MIN);
H.record({ k: 'c', key: 'restaurants', label: 'Restaurants' }, T0 + 2 * MIN);
H.record(P('Bern', [7.4391, 46.9488], { kanteId: 'st:8507000' }), T0 + 3 * MIN);
check(titles(H.recent(5)) === 'Bern, Restaurants, Zürich HB', `most recent first, once each: ${titles(H.recent(5))}`);
check(H.count() === 3, 'three entries');

console.log('the same place from another source is the same entry');
fresh();
H.record(P('Zürich HB', [8.5402, 47.3782], { kanteId: 'st:8503000' }), T0);
H.record(P('Zürich HB', [8.5403, 47.3783], { origin: 'gazetteer', kind: 'station' }), T0 + DAY);
check(H.count() === 1, 'swisstopo\'s "Zürich HB" 15 m away merges into the engine\'s');
check(H.list()[0].k === 'p' && (H.list()[0] as { p: HistoryPlace }).p.kanteId === 'st:8503000', 'the engine\'s id is kept');
H.record(P('Zürich HB', [8.6, 47.4]), T0 + 2 * DAY);
check(H.count() === 2, 'the same name 5 km away is another place');
H.record(P('Bahnhof', [7.0, 46.0], { kanteId: 'st:1' }), T0);
H.record(P('Bahnhof', [7.0, 46.0], { kanteId: 'st:2' }), T0);
check(H.count() === 4, 'two stations with different ids stay two, even with the same name and place');
H.record(P('Bahnhofstrasse 1', [8.0, 47.0], { origin: 'address', kind: 'address' }), T0);
H.record(P('Bahnhofstrasse 1', [8.0005, 47.0], { origin: 'address', kind: 'address' }), T0);
check(H.count() === 6, 'addresses merge only within 30 m (these are 38 m apart)');

console.log('a trip keeps the ids of its stations when picked again from a source without them');
fresh();
H.record({ k: 'j', from: place('Bern', [7.4391, 46.9488], { kanteId: 'st:8507000' }), to: place('Thun', [7.6296, 46.7548], { kanteId: 'st:8507100' }) }, T0);
H.record({ k: 'j', from: place('Bern', [7.4391, 46.9488], { origin: 'gazetteer' }), to: place('Thun', [7.6297, 46.7549], { origin: 'gazetteer' }) }, T0 + DAY);
const trip = H.list()[0] as Extract<H.HistoryEntry, { k: 'j' }>;
check(H.count() === 1 && trip.from.kanteId === 'st:8507000' && trip.to.kanteId === 'st:8507100', 'one trip, both ids kept');

console.log('frequent: used more than once lately, fading');
fresh();
H.record(P('Home', [7.45, 46.95]), T0);
H.record(P('Home', [7.45, 46.95]), T0 + 5 * MIN);
check(H.frequent(3, [], undefined, T0 + 6 * MIN).length === 0, 'twice within a quarter of an hour counts once');
{
  fresh();
  H.record(P('Busy', [7.5, 47]), T0);
  for (let i = 1; i <= 30 * 24 * 6; i++) H.record(P('Busy', [7.5, 47]), T0 + i * 10 * MIN); // every 10 minutes for 30 days
  const busy = H.list()[0];
  check(Math.abs(busy.s - 0.5) < 0.01, `picked again and again within a quarter of an hour: still one use, fading (${busy.s.toFixed(3)})`);
}
fresh();
H.record(P('Home', [7.45, 46.95]), T0);
H.record(P('Home', [7.45, 46.95]), T0 + 5 * MIN);
H.record(P('Home', [7.45, 46.95]), T0 + DAY);
H.record(P('Work', [7.43, 46.94]), T0 + DAY + MIN);
H.record(P('Work', [7.43, 46.94]), T0 + 2 * DAY);
H.record(P('Work', [7.43, 46.94]), T0 + 3 * DAY);
H.record(P('Once', [7.40, 46.90]), T0 + 3 * DAY + MIN);
const now = T0 + 3 * DAY + 2 * MIN;
check(titles(H.frequent(3, [], undefined, now)) === 'Work, Home', `ranked by uses: ${titles(H.frequent(3, [], undefined, now))}`);
check(titles(H.frequent(3, H.recent(1), undefined, now)) === 'Work, Home', 'leaves out what Recent shows ("Once")');
check(titles(H.frequent(3, H.recent(2), undefined, now)) === 'Home', '…and Work when Recent shows it');
const later = now + 25 * DAY;
check(titles(H.frequent(3, [], undefined, later)) === 'Work', `25 days on, two uses have faded, three not yet: ${titles(H.frequent(3, [], undefined, later))}`);
check(H.frequent(3, [], undefined, now + 90 * DAY).length === 0, '90 days on, nothing is frequent');
const work = H.list().find((e) => H.entryTitle(e) === 'Work')!;
check(Math.abs(H.score(work, work.t + H.HALF_LIFE_MS) - work.s / 2) < 1e-9, 'a use counts half after the half-life');
check(H.score(work, work.t - DAY) === work.s, 'a clock set back does not raise the score');

console.log('the cap keeps the newest');
fresh();
for (let i = 0; i < H.MAX_ENTRIES; i++) for (let j = 0; j < 3; j++) H.record(P(`Fav ${i}`, [7 + i / 100, 46]), T0 + j * DAY + i * MIN);
check(H.count() === H.MAX_ENTRIES, `${H.MAX_ENTRIES} entries`);
const t1 = T0 + 4 * DAY;
for (let i = 0; i < 5; i++) H.record(P(`New ${i}`, [8 + i / 100, 47]), t1 + i * MIN);
check(H.count() === H.MAX_ENTRIES, 'still at the cap');
check(titles(H.recent(5)) === 'New 4, New 3, New 2, New 1, New 0', `five new searches in a row all stay: ${titles(H.recent(5))}`);
check(!H.list().some((e) => H.entryTitle(e) === 'Fav 0'), 'the least used favourite went');

console.log('typed text');
fresh();
H.record(P('Zürich HB', [8.5402, 47.3782]), T0);
H.record(P('Bern Wankdorf', [7.4648, 46.9681]), T0 + MIN);
H.record({ k: 'j', from: place('Bern', [7.4391, 46.9488]), to: place('Zürich HB', [8.5402, 47.3782]) }, T0 + 2 * MIN);
check(titles(H.matching('zur', 5)) === 'Bern → Zürich HB, Zürich HB', `"zur" (no accent): ${titles(H.matching('zur', 5))}`);
check(titles(H.matching('wank bern', 5)) === 'Bern Wankdorf', 'every word, any order');
check(H.matching('xyz', 5).length === 0 && H.matching('  ', 5).length === 0, 'nothing for no match or blank');
check(titles(H.matching('zur', 5, (e) => e.k === 'p')) === 'Zürich HB', 'the filter (places only, for where you start)');

console.log('what is stored');
const s = fresh();
H.record(P('Café Kramgasse', [7.451234567, 46.947654321], { origin: 'place', kind: 'cafe', sub: 'Café · 120 m · ★ 4.5 · Open · Kramgasse 12' }), T0);
const stored = JSON.parse(s.getItem(H.SEARCH_HISTORY.KEY)!);
const sp = stored.items[0].p;
check(sp.sub === 'Café · Kramgasse 12', `no distance, rating or open now: "${sp.sub}"`);
check(sp.ll[0] === 7.45123 && sp.ll[1] === 46.94765, 'coordinates to about a metre');
check(Object.keys(stored.items[0]).sort().join() === 'id,k,p,s,t' && Object.keys(sp).sort().join() === 'kind,ll,origin,sub,title', 'nothing else (no icon, no photo)');
check(!H.record(P('Dropped pin', [7, 46], { origin: 'pin' }), T0), 'a pin is not a search');
check(!H.record({ k: 'j', from: place('Bern', [7.4391, 46.9488]), to: place('Bern', [7.4392, 46.9488]) }, T0), 'a trip from a place to itself is not kept');
check(H.stableSubtitle('Restaurant, italian · 1.2 km · Closed') === 'Restaurant, italian', 'km and Closed go too');

console.log('stored data that is not right');
const bad = fresh();
bad.setItem(H.SEARCH_HISTORY.KEY, JSON.stringify({ v: 1, items: [
  { id: 'a', t: T0, s: 1, k: 'p', p: { title: 'Good', sub: '', kind: 'cafe', origin: 'place', ll: [7, 46] } },
  { id: 'b', t: T0, s: 1, k: 'p', p: { title: 'Bad kind', sub: '', kind: '<img src=x onerror=alert(1)>', origin: 'place', ll: [7, 46] } },
  { id: 'c', t: T0, s: 1, k: 'p', p: { title: 'No coords', sub: '', kind: 'cafe', origin: 'place', ll: [7] } },
  { id: 'd', t: T0, s: Infinity, k: 'c', key: 'bars', label: 'Bars' },
  { id: 'e', t: 'x', s: 1, k: 'c', key: 'bars', label: 'Bars' },
  { id: 'f', t: T0, s: 1, k: 'zzz' },
  { id: 'a', t: T0, s: 1, k: 'c', key: 'dup', label: 'Same id' },
  null, 7,
] }));
check(titles(H.list()) === 'Good', `only the good entry is read: ${titles(H.list())}`);
bad.setItem(H.SEARCH_HISTORY.KEY, '{not json');
check(H.list().length === 0 && H.record(P('After', [7, 46]), T0) && H.count() === 1, 'unreadable data: empty, and written anew');

console.log('the switch');
fresh();
H.rememberWhen(() => false);
check(!H.record(P('Secret', [7, 46]), T0) && H.count() === 0, 'off: nothing is kept');
H.rememberWhen(() => true);
H.record(P('Kept', [7, 46]), T0);
H.rememberWhen(() => false);
check(H.recent(5).length === 0 && H.frequent(5).length === 0 && H.matching('kept', 5).length === 0, 'off: nothing is shown');
check(H.count() === 1, '…but it is still there to be cleared');
check(H.clear() && H.count() === 0, 'cleared');
H.rememberWhen(() => true);

console.log('remove');
fresh();
H.record(P('One', [7, 46]), T0);
H.record(P('Two', [7.1, 46]), T0 + MIN);
check(H.remove(H.recent(5)[1].id) && titles(H.recent(5)) === 'Two', 'one entry forgotten');

console.log('storage blocked');
H.useStorage(null);
check(!H.record(P('X', [7, 46]), T0) && H.recent(5).length === 0 && H.count() === 0, 'no storage: nothing kept, nothing thrown');
const throwing = { getItem(): string { throw new Error('SecurityError'); }, setItem(): void { throw new Error('QuotaExceeded'); }, removeItem(): void { throw new Error('SecurityError'); } };
H.useStorage(throwing);
check(!H.record(P('X', [7, 46]), T0) && H.list().length === 0 && !H.clear() && H.frequent(3).length === 0, 'storage that throws: false and empty, nothing thrown');
H.useStorage(undefined);
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
check(H.list().length === 0 && !H.record(P('X', [7, 46]), T0), 'a localStorage getter that throws (sandboxed frame)');
delete (globalThis as { localStorage?: unknown }).localStorage;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
