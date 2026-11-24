// The train you are walking to, as the station view shows it: its coaches in order, the sectors of the platform each
// one stops in, their class, and how full the forecast says the train will be. docs/train-formation.md
//
//   loadTrain(train, engine) → Promise<TrainShown>: never rejects; what could not be had is left out (coaches null,
//     crowd null). engine: the Kante client (KANTE in engine.ts; passed in so this module loads anywhere, the tests too)
//   parseFormation(json, uic, toUic?) → TrainCoach[] | null     (pure: the tests feed it made-up answers)
//   coachesFor(coaches, cls, wheelchair) → { picks, missing }  where to get on, or why nothing is recommended
//   evuOf(operator) → 'SBBP' | 'BLSP' | … | null          the railway's code in the Train Formation Service
//   sectorList("A-D") → ['A', 'B', 'C', 'D']
//
// Sources, all open data:
//   - the coaches: the Train Formation Service of opentransportdata.swiss (formation/v2/formations_full). It needs a
//     key, so the app asks the Kante engine (GET /api/formation, which holds the key: kante/engine/crates/server/src/
//     formation.rs), or the service itself when config.js has a `formationKey` (for a test on your own machine).
//   - how full: the occupancy forecast (SBB, BLS, SOB, Thurbo, zb) per class, as transport.opendata.ch's station board
//     passes it on (capacity1st / capacity2nd: 1 low, 2 medium, 3 high). It is one figure per class for the train
//     from this stop to the next, not per coach: no open source has coach-level occupancy.
//   - without a formation: the sectors the timetable gives the train at this platform ("7A-D"), so the view can at
//     least show where it stops.

import type { StationRouteEndpoint } from './station-route.ts';

/** What is needed of the engine's client (KANTE, engine.ts). */
export interface TrainEngine { base: string; href(path: string, params?: Record<string, string>): string }

/** One end of a ride: the stop, its platform, the station model it is in, and the walk that comes before (at the
 *  boarding end: where it starts) or after (at the alighting end: where it goes). */
export interface RideEnd {
  uic: string;
  /** The platform or stop edge: "7", "H"; the sectors the timetable gives the vehicle there: "A-D", "AB", ''. */
  ref: string;
  sectors: string;
  name: string;
  /** The station model it is in (Station3D.has), or null. */
  key: string | null;
  /** The other end of the walk at this stop (a station router endpoint), or null when it is not in the model. */
  walk: StationRouteEndpoint | null;
  /** The stop's position, and the compass direction the vehicle travels in there (degrees; null if not known). */
  ll: LngLat | null;
  heading: number | null;
  /** The ride before (at the boarding end of a change) whose coach you get off: the walk starts at its door. */
  via?: Station3DTrain | null;
}
/** A ride as the 3D view shows it: the vehicle at the end `role` (board: the walk leads to it; alight: the walk starts
 *  from it), with both ends so that the coach is chosen once for the whole ride (coach-plan.ts). */
