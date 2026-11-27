// ---- A line typed into the search ("Tram 9", "9", "Bus 12", "S1", "IC 8"), and the live vehicles of /api/vehicles
//      that are of it: what src/app/line-search.ts lists, and which of them is nearest. Nothing of the page: the tests
//      import it as it is (tools/test_vehicle_pick.mts). ----
import { KANTE_LIVE } from './live.ts';

/** A line asked for: what kind of vehicle the words said (if they did), its category letters and its number. */
export interface LineQuery {
  /** 'tram', 'bus', 'rail', 'boat' when a word said so ("Tram 9", "Bus 12", "Zug", "S-Bahn"); else null. */
  mode: 'tram' | 'bus' | 'rail' | 'boat' | null;
  /** The letters before the number, folded: 's', 'ic', 'n', ''. */
  cat: string;
  /** The number, folded, without leading zeros: '9', '12', '2e'. */
  num: string;
}
/** The vehicles of one line near where the search measures from. */
export interface LineGroup<V extends KanteVehicle = KanteVehicle> {
  key: string;
  line: KanteLine;
  vehicles: V[];
  /** Where they go, the commonest first (at most two). */
  headsigns: string[];
  /** km from where the search measures to the nearest of them. */
  nearestKm: number;
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const plain = (s: string | null | undefined) => fold(String(s || '')).replace(/[^a-z0-9]/g, '');
const noZeros = (s: string) => s.replace(/^0+(?=\d)/, '');

const MODE_WORDS: [RegExp, LineQuery['mode']][] = [
  [/^(tram|tramway|strassenbahn|trambahn)$/, 'tram'],
  [/^(bus|autobus|postauto|car|postbus)$/, 'bus'],
  [/^(train|zug|s-?bahn|bahn|treno)$/, 'rail'],
  [/^(boat|ship|schiff|bateau|battello)$/, 'boat'],
  [/^(line|linie|ligne|linea|nr|no|number|nummer)$/, null],
];
// Category letters that only say the kind of vehicle ("T9" a tram, "B12" a bus): the number is the line
const MODE_LETTERS: Record<string, LineQuery['mode']> = { t: 'tram', b: 'bus' };

/** "Tram 9" → { mode: 'tram', cat: '', num: '9' }; "S1" → { cat: 's', num: '1' }; "IC 8" → { cat: 'ic', num: '8' };
 *  "Kramgasse 9" → null. Only a whole query that is a line: a number, with at most a word and letters before it. */
export function parseLineQuery(text: string): LineQuery | null {
  const m = /^(?:([a-z-]+)\.?\s+)?([a-z]{0,4})\s*-?\s*(\d{1,4}[a-z]?)$/.exec(fold(text).trim().replace(/\s+/g, ' '));
  if (!m) return null;
  let mode: LineQuery['mode'] = null, cat = m[2];
  const word = m[1] ? MODE_WORDS.find(([re]) => re.test(m[1])) : undefined;
  if (word) mode = word[1];
  else if (m[1] && !cat && /^[a-z]{1,4}$/.test(m[1])) cat = m[1]; // "IC 8", "S 1": letters, then the number
  else if (m[1]) return null; // "Kramgasse 9": a place and a number
  // "tram9", "bus12": the word written onto the number
  const glued = !m[1] && cat ? MODE_WORDS.find(([re]) => re.test(cat)) : undefined;
  if (glued) { mode = glued[1]; cat = ''; }
  if (MODE_LETTERS[cat] && (!mode || mode === MODE_LETTERS[cat])) { mode = MODE_LETTERS[cat]; cat = ''; }
  if (!cat && !mode && m[3].length > 3) return null; // "3011": a postcode, not a line
  return { mode, cat, num: noZeros(m[3]) };
}
// "tram9" (one word): the regex above takes up to four letters as the category, so the longer words come here
function gluedWord(text: string): LineQuery | null {
  const m = /^([a-z-]{3,})(\d{1,4}[a-z]?)$/.exec(fold(text).trim());
  const w = m && MODE_WORDS.find(([re]) => re.test(m[1]));
  return m && w ? { mode: w[1], cat: '', num: noZeros(m[2]) } : null;
}
/** parseLineQuery(), also for a word written onto the number ("tram9", "linie12"). */
export const lineQuery = (text: string) => parseLineQuery(text) || gluedWord(text);

// The engine's modes as the query's
const QUERY_MODE: Partial<Record<KanteMode, LineQuery['mode']>> = { tram: 'tram', metro: 'tram', bus: 'bus', ondemand: 'bus', rail: 'rail', boat: 'boat' };

/** The line's category and number as the badges have them ("IC61" → IC, 61; "10" → '', 10). */
export function lineParts(line: Partial<KanteLine>) {
  const j = KANTE_LIVE.journeyLike(line);
  return { cat: plain(j.category), num: noZeros(plain(j.number)), name: plain(j.name) };
}
/** The line is the one asked for. */
export function lineMatches(q: LineQuery, line: KanteLine): boolean {
  if (q.mode && QUERY_MODE[line.mode] !== q.mode) return false;
  const p = lineParts(line);
  const plainCat = p.cat === '' || p.cat === 'b' || p.cat === 't' || p.cat === 'bus' || p.cat === 'tram' || p.cat === 'nfb' || p.cat === 'nft';
  // a number alone: a line called just that ("9", the tram's or the bus's), or the number with the kind of vehicle named
  if (!q.cat) return p.num === q.num && (p.name === q.num || plainCat || !!q.mode);
  return (p.cat === q.cat && p.num === q.num) || p.name === q.cat + q.num;
}
/** One line, whoever runs it: the same name of the same kind by the same operator. */
export const lineKey = (line: Partial<KanteLine>) => [line.mode || '', plain(line.category), plain(line.name), line.operator || ''].join('|');

const at = (v: KanteVehicle): LngLat => v.point || v.from;

/** The lines among `vehicles` that the query asks for, nearest first, each with its vehicles nearest first. */
export function groupLines<V extends KanteVehicle>(q: LineQuery, vehicles: V[], from: LngLat): LineGroup<V>[] {
  const groups = new Map<string, LineGroup<V>>();
  for (const v of vehicles) {
    if (!v || !v.line || !lineMatches(q, v.line)) continue;
    const k = lineKey(v.line);
    let g = groups.get(k);
    if (!g) groups.set(k, g = { key: k, line: v.line, vehicles: [], headsigns: [], nearestKm: Infinity });
    g.vehicles.push(v);
  }
  const out = [...groups.values()];
  for (const g of out) {
    const d = new Map(g.vehicles.map((v) => [v, KANTE_LIVE.distKm(from, at(v))]));
    g.vehicles.sort((a, b) => d.get(a)! - d.get(b)!);
    g.nearestKm = d.get(g.vehicles[0])!;
    const n = new Map<string, number>();
    for (const v of g.vehicles) if (v.headsign) n.set(v.headsign, (n.get(v.headsign) || 0) + 1);
    g.headsigns = [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map((x) => x[0]);
  }
  return out.sort((a, b) => a.nearestKm - b.nearestKm);
}

/** The vehicle to follow first: with your position, the nearest one coming towards you (its next stop nearer to you
 *  than the one it left, and that stop within 2 km of you), else the nearest; `coming` says which it is. */
export function nearestVehicle<V extends KanteVehicle>(vehicles: V[], you: LngLat, youKnown: boolean): { v: V; coming: boolean } | null {
  if (!vehicles.length) return null;
  const d = (v: V) => KANTE_LIVE.distKm(you, at(v));
  const byDist = [...vehicles].sort((a, b) => d(a) - d(b));
  if (youKnown) {
    const coming = byDist.find((v) => {
      // standing at a stop (from = to): the stop it leaves for next
      const standing = v.from[0] === v.to[0] && v.from[1] === v.to[1];
      const next = standing && v.onward ? v.onward.to : v.to;
      const dTo = KANTE_LIVE.distKm(you, next), dFrom = KANTE_LIVE.distKm(you, v.from);
      return dTo < dFrom - 0.02 && dTo < 2;
    });
    if (coming) return { v: coming, coming: true };
  }
  return { v: byDist[0], coming: false };
}

// ---- Where a trip's vehicle is by the engine's /api/trip answer (src/app/vehicle-follow.ts, when the live layer does
//      not draw it): its position moved on to now, placed on the trip's whole way (also before your stop). ----

/** The point of a trip's way its position (KANTE_LIVE.advance()) is at: standing at a call, or `frac` of the way from
 *  one call to the next along `path` (the straight line between their boarding points without it). null: not under way. */
export function tripPoint(trip: Pick<KanteTrip, 'calls' | 'path' | 'pathAt'>, p: { state: string; seq: number; nextSeq?: number; frac: number; from?: LngLat; to?: LngLat } | null): LngLat | null {
  if (!p || (p.state !== 'at' && p.state !== 'between')) return null;
  const idx = (seq: number | undefined) => (seq == null ? -1 : trip.calls.findIndex((c) => c.seq === seq));
  const i = idx(p.seq), c = trip.calls[i];
  const quay = (k: number): LngLat | null => (trip.calls[k] ? [trip.calls[k].quay.lon, trip.calls[k].quay.lat] : null);
  if (p.state === 'at') return (trip.path && trip.pathAt && trip.pathAt[i] != null ? trip.path[trip.pathAt[i]] : null) || (c ? quay(i) : p.from || null);
  const j = idx(p.nextSeq), f = Math.min(1, Math.max(0, Number(p.frac) || 0));
  if (trip.path && trip.pathAt && i >= 0 && j > i && trip.pathAt[i] != null && trip.pathAt[j] != null && trip.pathAt[j] > trip.pathAt[i]) {
    const pts = trip.path.slice(trip.pathAt[i], trip.pathAt[j] + 1);
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + KANTE_LIVE.distKm(pts[k - 1], pts[k]));
    const want = cum[cum.length - 1] * f;
    let k = 1;
    while (k < pts.length - 1 && cum[k] < want) k++;
    const seg = cum[k] - cum[k - 1], t = seg > 0 ? (want - cum[k - 1]) / seg : 0;
    return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t];
  }
  const a = p.from || quay(i), b = p.to || quay(j);
  return a && b ? [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] : a;
}

/** Which of a ride's legs (the trips you stay seated on) runs now: the last one that has left the stop where it begins
 *  (`starts`: those departures, ms; null where not known), else the first. */
export function legNow(starts: (number | null)[], now: number): number {
  let n = 0;
  for (let x = 1; x < starts.length; x++) { const t = starts[x]; if (t != null && now >= t) n = x; }
  return n;
}