export interface Station3DTrain {
  /** The trip and its day, and the boarding stop: the same ride whichever end is shown. */
  id: string;
  mode: 'train' | 'tram' | 'bus' | 'other';
  role: 'board' | 'alight';
  board: RideEnd;
  alight: RideEnd;
  /** You stay on one trip from end to end (the formation's coaches are the same at both): the coach is chosen over
   *  both ends. False when you stay seated across trips (another train number on the way). */
  through: boolean;
  /** Trains in a row with this one (changes from train to train), in order, this one among them (each at its
   *  boarding end): their coaches are chosen together (coach-plan.ts). Null or one: this ride alone. */
  chain?: Station3DTrain[] | null;
  /** The train number at the end shown, "1083". */
  number: string;
  /** "Schweizerische Bundesbahnen SBB", "BLS AG (bls)" (the timetable's operator name). */
  operator: string;
  /** "IC", "S". */
  category: string;
  /** "IC8", "S31". */
  line: string;
  headsign: string;
  /** The operating day, "2026-11-24". */
  date: string;
  /** When it leaves the boarding stop (unix seconds, as timetabled), and the delay the live data has there. */
  dep: number | null;
  delayS?: number | null;
  /** The end shown: its station (UIC), platform and the timetable's sectors there (= board or alight's). */
  uic: string;
  ref: string;
  sectors: string;
  /** Where you get off (UIC, name): a train that splits on the way is boarded in the part that stops there. */
  toUic?: string;
  toName?: string;
}
/** The end of the ride the view shows. */
export const endOf = (t: Station3DTrain): RideEnd => (t.role === 'board' ? t.board : t.alight);
/** 1: few people, 2: some, 3: many (the forecast's own three levels). */
export type TrainCrowd = 1 | 2 | 3;
export type TrainCoachKind = 'coach' | 'loco' | 'restaurant' | 'sleeper' | 'luggage' | 'other';
export interface TrainCoach {
  /** Its place in the train (1 = the first in the formation's order; locomotives count). */
  pos: number;
  /** The number on the coach (seat reservations); null when it has none. */
  number: number | null;
  /** The platform's sectors it stands in at this stop. */
  sectors: string[];
  /** 1, 2, 12 (both), or null (no seats: a locomotive, a luggage van). */
  cls: 1 | 2 | 12 | null;
  kind: TrainCoachKind;
  /** Metres. */
  len: number;
  closed: boolean;
  /** Its class limits are lifted today (a 1st class coach anyone may use). */
  declassed: boolean;
  wheelchair: boolean;
  bike: boolean;
  stroller: boolean;
  family: boolean;
  business: boolean;
  lowFloor: boolean;
  /** The same vehicle at every stop: its European vehicle number, else its place in the train ("pos:4"). */
  id: string;
  /** Where this part of the train goes, when the train is split on the way (else null). */
  goesTo: string | null;
  /** It stops where you get off (true / false); null: not known (no stop given, or the formation does not say). */
  reaches: boolean | null;
}
export interface TrainShown {
  train: Station3DTrain;
  /** In the order of the formation (pos), or null: no formation for this train. */
  coaches: TrainCoach[] | null;
  /** The platform's sectors the train stands in: from the formation, else the timetable's. */
  sectors: string[];
  crowd: { first: TrainCrowd | null; second: TrainCrowd | null } | null;
  /** Why there are no coaches: 'nokey' (no source has a key), 'none' (no formation for this train), 'failed',
   *  'operator' (a railway the service does not have), 'unplaced' (listed, but not where they stop here). */
  missing?: 'nokey' | 'none' | 'failed' | 'operator' | 'unplaced';
}

// ------------------------------------------------------------------ the railway
const EVU: [RegExp, string][] = [
  [/[ÖO]BB\b|sterreichische Bundesbahnen/i, 'OeBB'],   // before SBB: "Bundesbahnen" is in both names
  [/\bSBB\b|Schweizerische Bundesbahnen|\bCFF\b|\bFFS\b/i, 'SBBP'],
  [/\bBLS\b/i, 'BLSP'],
  [/S[üu]dostbahn|\bSOB\b/i, 'SOB'],
  [/thurbo/i, 'THURBO'],
  [/Rh[äa]tische|\bRhB\b/i, 'RhB'],
  [/Zentralbahn|\bzb\b/i, 'ZB'],
  [/\bTPF\b|fribourgeois/i, 'TPF'],
  [/\bTRN\b|transN/i, 'TRN'],
  [/\bMBC\b|Morges-Bi[èe]re/i, 'MBC'],
  [/\bSZU\b|Sihltal/i, 'SZU'],
  [/\bVDBB\b|Dolderbahn/i, 'VDBB'],
];
export const evuOf = (operator: string | null | undefined): string | null => {
  for (const [re, code] of EVU) if (re.test(operator || '')) return code;
  return null;
};

/** "A-D" (or "D-A") → A, B, C, D; "AB" / "B,A" → A, B; '' → []. Sorted. */
export function sectorList(s: string | null | undefined): string[] {
  const t = String(s || '').toUpperCase().replace(/\s+/g, '');
  if (!t || t === 'N/A') return [];
  const out: string[] = [];
  for (const part of t.split(',')) {
    const m = /^([A-Z])[-–]([A-Z])$/.exec(part);
    if (m) {
      const a = Math.min(m[1].charCodeAt(0), m[2].charCodeAt(0)), b = Math.max(m[1].charCodeAt(0), m[2].charCodeAt(0));
      for (let c = a; c <= b; c++) out.push(String.fromCharCode(c));
      continue;
    }
    for (const ch of part) if (/[A-Z]/.test(ch)) out.push(ch);
  }
  return [...new Set(out)].sort();
}

// ------------------------------------------------------------------ the formation's answer
// The parts of formations_full (v2) read here (its OpenAPI description, openTdataCH/api-explorer).
interface FStop { uic?: number | string; name?: string }
interface FVehicleAt { stopPoint?: FStop; sectors?: string; track?: string }
interface FVehicle {
  position?: number;
  number?: number | null;
  vehicleIdentifier?: { typeCodeName?: string; evn?: string };
  formationVehicleAtScheduledStops?: FVehicleAt[];
  vehicleProperties?: {
    fromStop?: FStop; toStop?: FStop;
    length?: number; number1class?: number; number2class?: number; numberRestaurantSpace?: number; numberBeds?: number;
    bikePlatform?: boolean; numberBikeHooks?: number; lowFloorTrolley?: boolean; closed?: boolean; trolleyStatus?: string;
    accessibilityProperties?: { numberWheelchairSpaces?: number };
    pictoProperties?: { wheelchairPicto?: boolean; bikePicto?: boolean; strollerPicto?: boolean; familyZonePicto?: boolean; businessZonePicto?: boolean };
  };
}
interface FAtStop {
  scheduledStop?: { stopPoint?: FStop; stopType?: string };
  formationShort?: { formationShortString?: string; vehicleGoals?: { fromVehicleAtPosition?: number; toVehicleAtPosition?: number; destinationStopPoint?: FStop }[] };
}
export interface FormationAnswer {
  trainMetaInformation?: { runs?: string };
  formationsAtScheduledStops?: FAtStop[];
  formations?: { formationVehicles?: FVehicle[] }[];
}

const LOCO = /^(Re|Ae|Ee|Am|Bm|Tm|Aem|Eem|Rem|Be|Ge|HGe|Gem)[\s_\d]/i;
function kindOf(v: FVehicle): TrainCoachKind {
  const p = v.vehicleProperties || {}, name = (v.vehicleIdentifier && v.vehicleIdentifier.typeCodeName) || '';
  const seats = (p.number1class || 0) + (p.number2class || 0);
  if ((p.numberRestaurantSpace || 0) > 0 && (p.numberRestaurantSpace || 0) >= seats) return 'restaurant';   // a dining car (some seats in it or not)
  if ((p.numberBeds || 0) > 0) return 'sleeper';
  if (seats > 0) return 'coach';
  if (LOCO.test(name + ' ')) return 'loco';
  return /^D/.test(name) ? 'luggage' : 'other';
}

/** The coaches standing at stop `uic`, in the formation's order; null when the formation does not have this stop. */
export function parseFormation(json: FormationAnswer | null | undefined, uic: string | number, toUic?: string | number | null, arriving = false): TrainCoach[] | null {
  if (!json || !Array.isArray(json.formations)) return null;
  const here = (s: FStop | undefined) => !!s && String(s.uic) === String(uic);
  const there = (s: FStop | undefined) => toUic != null && !!s && String(s.uic) === String(toUic);
  // a train that splits: where each part goes, by position (only when there is more than one goal)
  const stop = (json.formationsAtScheduledStops || []).find((f) => f.scheduledStop && here(f.scheduledStop.stopPoint));
  const goals = (stop && stop.formationShort && stop.formationShort.vehicleGoals) || [];
  const goalOf = (pos: number) => {
    if (goals.length < 2) return null;
    const g = goals.find((x) => (x.fromVehicleAtPosition || 0) <= pos && pos <= (x.toVehicleAtPosition || 0));
    return (g && g.destinationStopPoint && g.destinationStopPoint.name) || null;
  };
  // Every formation lists the vehicles of one part of the journey. Where the train is put together anew (it turns,
  // coaches are added or left), a vehicle can be in the formation arriving and in the one leaving: the one leaving
  // counts, and a vehicle whose run ends here (toStop) is not boarded here.
  const cands: { v: FVehicle; at: FVehicleAt; ends: boolean; starts: boolean }[] = [];
  for (const f of json.formations) {
    for (const v of f.formationVehicles || []) {
      const at = (v.formationVehicleAtScheduledStops || []).find((s) => here(s.stopPoint));
      if (!at) continue;
      const p = v.vehicleProperties || {};
      cands.push({ v, at, ends: here(p.toStop), starts: here(p.fromStop) });
    }
  }
  // where you get off (arriving), the other way round: the coaches arriving count, not those that start here
  const leaving = arriving ? (cands.some((c) => !c.starts) ? cands.filter((c) => !c.starts) : cands)
    : cands.some((c) => !c.ends) ? cands.filter((c) => !c.ends) : cands;
  leaving.sort((a, b) => arriving ? Number(b.ends) - Number(a.ends) : Number(b.starts) - Number(a.starts));
  const seen = new Set<string>(), out: TrainCoach[] = [];
  for (const { v, at } of leaving) {
    {
      const pos = v.position || 0;
      const evn = v.vehicleIdentifier && v.vehicleIdentifier.evn;
      const id = evn ? 'evn|' + evn : 'pos|' + pos;
      if (seen.has(id)) continue;
      seen.add(id);
      const p = v.vehicleProperties || {}, pic = p.pictoProperties || {}, acc = p.accessibilityProperties || {};
      const kind = kindOf(v);
      const c1 = (p.number1class || 0) > 0, c2 = (p.number2class || 0) > 0;
      const status = p.trolleyStatus || 'Normal';
      out.push({
        pos, number: v.number ? v.number : null, id: evn ? evn : 'pos:' + pos,
        sectors: sectorList(at.sectors),
        cls: c1 && c2 ? 12 : c1 ? 1 : c2 ? 2 : null,
        kind,
        len: p.length && p.length > 8 && p.length < 40 ? p.length : kind === 'loco' ? 18.5 : 26.5,
        closed: !!p.closed || /^Geschlossen/.test(status),
        declassed: /Deklassiert/.test(status),
        wheelchair: !!pic.wheelchairPicto || (acc.numberWheelchairSpaces || 0) > 0,
        bike: !!pic.bikePicto || !!p.bikePlatform || (p.numberBikeHooks || 0) > 0,
        stroller: !!pic.strollerPicto,
        family: !!pic.familyZonePicto,
        business: !!pic.businessZonePicto,
        lowFloor: !!p.lowFloorTrolley,
        goesTo: goalOf(pos),
        reaches: toUic == null ? null : (v.formationVehicleAtScheduledStops || []).some((s) => there(s.stopPoint)),
      });
    }
  }
  if (!out.length) return null;
  // a formation that lists its coaches only where it starts and ends (no detail per stop) says nothing about where
  // you get off: not known, rather than "no coach stops there"
  if (toUic != null && !out.some((c) => c.reaches)) out.forEach((c) => { c.reaches = null; });
  return out.sort((a, b) => a.pos - b.pos);
}

// ------------------------------------------------------------------ fetching
const TIMEOUT_MS = 8000;
async function getJson(url: string, headers?: Record<string, string>): Promise<{ status: number; json: unknown }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    let json: unknown = null;
    try { json = await r.json(); } catch (e) { /* an empty or broken answer */ }
    return { status: r.status, json };
  } finally { clearTimeout(t); }
}
const FORMATION_URL = 'https://api.opentransportdata.swiss/formation/v2/formations_full';
/** The answer of the formation service, by way of the engine (or config.js's own key). */
async function formationOf(engine: TrainEngine, evu: string, date: string, number: string): Promise<{ json: FormationAnswer | null; missing?: TrainShown['missing'] }> {
  const params = { evu, operationDate: date, trainNumber: number };
  const cfg = (globalThis as { APP_CONFIG?: { formationKey?: string } }).APP_CONFIG;
  const key = cfg && cfg.formationKey;
  let r: { status: number; json: unknown };
  if (key) r = await getJson(FORMATION_URL + '?' + new URLSearchParams(params), { Authorization: 'Bearer ' + key, Accept: 'application/json' });
  else if (engine.base) r = await getJson(engine.href('/api/formation', { evu, date, train: number }));
  else return { json: null, missing: 'nokey' };
  if (r.status === 200 && r.json && typeof r.json === 'object') return { json: r.json as FormationAnswer };
  // 503: no key on the engine (or one it refused); 404 from an engine without the endpoint is the same to us
  if (r.status === 503 || (r.status === 404 && !(r.json && typeof r.json === 'object' && 'error' in (r.json as object)))) return { json: null, missing: 'nokey' };
  if (r.status === 404 || r.status === 204) return { json: null, missing: 'none' };
  return { json: null, missing: 'failed' };
}

interface BoardEntry { name?: string; number?: string; category?: string; stop?: { departure?: string; platform?: string | null; prognosis?: { capacity1st?: number | string | null; capacity2nd?: number | string | null } }; capacity1st?: number | string | null; capacity2nd?: number | string | null }
const crowdOf = (v: unknown): TrainCrowd | null => { const n = Number(v); return n === 1 || n === 2 || n === 3 ? n : null; };
/** "2026-11-24 14:31" in Swiss time. */
function swissMinute(unix: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(unix * 1000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
/** The occupancy forecast at the boarding stop, per class, from transport.opendata.ch's station board. */
async function crowdAt(t: Station3DTrain): Promise<TrainShown['crowd']> {
  // at the boarding stop whichever end is shown (the forecast is for the train from there); the train number is the
  // boarding trip's only when you stay on one trip
  const b = t.board, dep = t.dep;
  if (t.mode !== 'train' || dep == null || !b.uic) return null;
  t = { ...t, uic: b.uic, ref: b.ref, number: t.role === 'board' || t.through ? t.number : '' };
  const q = new URLSearchParams({ id: t.uic, datetime: swissMinute(dep - 60), limit: '40' });
  q.append('transportations[]', 'train');
  const r = await getJson('https://transport.opendata.ch/v1/stationboard?' + q);
  const sb = r.json && typeof r.json === 'object' ? (r.json as { stationboard?: BoardEntry[] }).stationboard : null;
  const board: BoardEntry[] = Array.isArray(sb) ? sb : [];
  const num = Number(t.number);
  // by its number; without one, the same line at the same minute from the same platform (not one the other way)
  const plat = (j: BoardEntry) => String((j.stop && j.stop.platform) || '').replace(/[^0-9].*$/, '');
  const hit = board.find((j) => Number.isFinite(num) && num > 0 && Number(j.name) === num)
    || (!(num > 0) ? board.find((j) => j.stop && j.stop.departure && Math.abs(Date.parse(j.stop.departure) / 1000 - t.dep!) < 60
      && `${j.category}${j.number}` === t.line && plat(j) !== '' && plat(j) === t.ref.replace(/[^0-9].*$/, '')) : undefined);
  if (!hit) return null;
  const pr = (hit.stop && hit.stop.prognosis) || {};
  const first = crowdOf(pr.capacity1st ?? hit.capacity1st), second = crowdOf(pr.capacity2nd ?? hit.capacity2nd);
  return first || second ? { first, second } : null;
}

/** The formation service's answer for a train (once per train and day; a failure is asked again next time). */
type FormationGot = { json: FormationAnswer | null; missing?: TrainShown['missing'] };
const formations = new Map<string, Promise<FormationGot>>();
export function formationFor(t: Pick<Station3DTrain, 'operator' | 'number' | 'date'>, engine: TrainEngine): Promise<FormationGot> {
  const evu = evuOf(t.operator);
  if (!evu || !t.number) return Promise.resolve({ json: null, missing: 'operator' });
  const id = [evu, t.date, Number(t.number) || t.number].join('|');
  if (!formations.has(id)) {
    const p = formationOf(engine, evu, t.date, String(Number(t.number) || t.number)).catch(() => ({ json: null, missing: 'failed' as const }));
    formations.set(id, p);
    p.then((f) => { if (f.missing === 'failed') formations.delete(id); else setTimeout(() => formations.delete(id), 180e3); });
  }
  return formations.get(id)!;
}
/** The coaches standing at the end shown, as the view uses them: null when the formation does not place them there. */
export function coachesAt(f: FormationGot, t: Station3DTrain): { coaches: TrainCoach[] | null; missing?: TrainShown['missing'] } {
  // at the boarding end, which coaches stop where you get off; at the alighting end, just the coaches there
  let coaches = parseFormation(f.json, t.uic, t.role === 'board' ? t.toUic : null, t.role === 'alight');
  if (coaches && !coaches.some((c) => c.sectors.length)) return { coaches: null, missing: 'unplaced' };
  return coaches ? { coaches } : { coaches: null, missing: f.json ? 'none' : f.missing || 'none' };
}

const cache = new Map<string, Promise<TrainShown>>();
/** The train's coaches at the end shown and how full it is; what fails is left out (the promise never rejects). */
export function loadTrain(t: Station3DTrain, engine: TrainEngine): Promise<TrainShown> {
  const id = [t.id, t.role, t.operator, t.line, t.number, t.date, t.dep, t.uic, t.ref, t.sectors, t.toUic].join('|');
  if (!cache.has(id)) {
    const formation = t.mode === 'train' ? formationFor(t, engine) : Promise.resolve<FormationGot>({ json: null, missing: 'operator' });
    // how full: the forecast from where you board (also shown at the end you get off)
    const p = Promise.all([formation, crowdAt(t).catch(() => null)]).then(([f, crowd]) => {
      const { coaches, missing } = coachesAt(f, t);
      const fromCoaches = coaches ? [...new Set(coaches.flatMap((c) => c.sectors))].sort() : [];
      const shown: TrainShown = { train: t, coaches, sectors: fromCoaches.length ? fromCoaches : sectorList(t.sectors), crowd };
      if (!coaches) shown.missing = missing || 'none';
      return shown;
    });
    cache.set(id, p);
    // a failed answer is asked again at the next opening; a good one is kept for the page's life (three minutes)
    p.then((s) => { if (!s.coaches && s.missing === 'failed') cache.delete(id); else setTimeout(() => cache.delete(id), 180e3); });
  }
  return cache.get(id)!;
}

// ------------------------------------------------------------------ where to get on
/** Why no coach is recommended: the train splits and its data does not say which part stops where you get off; no
 *  coach of your class; none with a wheelchair space. */
export type TrainPickMissing = 'portion' | 'class' | 'wheelchair';
/** The coaches to get on (indices): open, in the part of the train that stops where you get off, of your class, with
 *  a wheelchair space when you need one. Nothing is recommended when one of these cannot be confirmed. */
export function coachesFor(coaches: TrainCoach[], cls: 1 | 2, wheelchair: boolean): { picks: number[]; missing: TrainPickMissing | null } {
  let pool = coaches.map((c, i) => ({ c, i }))
    .filter(({ c }) => !c.closed && c.kind !== 'loco' && c.kind !== 'luggage' && c.kind !== 'other' && c.kind !== 'restaurant' && c.sectors.length);
  const parts = new Set(coaches.map((c) => c.goesTo).filter(Boolean));
  if (pool.some(({ c }) => c.reaches === true)) pool = pool.filter(({ c }) => c.reaches === true);
  else if (parts.size > 1) return { picks: [], missing: 'portion' };
  pool = pool.filter(({ c }) => c.cls === 12 || c.cls === cls || (cls === 2 && c.declassed));
  if (!pool.length) return { picks: [], missing: 'class' };
  if (wheelchair) {
    pool = pool.filter(({ c }) => c.wheelchair);
    if (!pool.length) return { picks: [], missing: 'wheelchair' };
  }
  return { picks: pool.map(({ i }) => i), missing: null };
}
