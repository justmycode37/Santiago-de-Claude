// Indoor router for the station 3D models (stations3d/SCHEMA.md, section "Router"): the quickest walk through a
// model's graph, with step-by-step instructions. Classic script, no dependencies; sets StationRoute
// (and module.exports in Node, for tools/test_station_route*.mts).
//
// ---- API ----
// StationRoute.toLocal(model, [lng, lat])  → [x, y]
// StationRoute.toLngLat(model, [x, y])     → [lng, lat]
// StationRoute.z(model, level)             → metres (piecewise linear through model.levels[].z)
// StationRoute.route(model, from, to, prefs) → route | null
//   from / to: { stop: { uic, ref } } | { node: i } | { entrance: "name" } | { xy: [x, y], level } | { ll: [lng, lat], level }
//     A { stop } may also carry xy / ll (used when the model has no such stop) and sector: "B" / "A-D".
//   prefs: { stepFree, fewerStairs, noEscalators, wheelchair, walkKmh, date } (stricter ones imply the others, as in
//     settings.ts; date = "YYYY-MM-DD" or a Date, default today (local), for closures)
//   null when an endpoint cannot be found, or the two are not connected even ignoring closures (why() says which).
//   route, as in SCHEMA.md: { points, nodes, length, seconds, steps: [{ kind, from, to, level, toLevel, dir, len, seconds, text }] }
//   plus these optional fields:
//     route.relaxed   ['wheelchair', 'stepFree', 'noEscalators']: set only when no route meets the preferences; the route
//                     returned is then the one that breaks them least (fewest staircases, then escalators, then
//                     wheelchair: false edges, then steep slopes), and these are the settings it breaks.
//     route.closed    [{ what: 'stop' | 'entrance' | 'edge' | 'connector' | 'area', kind?, name?, ref?, note?, from?, until? }]
//                     closures that matter for this route: a closed endpoint, a closure the route goes around, or the
//                     closure that cuts it off.
//     route.incomplete  true when the destination can only be reached through something closed: the route then goes
//                     to the nearest point it can reach (toDist says how far that is from the destination).
//     route.throughClosed  true when the start itself is shut in by a closure (on a closed platform): the route then
//                     takes the way out through it, and the notice says so.
//     route.fromAssumed / route.toAssumed  { sector?: "B", xy: [x, y], text: "from the stairs at sector B" }
//                     A { stop } without a sector is the whole platform (stop.nodes, or the graph nodes inside its
//                     platform area, or stop.node): the route starts at the best of them for this destination and ends
//                     where it first reaches the platform. These say where that was (nearest sector sign, and the level
//                     change taken there), so the app can label the start "Platform 7 · sector B". With a sector in
//                     the ref ("7A-D") or { stop: { uic, ref, sector: "B" } } the route aims at that sector instead.
//     route.notice    one or two sentences for the user when relaxed / closed is set, e.g.
//                     "No step-free way here: this route has stairs." / "The lift is closed, reopens on 14 Dec."
//     route.same      true when start and end are the same place (e.g. a change on the same platform): then
//                     points has two equal points, length 0 and one arrive step ("Stay on platform 7").
//     route.fromDist / route.toDist  metres between the position asked for and the route's first / last point
//                     (0 for stops, nodes and entrances). A far start snaps to the nearest street-level outdoor edge:
//                     the app can then call it "the way in" and draw the street part itself.
//     route.dists     metres from the start at each point (stairs and ramps along the slope, lifts 0)
//     route.edges     graph edge index for each piece points[i] → points[i + 1] (-1 for none)
//     route.fromStop / route.toStop   the model.stops entry chosen for a { stop } endpoint
//     route.fromSectors / route.toSectors  ['A', 'B', ...] when the endpoint's ref names sectors ("7A-D", "7 B")
//     step.turn       'left' | 'right' | 'bear-left' | 'bear-right' | 'straight' | 'around' when the path bends there
//     step.place      what a walk goes through / along, or where a level change arrives ("platform 7", "the underpass")
//     step.warn       true on a step that breaks a preference (see relaxed)
//     arrive step:    sector: "B" / "A–D" (the aimed sectors, or the nearest sector sign within 30 m)
// StationRoute.snap(model, route, xy, hint?) → { index, t, point: [x, y, level], dist, along, remaining, step, progress }
//   Nearest position on a route to a position fix (local xy; pass { ll: [lng, lat] } for GPS). index = piece
//   points[index] → points[index + 1], t = 0..1 on it, dist = horizontal metres from the fix, along / remaining =
//   metres of route, step = index into route.steps. hint = the current level (a number), or the previous snap
//   result: then the position stays continuous along the route and changes floor only the way the route does (a lift
//   ride is free once you are at the lift, hopping onto the floor above or below is not). progress = the furthest
//   along reached so far (carried in the hint; steps back are counted from it, so noise cannot creep the dot back).
// StationRoute.pointAt(route, metres) → [x, y, level] (clamped to the route)
// StationRoute.sectorTimes(model, from, to, prefs) → { best, sectors: [{ name, seconds, length, via }], spreadSeconds } | null
//   from = a platform stop ({ stop: { uic, ref } }); for each sector of that platform the walk to `to` from that sector
//   (one backward search from the destination); via = the first level change used ('stairs' | 'escalator' | 'ramp' |
//   'elevator' | null); best = the sector with the best route for these preferences; spreadSeconds = slowest − quickest.
//   null when the platform has no sectors or the destination is not reachable.
// StationRoute.why(model, from, to, prefs) → null | 'unknown-stop' | 'unknown-entrance' | 'unknown-node' |
//   'unknown-position' | 'not-connected' | 'closed'
//   null: route() gives a complete route. 'closed': route() gives an incomplete one (only closed ways lead there).
//   'not-connected': both ends are known but the map has no way between them.
// StationRoute.isClosed(thing, date?) → boolean. thing: anything with a `closed` field, or the field itself.
//   closed: true (always) or { from?: "YYYY-MM-DD", until?: "YYYY-MM-DD", note? }: closed when from <= date < until;
//   a missing bound is open-ended.
// StationRoute.notices(model, date?) → [{ text, from?, until? }] of model.notices active on that date (strings: always)
// StationRoute.platformKey(ref) → the comparable form of a platform / stop edge name (the reference copy; see below)
// Extras: StationRoute.resolve(model, endpoint, date?) → candidates (debugging), StationRoute.levelName(model, level),
//   StationRoute.TIME (the numbers below).
// The graph is indexed once per model object (WeakMap); closures are applied per date at search time (cached per
// model and date), so the same model works for any day. Treat a model as read-only after its first route.
//
// Endpoints. { stop }: refs compare by platformKey; all stops of that stop id with that ref are candidates and the
// route picks the best (open ones first). A numeric ref matches exactly ("11" never means platform 1); letter refs also
// by prefix ("K" ↔ "K1"). A stop id that is not in the model falls back to the ref across the complex, then to the
// endpoint's xy / ll. A ref with sectors ("7A-D", "7 B", "7BC") aims at the middle of those sectors on that platform.
// Free positions snap to the nearest point on an open edge (not a node): on the given level, another floor only when
// nothing on this one is within ~30 m; without a level, outdoor street-level edges first. A position more than 25 m
// from every edge snaps only to an outdoor street-level walk (never to an indoor floor, a platform, a ramp or a deck).
//
// ---- Time model ----
// Real seconds (route.seconds, step.seconds):
//   walk       distance / walkKmh (default 4.7 km/h = 1.31 m/s). On slopes (edge.incline, or the level heights:
//              ramps, and outdoor walks between fractional levels) Tobler's hiking function, normalised to 1 on the
//              flat: 6 % uphill ≈ 0.81 × speed, 8 % ≈ 0.75 ×, gentle downhill up to 1.15 ×.
//   stairs     the flights by their rise: 0.34 m of height per second up (a 17 cm step every half second), 0.45 m/s
//              down, scaled with walkKmh; plus the horizontal length beyond the flights themselves (taken as 1.7 m per
//              metre of rise, the usual 17/29 cm step) walked at walking speed: landings and corridors in the edge.
//              4.8 m (one floor) ≈ 14 s up, 11 s down.
//   escalator  2 s to step on, then 0.6 m/s along the slope (people standing at 0.5 m/s, some walking); without a
//              horizontal length the slope is taken as 30°. One floor ≈ 18 s.
//   ramp       as walk, with the slope from the level heights (or edge.incline).
//   lift       30 s on boarding (average wait plus doors), then 2 s + 1 s per metre of height for each lift edge.
//              One floor ≈ 37 s, which is why people who can take the stairs rarely get a lift.
// Extra cost that is not time (it only steers the choice, so routes look like what a local would do):
//   +5 s for every change of level (stairs, escalator, lift, ramp that changes level): no pointless up-and-down.
//   +2 s per metre climbed on stairs, +0.8 s per metre down them, +0.5 s per metre climbed on slopes (effort).
//   Turns: up to +3 s for a bend sharper than 40° (U-turn = 3 s): no zig-zag across squares and junctions.
//   +2 s each time a walk switches between outdoor and indoor edges: stay on one kind of way.
//   fewerStairs: each flight of stairs costs 3 × its time + 90 s, so stairs win only when the alternative is about
//   1.5 min longer.
// Preferences that forbid something (noEscalators, stepFree, wheelchair) are hard: an edge that breaks one costs
// 10000 s (stairs), 8000 s (escalator), 5000 s (wheelchair: false) or 3000 s (steep: real slope above 8 %, ramps and
// walks alike) for each run of such edges; a landing (a short walk between two flights) belongs to the run, so it is
// counted once. So the route uses them only when nothing else connects, and then as few as possible; that is the
// "least-violating relaxation", reported in route.relaxed. One-way edges are never used backwards; closed edges never.
//
// The search runs over directed edges (Dijkstra, binary heap): the cost of going on can depend on how you arrived,
// which is what the lift wait (paid once per ride, not per floor), the level-change cost (once per staircase, not
// per flight piece) and the turn cost need. sectorTimes runs the same search backwards from the destination.
const KX = 111320, KY = 110540, DEG = 180 / Math.PI;
const TIME = {
  walkKmh: 4.7,
  stairsUpVert: 0.34, stairsDownVert: 0.45, stairsRun: 1.7, // horizontal metres of flight per metre of rise
  escalatorSpeed: 0.6, escalatorBoard: 2, escalatorSlope: 1.73, // horizontal metres per metre of height (30°)
  liftWait: 30, liftPerEdge: 2, liftSpeed: 1,
  levelChange: 5,
  stairsUpEffort: 2, stairsDownEffort: 0.8, climbEffort: 0.5,
  turnFrom: 40, turnMax: 3,
  outdoorSwitch: 2,
  fewerStairsFactor: 3, fewerStairsEntry: 90,
  steepIncline: 0.08,
  violation: { stairs: 10000, escalator: 8000, wheelchair: 5000, steep: 3000 },
  snapNear: 25, // metres: farther than this from every edge, a free position snaps only to a street-level outdoor walk
};

const WALK = 0, STAIRS = 1, ESC = 2, RAMP = 3, LIFT = 4, NONE = 5;
const KIND_NAMES = ['walk', 'stairs', 'escalator', 'ramp', 'elevator', 'none'];
const KIND_CODES = {
  walk: WALK, footway: WALK, corridor: WALK, path: WALK,
  stairs: STAIRS, steps: STAIRS,
  escalator: ESC,
  ramp: RAMP,
  elevator: LIFT, lift: LIFT,
};
const V_STAIRS = 1, V_ESC = 2, V_WCF = 4, V_STEEP = 8;

// ---------- Types (the router's own; what other scripts see is in src/types/station-route.d.ts) ----------
type Day = StationRouteDate | null | undefined;
type Endpoint = StationRouteEndpoint | null | undefined;
type Prefs = StationRoutePrefs | null | undefined;
type ClosedValue = StationRouteClosedValue | undefined;
/** The sectors a ref names: a range ("A-D") or a list ("BC"). */
type SectorSpec = { range: [string, string]; list?: undefined } | { list: string[]; range?: undefined };
/** A connector of either shape, as closureSources reads it: it checks each field before using it. */
interface AnyConnector { kind: StationRouteConnectorKind; xy?: XY; levels?: number[]; line?: XYL[]; name?: string; closed?: ClosedValue }
/** Something that can be closed … */
type ClosureSource = { kind?: StationRouteClosure['kind']; name?: string; ref?: string } & (
  | { what: 'stop'; obj: StationStop }
  | { what: 'edge' | 'connector' | 'area' | 'entrance'; obj: { closed?: ClosedValue } });
/** … and the graph edges that are closed with it. */
type EdgeClosure = ClosureSource & { edges: number[] };
/** The closed edges on one day: mask[e] = 1, by = edge → what closes it. */
interface ClosedOn { day: string; mask: Uint8Array; by: Map<number, EdgeClosure[]>; any: boolean }
interface PreparedArea { a: StationArea; level: number; box: [x0: number, y0: number, x1: number, y1: number]; prio: number }
/** A model indexed for the search (prepare). The arrays are per edge e; an arc is 2e (a → b) or 2e + 1 (b → a). */
interface Prepared {
  model: StationModel;
  nodes: XYL[];
  edges: StationEdge[];
  N: number;
  E: number;
  /** Height of each node, metres. */
  nz: Float64Array;
  EA: Int32Array;
  EB: Int32Array;
  /** WALK … LIFT. */
  kind: Uint8Array;
  L: Float64Array;
  dz: Float64Array;
  /** Heading a → b, radians (NaN: too short to have one). */
  hd: Float64Array;
  outdoor: Uint8Array;
  oneway: Uint8Array;
  /** V_… bits: the preferences the edge breaks; tmask: the same with landings counted as their stairs. */
  vmask: Uint8Array;
  tmask: Uint8Array;
  /** 0: an edge with a bad end, left out. */
  ok: Uint8Array;
  incl: Float64Array;
  /** Arcs leaving / arriving at each node. */
  outs: number[][];
  ins: number[][];
  /** Connected part of each node; main = the one with the stops. */
  comp: Int32Array;
  main: number;
  areas: PreparedArea[];
  zf: (level: number) => number;
  platKeys: (string[] | null)[];
  closeSrc: EdgeClosure[];
  closedCache: Map<string, ClosedOn>;
  stopNodeCache?: Map<StationStop, number[]>;
  stationNames?: Set<string>;
  platNodes?: Map<string, string[]>;
}

// ---------- Coordinates ----------
function toLocal(model: StationModel, ll: LngLat): XY {
  const [lng0, lat0] = model.origin;
  return [(ll[0] - lng0) * KX * Math.cos(lat0 * Math.PI / 180), (ll[1] - lat0) * KY];
}
function toLngLat(model: StationModel, xy: StationRouteXY): LngLat {
  const [lng0, lat0] = model.origin;
  return [lng0 + xy[0] / (KX * Math.cos(lat0 * Math.PI / 180)), lat0 + xy[1] / KY];
}

const zCache = new WeakMap<StationModel, (level: number) => number>();
function zFn(model: StationModel) {
  let f = zCache.get(model);
  if (f) return f;
  const lv = (model.levels || []).filter((l) => isFinite(l.id) && isFinite(l.z)).slice().sort((a, b) => a.id - b.id);
  f = (level) => {
    level = +level || 0;
    if (!lv.length) return level * 4.5;
    if (lv.length === 1) return lv[0].z + (level - lv[0].id) * 4.5;
    let i = 0;
    while (i < lv.length - 2 && level > lv[i + 1].id) i++;
    const a = lv[i], b = lv[i + 1];
    return a.z + (level - a.id) * (b.z - a.z) / (b.id - a.id);
  };
  zCache.set(model, f);
  return f;
}
const z = (model: StationModel, level: number) => zFn(model)(level);

// ---------- platformKey: the reference rule ----------
// The comparable form of a platform / stop edge name, used by the router, and meant for the app and the viewer too
// (call StationRoute.platformKey instead of keeping a copy):
//   1. upper-case, trim;
//   2. drop one leading word GLEIS, GL., GL, KANTE, QUAI, VOIE, BINARIO, STEG, PERRON, PLATFORM, TRACK, BAY or PIER
//      (with or without a space after it), but only when something follows it: "Steg" alone stays "STEG";
//   3. if it then starts with digits, the key is those digits ("7A-D" → "7", "Gleis 7" → "7", "12 Sektor B" → "12");
//   4. otherwise the key is the letters and digits only ("Kante H" → "H", "K1" → "K1", "K 1" → "K1", "–" → "").
const PK_PREFIX = /^(GLEIS|GL\.|GL|KANTE|QUAI|VOIE|BINARIO|STEG|PERRON|PLATFORM|TRACK|BAY|PIER)\s*(?=\S)/;
function platformKey(p: string | number | null | undefined) {
  let s = String(p == null ? '' : p).toUpperCase().trim();
  const rest = s.replace(PK_PREFIX, '');
  if (rest !== s && /[0-9A-Z]/.test(rest)) s = rest.trim();
  const digits = /^\d+/.exec(s);
  return digits ? digits[0] : s.replace(/[^0-9A-Z]/g, '');
}
// Sectors a ref names: "7A-D" → ['A', 'D'] as a range, "7 B" → ['B'], "7BC" → ['B', 'C'], "7" / "K1" → null
function refSectors(ref: string | number | null | undefined): SectorSpec | null {
  let s = String(ref == null ? '' : ref).toUpperCase().trim();
  const rest = s.replace(PK_PREFIX, '');
  if (rest !== s && /[0-9A-Z]/.test(rest)) s = rest.trim();
  const m = /^(\d+)\s*(?:SEKTOREN|SEKTOR|SECTORS|SECTOR|SECT\.?)?\s*([A-Z](?:\s*[-–—]\s*[A-Z])?|[A-Z](?:\s*[,/]?\s*[A-Z])*)$/.exec(s);
  if (!m) return null;
  const t = m[2].replace(/\s+/g, '');
  const range = /^([A-Z])[-–—]([A-Z])$/.exec(t);
  if (range) return { range: [range[1], range[2]] };
  return { list: t.replace(/[,/]/g, '').split('') };
}

// ---------- Dates and closures ----------
const pad2 = (n: number) => String(n).padStart(2, '0');
function dateKey(d?: Day): string {
  if (d instanceof Date && !isNaN(d as unknown as number)) return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  return dateKey(new Date());
}
const validDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);
function activeOn(c: ClosedValue, day: string) {
  if (!c) return false;
  if (c === true) return true;
  if (typeof c !== 'object') return false;
  const from = validDay(c.from) ? c.from.slice(0, 10) : null, until = validDay(c.until) ? c.until.slice(0, 10) : null;
  return (!from || from <= day) && (!until || day < until);
}
function isClosed(thing: { closed?: ClosedValue } | ClosedValue, date?: Day) {
  const day = dateKey(date);
  if (thing === true) return true;
  if (!thing || typeof thing !== 'object') return false;
  if ('closed' in thing) return activeOn(thing.closed, day);
  if ('from' in thing || 'until' in thing) return activeOn(thing, day); // a closure object itself
  return false;
}
function notices(model: StationModel | null | undefined, date?: Day): StationNotice[] {
  const day = dateKey(date);
  const out = [];
  for (const n of (model && model.notices) || [] as (StationNotice | string)[]) {
    if (typeof n === 'string') { if (n.trim()) out.push({ text: n }); continue; }
    if (!n || !n.text) continue;
    if (!validDay(n.from) && !validDay(n.until) ? true : activeOn({ from: n.from, until: n.until }, day)) {
      const o: StationNotice = { text: n.text };
      if (n.from) o.from = n.from;
      if (n.until) o.until = n.until;
      out.push(o);
    }
  }
  return out;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (s: string | undefined) => (validDay(s) ? `${+s.slice(8, 10)} ${MONTHS[+s.slice(5, 7) - 1]}` : '');

// ---------- Prepared model (cached, date-independent) ----------
const prepCache = new WeakMap<StationModel, Prepared>();
function prepare(model: StationModel): Prepared {
  let P = prepCache.get(model);
  if (P) return P;
  const g = model.graph || { nodes: [], edges: [] };
  const nodes = g.nodes || [], edges = g.edges || [];
  const N = nodes.length, E = edges.length;
  const zf = zFn(model);
  const nz = new Float64Array(N);
  for (let i = 0; i < N; i++) nz[i] = zf(nodes[i][2] || 0);
  const EA = new Int32Array(E), EB = new Int32Array(E);
  const kind = new Uint8Array(E), L = new Float64Array(E), dz = new Float64Array(E), hd = new Float64Array(E);
  const outdoor = new Uint8Array(E), oneway = new Uint8Array(E), vmask = new Uint8Array(E), ok = new Uint8Array(E);
  const incl = new Float64Array(E); // signed slope in a → b direction (NaN: flat / unknown)
  const outs = Array.from({ length: N }, (): number[] => []), ins = Array.from({ length: N }, (): number[] => []);
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };

  for (let e = 0; e < E; e++) {
    const ed = edges[e], a = ed.a, b = ed.b;
    if (!(a >= 0 && a < N && b >= 0 && b < N) || a === b) continue;
    ok[e] = 1;
    EA[e] = a; EB[e] = b;
    const k = KIND_CODES[ed.kind] != null ? KIND_CODES[ed.kind] : WALK;
    kind[e] = k;
    const geo = Math.hypot(nodes[b][0] - nodes[a][0], nodes[b][1] - nodes[a][1]);
    L[e] = k === LIFT ? 0 : (isFinite(ed.len) && ed.len >= 0 ? ed.len : geo);
    dz[e] = nz[b] - nz[a];
    hd[e] = geo > 0.3 ? Math.atan2(nodes[b][1] - nodes[a][1], nodes[b][0] - nodes[a][0]) : NaN;
    outdoor[e] = ed.outdoor ? 1 : 0;
    oneway[e] = ed.oneway ? 1 : 0;
    // edge.incline gives the steepness; which way is up comes from the level heights when they differ
    // (builders often write the size only), else from the sign of incline (a → b)
    let s = NaN;
    const hasInc = isFinite(ed.incline!) && ed.incline !== 0;
    if (Math.abs(dz[e]) > 0.05 && (k === RAMP || k === WALK)) {
      const mag = hasInc ? Math.abs(ed.incline!) : L[e] > 0.5 ? Math.abs(dz[e]) / L[e] : 1;
      s = Math.sign(dz[e]) * mag;
    } else if (hasInc) s = +ed.incline!;
    incl[e] = s;
    let m = 0;
    if (k === STAIRS) m |= V_STAIRS;
    if (k === ESC) m |= V_ESC;
    if (ed.wheelchair === false) m |= V_WCF;
    if ((k === RAMP || k === WALK) && isFinite(s) && Math.abs(s) > TIME.steepIncline + 1e-9) m |= V_STEEP;
    vmask[e] = m;
    outs[a].push(2 * e); ins[b].push(2 * e);
    if (!oneway[e]) { outs[b].push(2 * e + 1); ins[a].push(2 * e + 1); }
    parent[find(a)] = find(b);
  }
  // Landings: a short walk whose both ends touch flights of stairs (or escalators) carries their mask for counting
  // violations, so stairs – landing – stairs is one run of stairs.
  const tmask = new Uint8Array(vmask);
  const nodeMask = new Uint8Array(N);
  for (let e = 0; e < E; e++) if (ok[e] && (kind[e] === STAIRS || kind[e] === ESC)) { nodeMask[EA[e]] |= vmask[e]; nodeMask[EB[e]] |= vmask[e]; }
  for (let e = 0; e < E; e++) {
    if (!ok[e] || kind[e] !== WALK || L[e] >= 8) continue;
    const common = nodeMask[EA[e]] & nodeMask[EB[e]] & (V_STAIRS | V_ESC);
    if (common) tmask[e] |= common;
  }
  // Main connected part: the one with the stops (else the biggest)
  const comp = new Int32Array(N);
  const size = new Map<number, number>();
  for (let i = 0; i < N; i++) { comp[i] = find(i); size.set(comp[i], (size.get(comp[i]) || 0) + 1); }
  let main = -1;
  const st0 = (model.stops || []).find((s) => s.node >= 0 && s.node < N);
  if (st0) main = comp[st0.node];
  else { let best = -1; size.forEach((n, c) => { if (n > best) { best = n; main = c; } }); }

  // Areas by level, with bounding boxes, for names of places
  const areas = (model.areas || []).filter((a) => a.ring && a.ring.length >= 3 && a.kind !== 'room').map((a): PreparedArea => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of a.ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return { a, level: +a.level || 0, box: [x0, y0, x1, y1], prio: a.kind === 'platform' ? 0 : a.kind === 'floor' ? 1 : a.kind === 'plaza' ? 2 : 3 };
  });
  P = { model, nodes, edges, N, E, nz, EA, EB, kind, L, dz, hd, outdoor, oneway, vmask, tmask, ok, incl, outs, ins, comp, main, areas, zf } as Prepared;
  // Platform keys of the platform area each edge lies on (for sector aiming and snapping)
  P.platKeys = new Array<string[] | null>(E).fill(null);
  for (let e = 0; e < E; e++) {
    if (!ok[e]) continue;
    const pa = nodes[EA[e]], pb = nodes[EB[e]];
    const A = areasAt(P, (pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, ((pa[2] || 0) + (pb[2] || 0)) / 2).find((x) => x.kind === 'platform');
    if (A) P.platKeys[e] = platformRefs(A);
  }
  P.closeSrc = closureSources(P, model);
  P.closedCache = new Map();
  prepCache.set(model, P);
  return P;
}

// Which edges each closable thing closes (static); the date decides later which are closed.
function closureSources(P: Prepared, model: StationModel) {
  const src: EdgeClosure[] = []; // { what, obj, kind?, name?, ref?, edges: [e] }
  const { nodes, E, EA, EB, ok, kind, outdoor } = P;
  const edgesOf = (test: (e: number) => boolean) => { const out: number[] = []; for (let e = 0; e < E; e++) if (ok[e] && test(e)) out.push(e); return out; };
  (model.graph && model.graph.edges || []).forEach((ed, e) => {
    if (ed && ed.closed) src.push({ what: 'edge', obj: ed, kind: KIND_NAMES[kind[e]] as StationEdgeKind, name: ed.name || '', edges: [e] });
  });
  (model.connectors || []).forEach((c: AnyConnector) => {
    if (!c || !c.closed) return;
    let es: number[];
    if (c.kind === 'elevator' && c.xy) {
      const lv = Array.isArray(c.levels) ? c.levels : null;
      const at = (n: number) => Math.hypot(nodes[n][0] - c.xy![0], nodes[n][1] - c.xy![1]) < 2.5 && (!lv || lv.some((l) => Math.abs(l - nodes[n][2]) < 0.3));
      es = edgesOf((e) => kind[e] === LIFT && at(EA[e]) && at(EB[e]));
    } else if (Array.isArray(c.line) && c.line.length >= 2) {
      const k = KIND_CODES[c.kind] != null ? KIND_CODES[c.kind] : -1;
      const lvs = c.line.map((p) => (p.length > 2 ? +p[2] : 0));
      const lo = Math.min(...lvs) - 0.15, hi = Math.max(...lvs) + 0.15;
      const near = (n: number) => nodes[n][2] >= lo && nodes[n][2] <= hi && distToLine(c.line!, nodes[n][0], nodes[n][1]) < 1.5;
      es = edgesOf((e) => kind[e] === k && near(EA[e]) && near(EB[e]));
    } else es = [];
    src.push({ what: 'connector', obj: c, kind: c.kind, name: c.name || '', edges: es });
  });
  (model.areas || []).forEach((a) => {
    if (!a || !a.closed || !a.ring || a.ring.length < 3) return;
    // every edge with an end on that area (walks on it, and the stairs, lifts … that arrive on it)
    const lv = +a.level || 0;
    const inside = (p: XYL) => Math.abs(p[2] - lv) <= 0.3 && inRing(a.ring, p[0], p[1]) && !(a.holes || []).some((h) => h && h.length >= 3 && inRing(h, p[0], p[1]));
    const es = edgesOf((e) => inside(nodes[EA[e]]) || inside(nodes[EB[e]]));
    src.push({ what: 'area', obj: a, kind: a.kind, name: a.name || '', ref: (a.refs || []).join('/'), edges: es });
  });
  // A closed entrance: you cannot go in or out there (its indoor edges close; the street outside stays open)
  (model.entrances || []).forEach((en) => {
    if (!en || !en.closed || !(en.node >= 0 && en.node < P.N)) return;
    // (an entrance with only outdoor edges is a point on the street: nothing to close, the notice still says it)
    const es = edgesOf((e) => (EA[e] === en.node || EB[e] === en.node) && !outdoor[e]);
    src.push({ what: 'entrance', obj: en, name: en.name || '', edges: es });
  });
  return src;
}
// Closed edges on a date: { mask: Uint8Array(E), by: Map(edge → [source]), any }
function closedFor(P: Prepared, date: Day): ClosedOn {
  const day = dateKey(date);
  let c = P.closedCache.get(day);
  if (c) return c;
  const mask = new Uint8Array(P.E), by = new Map<number, EdgeClosure[]>();
  let any = false;
  for (const s of P.closeSrc) {
    if (!activeOn(s.obj.closed, day)) continue;
    for (const e of s.edges) {
      mask[e] = 1; any = true;
      if (!by.has(e)) by.set(e, []);
      by.get(e)!.push(s);
    }
  }
  c = { day, mask, by, any };
  if (P.closedCache.size > 16) P.closedCache.clear();
  P.closedCache.set(day, c);
  return c;
}
function closureEntry(s: ClosureSource, model: StationModel) {
  const c = s.obj.closed, o: StationRouteClosure = { what: s.what };
  if (s.kind) o.kind = s.kind;
  if (s.name) o.name = s.name;
  if (s.ref) o.ref = s.ref;
  if (s.what === 'stop') { o.ref = s.obj.ref || ''; if (s.obj.uic) o.uic = String(s.obj.uic); if (s.obj.mode) o.mode = s.obj.mode; }
  if (c && typeof c === 'object') {
    if (c.note) o.note = c.note;
    if (c.from) o.from = c.from;
    if (c.until) o.until = c.until;
  }
  return o;
}
function closureSentence(o: StationRouteClosure, model: StationModel) {
  if (o.note) return /[.!?]$/.test(o.note.trim()) ? o.note.trim() : o.note.trim() + '.';
  const thing: string | undefined = { stairs: 'the stairs', escalator: 'the escalator', elevator: 'the lift', ramp: 'the ramp' }[o.kind as StationRouteConnectorKind];
  const what = o.what === 'stop' ? (o.ref ? `${nounFor({ mode: o.mode })} ${o.ref}` : 'This stop')
    : o.what === 'entrance' ? (o.name ? `The entrance ${o.name}` : 'This entrance')
      : o.what === 'area' ? (o.name || (o.ref ? `Platform ${o.ref}` : 'Part of the station'))
        : thing ? cap(thing) + (o.name ? ` ${o.name}` : '') + (o.what === 'edge' ? ' on the way' : '')
          : o.name || 'A passage on the way';
  const are = o.kind === 'stairs' && (o.what === 'connector' || o.what === 'edge') ? 'are' : 'is';
  return `${what} ${are} closed${o.until ? `, reopens on ${fmtDay(o.until)}` : ''}.`;
}

// ---------- Geometry helpers ----------
function inRing(ring: XY[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToLine(line: StationRouteXY[], x: number, y: number) {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const p = line[i], q = line[i + 1], dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy;
    let t = l2 > 1e-9 ? ((x - p[0]) * dx + (y - p[1]) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(x - p[0] - t * dx, y - p[1] - t * dy));
  }
  return line.length === 1 ? Math.hypot(x - line[0][0], y - line[0][1]) : best;
}
// Areas containing (x, y) on that floor (whole level ± 0.3), best first: platform, floor, plaza, other
function areasAt(P: Prepared, x: number, y: number, level: number) {
  const lr = Math.round(level);
  if (Math.abs(level - lr) > 0.3) return [];
  const out = [];
  for (const A of P.areas) {
    if (A.level !== lr) continue;
    const b = A.box;
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    if (!inRing(A.a.ring, x, y)) continue;
    if (A.a.holes && A.a.holes.some((h) => h && h.length >= 3 && inRing(h, x, y))) continue;
    out.push(A);
  }
  return out.sort((p, q) => p.prio - q.prio).map((A) => A.a);
}
const angleDiff = (a: number, b: number) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d <= -Math.PI) d += 2 * Math.PI; return d; };

// ---------- Endpoints ----------
// Nearest point on an open edge to (x, y). level: the floor the position is on, or null (then prefer outdoor street
// level). opt.filter(e) limits the edges; opt.closed is the closure mask. Far from everything (> snapNear): only a
// street-level outdoor walk.
/** An end of a search: a resolve() candidate, or a sector aim (that one has no dist). */
type End = StationRouteGraphPlace & Omit<StationRouteCandidateInfo, 'dist'> & { dist?: number };
/** What resolve() notes on a candidate besides its place. */
type EndExtra = Pick<StationRouteCandidateInfo, 'stop' | 'closedStop' | 'onPlatform' | 'entrance' | 'closedEntrance'>;
/** A point on an edge: s = 0..1 from the edge's a to its b. */
interface EdgePoint { edge: number; s: number; point: XYL; dist: number; score?: number }
interface SnapOptions { closed?: Uint8Array | null; filter?: (e: number) => unknown }
function snapToGraph(P: Prepared, x: number, y: number, level: number | null | undefined, opt: SnapOptions = {}): EdgePoint | null {
  const hasLevel = level != null && isFinite(level);
  const closed = opt.closed, filter = opt.filter;
  const usable = (e: number) => P.ok[e] && P.kind[e] !== LIFT && !(closed && closed[e]) && (!filter || filter(e));
  const onEdge = (e: number): EdgePoint => {
    const pa = P.nodes[P.EA[e]], pb = P.nodes[P.EB[e]];
    const dx = pb[0] - pa[0], dy = pb[1] - pa[1], l2 = dx * dx + dy * dy;
    let t = l2 > 1e-9 ? ((x - pa[0]) * dx + (y - pa[1]) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = pa[0] + t * dx, py = pa[1] + t * dy;
    const lv = (pa[2] || 0) + t * ((pb[2] || 0) - (pa[2] || 0));
    return { edge: e, s: t, point: [px, py, lv], dist: Math.hypot(x - px, y - py) };
  };
  const street = (e: number, c: EdgePoint) => P.kind[e] === WALK && P.outdoor[e] && Math.abs(c.point[2]) <= 0.6 && !P.platKeys[e];
  let best = null, bestStreet = null, bestOut = null, bestWalk = null;
  for (let e = 0; e < P.E; e++) {
    if (!usable(e)) continue;
    const c = onEdge(e);
    const lv = c.point[2];
    let score = c.dist;
    if (hasLevel) {
      const dl = Math.abs(lv - level);
      if (dl > 0.26) score += 30 * dl; // a different floor only when nothing on this one is within ~30 m
      if (P.kind[e] !== WALK) score += 3; // stand on a floor rather than half way up the stairs
    } else {
      if (street(e, c)) score += 0;
      else if (P.outdoor[e] && P.kind[e] === WALK) score += P.platKeys[e] ? 6 : 15 + 10 * Math.abs(lv);
      else if (Math.abs(lv) < 0.26 && P.kind[e] === WALK) score += P.platKeys[e] ? 6 : 3;
      else score += 25 + 10 * Math.abs(lv);
      if (P.kind[e] !== WALK) score += 8;
    }
    if (P.comp[P.EA[e]] !== P.main) score += 50; // stray bits of graph that do not connect
    c.score = score;
    if (!best || score < best.score!) best = c;
    if (street(e, c) && (!bestStreet || c.dist < bestStreet.dist)) bestStreet = c;
    if (P.outdoor[e] && P.kind[e] === WALK && (!bestOut || c.dist < bestOut.dist)) bestOut = c;
    if (P.kind[e] === WALK && (!bestWalk || c.dist < bestWalk.dist)) bestWalk = c;
  }
  if (!best || filter) return best;
  if (best.dist <= TIME.snapNear) return best;
  // Far away: come in from the street, never mid-ramp, on a platform or an upper deck
  return bestStreet || bestOut || bestWalk || best;
}

function sectorsOf(model: StationModel, key: string) {
  return (model.sectors || []).filter((s) => s && platformKey(s.ref) === key && (s.xy || Number.isInteger(s.node)))
    .slice().sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0));
}
// The point to aim at for some sectors of a platform: their node (one sector), else the middle of the range,
// snapped onto that platform's edges. null when the data has none of them.
function sectorAim(P: Prepared, model: StationModel, key: string, spec: SectorSpec | null, level: number | null | undefined, closed: Uint8Array | null): End | null {
  const all = sectorsOf(model, key);
  if (!all.length || !spec) return null;
  let chosen;
  if (spec.range) {
    const [a, b] = spec.range[0] <= spec.range[1] ? spec.range : [spec.range[1], spec.range[0]];
    chosen = all.filter((s) => String(s.name).toUpperCase() >= a && String(s.name).toUpperCase() <= b);
  } else chosen = all.filter((s) => spec.list.includes(String(s.name).toUpperCase()));
  if (!chosen.length) return null;
  const names = chosen.map((s) => String(s.name));
  const first = chosen[0], last = chosen[chosen.length - 1];
  if (chosen.length === 1 && Number.isInteger(first.node) && first.node! >= 0 && first.node! < P.N) {
    return { node: first.node!, point: P.nodes[first.node!].slice(0, 3) as XYL, sectors: names };
  }
  const xyOf = (s: StationSector) => (s.xy ? s.xy : P.nodes[s.node!]);
  const mx = (xyOf(first)[0] + xyOf(last)[0]) / 2, my = (xyOf(first)[1] + xyOf(last)[1]) / 2;
  const lv = level != null ? level : 0;
  let c = snapToGraph(P, mx, my, lv, { closed, filter: (e) => P.platKeys[e] && P.platKeys[e].includes(key) && Math.abs(P.nodes[P.EA[e]][2] - lv) < 0.3 });
  if (!c || c.dist > 25) c = snapToGraph(P, mx, my, lv, { closed, filter: (e) => P.kind[e] === WALK && Math.abs(P.nodes[P.EA[e]][2] - lv) < 0.3 });
  if (!c || c.dist > 25) return null;
  return { edge: c.edge, s: c.s, point: c.point, sectors: names };
}

// Every graph node along a stop's platform: stop.nodes when the builder gives them, else the nodes on the stop's
// level inside the platform areas whose refs include the stop's ref, else just stop.node. Cached per model.
function stopNodes(P: Prepared, model: StationModel, s: StationStop) {
  if (!P.stopNodeCache) P.stopNodeCache = new Map();
  let ns = P.stopNodeCache.get(s);
  if (ns) return ns;
  const ok = (n: number) => Number.isInteger(n) && n >= 0 && n < P.N;
  if (Array.isArray(s.nodes) && s.nodes.some(ok)) ns = [...new Set(s.nodes.filter(ok))];
  else {
    ns = [];
    const key = platformKey(s.ref);
    const lvl = s.level != null && isFinite(s.level) ? +s.level : ok(s.node) ? P.nodes[s.node][2] : null;
    if (key && lvl != null) {
      const plats = P.areas.filter((A) => A.a.kind === 'platform' && Math.abs(A.level - lvl) < 0.3 && platformRefs(A.a).includes(key));
      if (plats.length) {
        for (let n = 0; n < P.N; n++) {
          const p = P.nodes[n];
          if (Math.abs(p[2] - lvl) > 0.3 || P.comp[n] !== P.comp[ok(s.node) ? s.node : n]) continue;
          for (const A of plats) {
            const b = A.box;
            if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3] || !inRing(A.a.ring, p[0], p[1])) continue;
            if ((A.a.holes || []).some((h) => h && h.length >= 3 && inRing(h, p[0], p[1]))) continue;
            ns.push(n);
            break;
          }
        }
      }
    }
    if (ok(s.node) && !ns.includes(s.node)) ns.unshift(s.node);
  }
  P.stopNodeCache.set(s, ns);
  return ns;
}

function resolve(model: StationModel, ep: Endpoint, date?: Day): StationRouteCandidate[] {
  const P = prepare(model);
  if (!ep) return [];
  const closed = closedFor(P, date).mask;
  const stops = model.stops || [];
  const day = dateKey(date);
  const nodeOk = (n: number) => Number.isInteger(n) && n >= 0 && n < P.N;
  const fromNode = (n: number, extra: EndExtra): StationRouteCandidate => Object.assign({ node: n, point: P.nodes[n].slice(0, 3) as XYL, dist: 0 }, extra);
  const fromXY = (xy: StationRouteXY, level: number | null, extra: EndExtra, d = true): StationRouteCandidate[] => {
    const s = snapToGraph(P, xy[0], xy[1], level, { closed });
    return s ? [Object.assign({ edge: s.edge, s: s.s, point: s.point, dist: d ? s.dist : 0 }, extra)] : [];
  };
  const openFirst = (list: StationRouteCandidate[], test: (c: StationRouteCandidate) => unknown) => { const open = list.filter((c) => !test(c)); return open.length ? open : list; };
  if (ep.stop) {
    const uic = ep.stop.uic != null ? String(ep.stop.uic) : null;
    const key = platformKey(ep.stop.ref);
    const sec = refSectors(ep.stop.ref);
    let pool = uic ? stops.filter((s) => String(s.uic) === uic) : stops;
    if (uic && !pool.length && key) pool = stops; // stop id not in the model: try the ref across the complex
    let c = pool.filter((s) => !key || platformKey(s.ref) === key);
    // letter forms only: "K" ↔ "K1"; a number never matches another number by prefix ("11" is not platform 1)
    if (!c.length && key && !/^\d+$/.test(key)) c = pool.filter((s) => { const k = platformKey(s.ref); return k && !/^\d+$/.test(k) && (k.startsWith(key) || key.startsWith(k)); });
    let out: StationRouteCandidate[] = [];
    const seenNode = new Set<number>();
    for (const s of c) {
      const extra = { stop: s, closedStop: activeOn(s.closed, day) };
      // the whole platform: you may be anywhere along it (the search picks the best node)
      const ns = stopNodes(P, model, s);
      if (ns.length) {
        for (const n of ns) if (!seenNode.has(n)) { seenNode.add(n); out.push(fromNode(n, Object.assign({ onPlatform: ns.length > 1 }, extra))); }
      } else if (s.xy) out.push(...fromXY(s.xy, s.level, extra, false));
    }
    out = openFirst(out, (x) => x.closedStop);
    // sectors named in the ref, or given as { stop: { …, sector } }: aim at them instead of the whole platform
    const secSpec = ep.stop.sector ? refSectors(`${key || '0'} ${ep.stop.sector}`) : sec;
    if (out.length && secSpec && /^\d+$/.test(key)) {
      const aim = sectorAim(P, model, key, secSpec, out[0].stop!.level != null ? out[0].stop!.level : out[0].point[2], closed);
      if (aim) out = [Object.assign(aim, { stop: out[0].stop, closedStop: out[0].closedStop, dist: 0 })];
    }
    // a stop the model does not know (no such ref): fall back to the position given with it, if any
    if (out.length || !(ep.xy || ep.ll)) return out;
  }
  if (ep.node != null) return nodeOk(ep.node) ? [fromNode(ep.node, {})] : [];
  if (ep.entrance != null) {
    const ents = model.entrances || [];
    const want = String(ep.entrance).trim().toLowerCase();
    let c = ents.filter((e) => String(e.name || '').trim().toLowerCase() === want);
    if (!c.length && want) c = ents.filter((e) => String(e.name || '').toLowerCase().includes(want));
    const out = [];
    for (const en of c) {
      const extra = { entrance: en, closedEntrance: activeOn(en.closed, day) };
      if (nodeOk(en.node)) out.push(fromNode(en.node, extra));
      else if (en.xy) out.push(...fromXY(en.xy, en.level, extra, false));
    }
    return openFirst(out, (x) => x.closedEntrance);
  }
  if (ep.xy || ep.ll) {
    const xy = ep.xy || toLocal(model, ep.ll!);
    // The point the timetable data has for a stop without a number (stops[].at, within 3 m) is that stop, on the
    // level the model has it on: the level that comes with such a position is the timetable data's own guess.
    let at: StationStop | null = null, best = 3;
    for (const s of stops) {
      if (s.ref || !s.at) continue;
      const d = Math.hypot(s.at[0] - xy[0], s.at[1] - xy[1]);
      if (d <= best) { best = d; at = s; }
    }
    if (at) {
      const extra = { stop: at, closedStop: activeOn(at.closed, day) };
      const ns = stopNodes(P, model, at);
      if (ns.length) return ns.map((n) => fromNode(n, Object.assign({ onPlatform: ns.length > 1 }, extra)));
      if (at.xy) return fromXY(at.xy, at.level, extra, false);
    }
    return fromXY(xy, ep.level != null && isFinite(ep.level) ? +ep.level : null, {});
  }
  return [];
}

// ---------- Binary heap ----------
/** A min-heap of values v by key k. lastKey: the key of the value pop() gave last. */
interface Heap { k: number[]; v: number[]; lastKey: number; push(key: number, val: number): void; pop(): number }
/** Heap is a constructor function, not a class: this is what `new Heap()` makes. */
type HeapClass = new () => Heap;
function Heap(this: Heap) { this.k = []; this.v = []; }
Heap.prototype.push = function (this: Heap, key: number, val: number) {
  const k = this.k, v = this.v;
  let i = k.length;
  k.push(key); v.push(val);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (k[p] <= key) break;
    k[i] = k[p]; v[i] = v[p]; i = p;
  }
  k[i] = key; v[i] = val;
};
Heap.prototype.pop = function (this: Heap) {
  const k = this.k, v = this.v;
  const top = v[0], topK = k[0];
  const lk = k.pop()!, lv = v.pop()!;
  const n = k.length;
  if (n) {
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && k[c + 1] < k[c]) c++;
      if (k[c] >= lk) break;
      k[i] = k[c]; v[i] = v[c]; i = c;
    }
    k[i] = lk; v[i] = lv;
  }
  this.lastKey = topK;
  return top;
};

// ---------- Search ----------
function settings(prefs: Prefs) {
  const p = prefs || {};
  const wheel = !!p.wheelchair;
  const stepFree = wheel || !!p.stepFree;
  const fewer = stepFree || !!p.fewerStairs;
  const noEsc = stepFree || !!p.noEscalators;
  const kmh = isFinite(p.walkKmh!) && p.walkKmh! > 0 ? +p.walkKmh! : TIME.walkKmh;
  let active = 0;
  if (stepFree) active |= V_STAIRS;
  if (noEsc) active |= V_ESC;
  if (wheel) active |= V_WCF | V_STEEP;
  return { wheel, stepFree, fewer, noEsc, v: kmh / 3.6, scale: kmh / TIME.walkKmh, active, date: dateKey(p.date) };
}

// Seconds and steering cost of a whole edge in one direction
type SearchSettings = ReturnType<typeof settings>;
function edgeCost(P: Prepared, e: number, fwd: boolean, S: SearchSettings) {
  const k = P.kind[e], L = P.L[e], dz = fwd ? P.dz[e] : -P.dz[e], h = Math.abs(dz);
  let time = 0, extra = 0;
  if (k === WALK || k === RAMP) {
    let g = P.incl[e];
    g = isFinite(g) ? (fwd ? g : -g) : 0;
    let f = Math.exp(-3.5 * Math.abs(g + 0.05)) / Math.exp(-3.5 * 0.05);
    f = Math.min(1.15, Math.max(0.3, f));
    time = L / (S.v * f);
    if (g > 0.02) extra += TIME.climbEffort * g * L;
  } else if (k === STAIRS) {
    const vert = (dz >= 0 ? TIME.stairsUpVert : TIME.stairsDownVert) * S.scale;
    // the flights by their rise, plus whatever horizontal length the edge has beyond them (landings) at walking pace
    time = h / vert + Math.max(0, L - h * TIME.stairsRun) / S.v;
    if (h < 0.05) time = L / S.v; // "stairs" with no rise in the data: walk them
    extra += h * (dz >= 0 ? TIME.stairsUpEffort : TIME.stairsDownEffort);
    if (S.fewer) extra += (TIME.fewerStairsFactor - 1) * time;
  } else if (k === ESC) {
    const hl = Math.max(L, h * TIME.escalatorSlope);
    time = Math.hypot(hl, h) / TIME.escalatorSpeed;
  } else if (k === LIFT) {
    time = TIME.liftPerEdge + h / TIME.liftSpeed;
  }
  return [time, extra];
}
const changesLevel = (P: Prepared, e: number) => Math.abs(P.dz[e]) > 0.5 || P.kind[e] === LIFT;

// One query: base arcs 2e (a → b) / 2e + 1 (b → a), plus virtual arcs from the start S and into the end T
// (partial edges for snapped points). closed: Uint8Array(E) or null (ignore closures).
/** The arcs of a path, first to last, and the cost the search found for it. */
type Arcs = number[] & { cost?: number };
/** One search. Arc ids: 0 … B − 1 are the graph's (2e, 2e + 1), B … nA − 1 the virtual ones out of S and into T. */
interface Query {
  P: Prepared;
  S: SearchSettings;
  closed: Uint8Array | null;
  src: End[];
  dst: End[];
  B: number;
  /** The node numbers of the start S and the end T. */
  SN: number;
  TN: number;
  /** The virtual arcs, by id − B: from and to node, edge (-1: none) and the part s0 → s1 of it that is walked. */
  vF: number[];
  vT: number[];
  vE: number[];
  vS0: number[];
  vS1: number[];
  vCs: number[];
  vCd: number[];
  extraOut: Map<number, number[]>;
  extraIn: Map<number, number[]>;
  sOut: number[];
  tIn: number[];
  nA: number;
  edge: (id: number) => number;
  fwd: (id: number) => boolean;
  frac: (id: number) => number;
  to: (id: number) => number;
  from: (id: number) => number;
  kind: (id: number) => number;
  usable: (id: number) => boolean;
  cost: (id: number) => number;
  time: (id: number) => number;
  mask: (id: number) => number;
  trans: (i: number, o: number, real?: boolean) => number;
  uturn: (a: number, b: number) => boolean;
  outsOf: (v: number) => (number[] | null | undefined)[];
  insOf: (v: number) => (number[] | null | undefined)[];
  /** Set by plan(): the route goes through a closure / where it wanted to go when it stops short. */
  through?: boolean;
  wantedPoint?: XYL;
  wanted?: End;
}
function makeQuery(P: Prepared, S: SearchSettings, closed: Uint8Array | null, src: End[], dst: End[]): Query {
  const E = P.E, B = 2 * E, SN = P.N, TN = P.N + 1;
  const bCost = new Float64Array(B), bTime = new Float64Array(B);
  for (let e = 0; e < E; e++) {
    if (!P.ok[e]) continue;
    const f = edgeCost(P, e, true, S), r = edgeCost(P, e, false, S);
    bTime[2 * e] = f[0]; bCost[2 * e] = f[0] + f[1];
    bTime[2 * e + 1] = r[0]; bCost[2 * e + 1] = r[0] + r[1];
  }
  // vCs / vCd: index of the start / end candidate an arc belongs to
  const vF: number[] = [], vT: number[] = [], vE: number[] = [], vS0: number[] = [], vS1: number[] = [], vCs: number[] = [], vCd: number[] = [];
  const extraOut = new Map<number, number[]>(), extraIn = new Map<number, number[]>(), sOut: number[] = [], tIn: number[] = [];
  const isClosed = (e: number) => e >= 0 && closed && closed[e];
  const addV = (from: number, to: number, e: number, s0: number, s1: number, cs: number, cd: number) => {
    if (isClosed(e)) return;
    const id = B + vF.length;
    vF.push(from); vT.push(to); vE.push(e); vS0.push(s0); vS1.push(s1); vCs.push(cs); vCd.push(cd);
    if (from === SN) sOut.push(id);
    else { if (!extraOut.has(from)) extraOut.set(from, []); extraOut.get(from)!.push(id); }
    if (to === TN) tIn.push(id);
    else { if (!extraIn.has(to)) extraIn.set(to, []); extraIn.get(to)!.push(id); }
  };
  src.forEach((c, ci) => {
    if (c.node != null) addV(SN, c.node, -1, 0, 0, ci, -1);
    else {
      addV(SN, P.EB[c.edge], c.edge, c.s, 1, ci, -1);
      if (!P.oneway[c.edge]) addV(SN, P.EA[c.edge], c.edge, c.s, 0, ci, -1);
    }
  });
  dst.forEach((c, ci) => {
    if (c.node != null) addV(c.node, TN, -1, 0, 0, -1, ci);
    else {
      addV(P.EA[c.edge], TN, c.edge, 0, c.s, -1, ci);
      if (!P.oneway[c.edge]) addV(P.EB[c.edge], TN, c.edge, 1, c.s, -1, ci);
    }
  });
  src.forEach((a, ai) => dst.forEach((b, bi) => {
    if (a.edge == null || a.edge !== b.edge) return;
    if (b.s >= a.s || !P.oneway[a.edge]) addV(SN, TN, a.edge, a.s, b.s, ai, bi);
  }));
  const Q = { P, S, closed, src, dst, B, SN, TN, vF, vT, vE, vS0, vS1, vCs, vCd, extraOut, extraIn, sOut, tIn } as Query;
  Q.nA = B + vF.length;
  Q.edge = (id) => (id < B ? id >> 1 : vE[id - B]);
  Q.fwd = (id) => (id < B ? (id & 1) === 0 : vS1[id - B] >= vS0[id - B]);
  Q.frac = (id) => (id < B ? 1 : Math.abs(vS1[id - B] - vS0[id - B]));
  Q.to = (id) => (id < B ? (id & 1 ? P.EA[id >> 1] : P.EB[id >> 1]) : vT[id - B]);
  Q.from = (id) => (id < B ? (id & 1 ? P.EB[id >> 1] : P.EA[id >> 1]) : vF[id - B]);
  Q.kind = (id) => { const e = Q.edge(id); return e < 0 ? NONE : P.kind[e]; };
  Q.usable = (id) => { const e = Q.edge(id); return !(e >= 0 && closed && closed[e]); };
  Q.cost = (id) => {
    if (id < B) return bCost[id];
    const e = vE[id - B];
    return e < 0 ? 0 : Q.frac(id) * bCost[2 * e + (Q.fwd(id) ? 0 : 1)];
  };
  Q.time = (id) => {
    if (id < B) return bTime[id];
    const e = vE[id - B];
    return e < 0 ? 0 : Q.frac(id) * bTime[2 * e + (Q.fwd(id) ? 0 : 1)];
  };
  const head = (id: number) => {
    const e = Q.edge(id);
    if (e < 0 || P.L[e] * Q.frac(id) < 0.3) return NaN;
    return Q.fwd(id) ? P.hd[e] : P.hd[e] + Math.PI;
  };
  Q.mask = (id) => { const e = Q.edge(id); return e < 0 ? 0 : P.vmask[e]; };
  const tmask = (id: number) => { const e = Q.edge(id); return e < 0 ? 0 : P.tmask[e]; };
  const W = TIME.violation;
  // Cost (or, with real = true, only the real seconds) of going on from arc i (-1: start) into arc o
  // a landing between flights counts as part of the staircase (one entry, one level change)
  const runKind = (id: number) => { const k = Q.kind(id); return k === WALK && (tmask(id) & V_STAIRS) ? STAIRS : k; };
  Q.trans = (i, o, real) => {
    const ki = i < 0 ? NONE : Q.kind(i), ko = Q.kind(o);
    if (ko === NONE) return 0;
    let t = 0, c = 0;
    const eo = Q.edge(o);
    const ro = runKind(o), ri = i < 0 ? NONE : runKind(i);
    if (ro !== ri && ro !== WALK) {
      if (ro === ESC) t += TIME.escalatorBoard;
      if (ro === LIFT) t += TIME.liftWait;
      if (changesLevel(P, eo) || ro !== ko) c += TIME.levelChange;
      if (ro === STAIRS && S.fewer) c += TIME.fewerStairsEntry;
    }
    if (real) return t;
    const nm = tmask(o) & ~(i < 0 ? 0 : tmask(i)) & S.active;
    if (nm) {
      if (nm & V_STAIRS) c += W.stairs;
      if (nm & V_ESC) c += W.escalator;
      if (nm & V_WCF) c += W.wheelchair;
      if (nm & V_STEEP) c += W.steep;
    }
    if (i >= 0 && ki !== LIFT && ko !== LIFT) {
      const h1 = head(i), h2 = head(o);
      if (h1 === h1 && h2 === h2) {
        const a = Math.abs(angleDiff(h1, h2)) * DEG;
        if (a > TIME.turnFrom) c += TIME.turnMax * (a - TIME.turnFrom) / (180 - TIME.turnFrom);
      }
      const ei = Q.edge(i);
      if (ki === WALK && ko === WALK && P.outdoor[ei] !== P.outdoor[eo]) c += TIME.outdoorSwitch;
    }
    return c + t;
  };
  Q.uturn = (a, b) => { const ea = Q.edge(a), eb = Q.edge(b); return eb >= 0 && eb === ea && Q.fwd(b) !== Q.fwd(a); };
  Q.outsOf = (v) => [v < P.N ? P.outs[v] : null, extraOut.get(v)];
  Q.insOf = (v) => [v < P.N ? P.ins[v] : null, extraIn.get(v)];
  return Q;
}

// Forward Dijkstra from S to T → arcs or null. Also returns the arcs it settled (for reachability).
function forward(Q: Query): Arcs | null {
  const dist = new Float64Array(Q.nA).fill(Infinity);
  const prev = new Int32Array(Q.nA).fill(-1);
  const heap = new (Heap as unknown as HeapClass)();
  for (const a of Q.sOut) {
    const d = Q.trans(-1, a) + Q.cost(a);
    if (d < dist[a]) { dist[a] = d; heap.push(d, a); }
  }
  let goal = -1;
  while (heap.k.length) {
    const a = heap.pop();
    const d = heap.lastKey;
    if (d > dist[a]) continue;
    const v = Q.to(a);
    if (v === Q.TN) { goal = a; break; }
    for (const list of Q.outsOf(v)) {
      if (!list) continue;
      for (const b of list) {
        if (!Q.usable(b) || Q.uturn(a, b)) continue;
        const nd = d + Q.trans(a, b) + Q.cost(b);
        if (nd < dist[b]) { dist[b] = nd; prev[b] = a; heap.push(nd, b); }
      }
    }
  }
  if (goal < 0) return null;
  const arcs: Arcs = [];
  for (let a = goal; a >= 0; a = prev[a]) arcs.push(a);
  arcs.reverse();
  arcs.cost = dist[goal];
  return arcs;
}

// Backward Dijkstra from T: g[a] = cost of arc a (from its start) to the end, nxt[a] = the arc after it
function backward(Q: Query) {
  const g = new Float64Array(Q.nA).fill(Infinity);
  const nxt = new Int32Array(Q.nA).fill(-1);
  const heap = new (Heap as unknown as HeapClass)();
  for (const t of Q.tIn) { const c = Q.cost(t); if (c < g[t]) { g[t] = c; heap.push(c, t); } }
  while (heap.k.length) {
    const b = heap.pop();
    const d = heap.lastKey;
    if (d > g[b]) continue;
    const v = Q.from(b);
    if (v === Q.SN) continue;
    for (const list of Q.insOf(v)) {
      if (!list) continue;
      for (const a of list) {
        if (!Q.usable(a) || Q.uturn(a, b)) continue;
        const nd = Q.cost(a) + Q.trans(a, b) + d;
        if (nd < g[a]) { g[a] = nd; nxt[a] = b; heap.push(nd, a); }
      }
    }
  }
  return { g, nxt };
}

// Nodes reachable from S through usable arcs
function reachable(Q: Query) {
  const seen = new Uint8Array(Q.P.N + 2), stack: number[] = [];
  for (const a of Q.sOut) { const v = Q.to(a); if (v < Q.P.N && !seen[v]) { seen[v] = 1; stack.push(v); } }
  while (stack.length) {
    const v = stack.pop()!;
    for (const b of Q.P.outs[v]) {
      if (!Q.usable(b)) continue;
      const w = Q.to(b);
      if (!seen[w]) { seen[w] = 1; stack.push(w); }
    }
  }
  return seen;
}

// Arcs → points, pieces and the facts the steps need
/** One piece of a route, pts[i] → pts[i + 1]: len along the slope, hlen in plan, time in seconds, l0 / l1 its levels. */
interface Seg { kind: StationEdgeKind; edge: number; len: number; hlen: number; time: number; dz: number; l0: number; l1: number; outdoor: boolean; warn: boolean }
function reconstruct(Q: Query, arcs: Arcs) {
  const { P, S, B, SN, TN, vE, vS0, vS1, vF, vT, vCs, vCd, src, dst } = Q;
  const pointOn = (e: number, s: number) => {
    const pa = P.nodes[P.EA[e]], pb = P.nodes[P.EB[e]];
    return [pa[0] + s * (pb[0] - pa[0]), pa[1] + s * (pb[1] - pa[1]), (pa[2] || 0) + s * ((pb[2] || 0) - (pa[2] || 0))];
  };
  const fromPoint = (id: number) => {
    if (id < B) return P.nodes[Q.from(id)].slice(0, 3);
    const j = id - B;
    if (vE[j] >= 0) return pointOn(vE[j], vS0[j]);
    return vF[j] === SN ? src[vCs[j]].point.slice() : P.nodes[vF[j]].slice(0, 3);
  };
  const toPoint = (id: number) => {
    if (id < B) return P.nodes[Q.to(id)].slice(0, 3);
    const j = id - B;
    if (vE[j] >= 0) return pointOn(vE[j], vS1[j]);
    return vT[j] === TN ? dst[vCd[j]].point.slice() : P.nodes[vT[j]].slice(0, 3);
  };
  const pts: XYL[] = [], segs: Seg[] = [], nodesOut: number[] = [];
  let used = 0, pendingTime = 0;
  const same = (p: XYL, q: XYL) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6 && Math.abs(p[2] - q[2]) < 1e-6;
  arcs.forEach((a, i) => {
    const p0 = fromPoint(a) as XYL, p1 = toPoint(a) as XYL;
    if (!pts.length) pts.push(p0);
    const to = Q.to(a), fromN = Q.from(a);
    if (!nodesOut.length && fromN < P.N) nodesOut.push(fromN);
    if (to < P.N && nodesOut[nodesOut.length - 1] !== to) nodesOut.push(to);
    const t = Q.trans(i ? arcs[i - 1] : -1, a, true) + Q.time(a);
    used |= Q.mask(a) & S.active;
    if (same(pts[pts.length - 1], p1)) { pendingTime += t; return; }
    const e = Q.edge(a), k = Q.kind(a);
    const hl = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const dzs = P.zf(p1[2]) - P.zf(p0[2]);
    const flat = e >= 0 ? P.L[e] * Q.frac(a) : hl;
    const len = k === LIFT ? 0 : (k === WALK && Math.abs(dzs) < 0.05) ? flat : Math.hypot(flat, dzs);
    segs.push({ kind: KIND_NAMES[k === NONE ? WALK : k] as StationEdgeKind, edge: e, len, hlen: hl, time: t + pendingTime, dz: dzs,
      l0: p0[2], l1: p1[2], outdoor: e >= 0 ? !!P.outdoor[e] : false, warn: !!(Q.mask(a) & S.active) });
    pendingTime = 0;
    pts.push(p1);
  });
  if (pendingTime && segs.length) segs[segs.length - 1].time += pendingTime;
  const first = arcs[0], last = arcs[arcs.length - 1];
  return { pts, segs, nodes: nodesOut, used, cost: arcs.cost,
    srcCand: first >= B ? src[vCs[first - B]] : src[0], dstCand: last >= B ? dst[vCd[last - B]] : dst[0] };
}

// ---------- Words ----------
const levelShort = (l: number) => (l < 0 ? '−' + -l : String(l));
const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);
const GENERIC = /^(the )?(underpass|subway|overpass|platforms?|platform level|terrace level|concourse level|mezzanine level|gallery level|shopping level|upper deck|lower deck|concourse|hall|station hall|main hall|ticket hall|passage|passageway|tunnel|footbridge|bridge|mezzanine|gallery|basement|lower level|upper level|lower floor|upper floor|ground floor|first floor|shopping level|shops|mall|shopping centre|car park|parking|bus station|tram stop|forecourt|square|station square|terrace|deck|roof|east wing|west wing|main underpass|east underpass|west underpass|north underpass|south underpass)$/;
// A name as it reads after "to" / "through": "Underpass" → "the underpass", "Underpass and shops" → "the underpass
// and shops", "Welle and gallery" → "Welle and the gallery", "PostAuto deck" → "the PostAuto deck",
// "Level -3" → "level −3", "RBS station" / "Bahnhofplatz" / "Grosse Schanze, lower terrace" unchanged.
const GENERIC_TAIL = /^[A-ZÄÖÜ][\w-]*\s+(deck|terrace|hall|underpass|overpass|passage|concourse|gallery|footbridge|mezzanine)$/;
function articledOne(name: string, first: boolean) {
  const n = String(name).trim(), low = n.toLowerCase();
  const lv = /^level\s*(-?\d+)$/.exec(low);
  if (lv) return `level ${levelShort(+lv[1])}`;
  if (/^(street|ground|track|platform) level$/.test(low)) return low;
  if (GENERIC.test(low)) return (first ? 'the ' : '') + low.replace(/^the /, '');
  if (first && !n.includes(',') && GENERIC_TAIL.test(n)) return 'the ' + n;
  return n;
}
function articled(name: string) {
  const parts = String(name).trim().split(/\s+and\s+/);
  if (parts.length === 1) return articledOne(parts[0], true);
  const firstGeneric = GENERIC.test(parts[0].trim().toLowerCase());
  return parts.map((p, i) => {
    if (i === 0) return articledOne(p, true);
    // "the underpass and shops" (one article for both), "Welle and the gallery"
    return GENERIC.test(p.trim().toLowerCase()) ? articledOne(p, !firstGeneric) : articledOne(p, false);
  }).join(' and ');
}
function levelObj(model: StationModel, level: number) {
  let best = null;
  for (const l of model.levels || []) if (!best || Math.abs(l.id - level) < Math.abs(best.id - level)) best = l;
  return best && Math.abs(best.id - level) < 0.5 ? best : null;
}
// Name of the nearest whole level ("the underpass", "level −3")
function levelName(model: StationModel, level: number) {
  const l = levelObj(model, level);
  return l && l.name ? articled(l.name) : `level ${levelShort(Math.round(level))}`;
}
const isNumRef = (r: string) => /^\d+$/.test(platformKey(r));
function platformRefs(area: StationArea) {
  const keys = [...new Set((area.refs || []).map(platformKey).filter(Boolean))];
  return keys.sort((a, b) => (+a || 0) - (+b || 0) || (a < b ? -1 : 1));
}
function nounFor(stop: { mode?: StationMode } | null | undefined) {
  const m = stop && stop.mode;
  return m === 'train' || m === 'cable' || m === 'cableway' || m === 'rack' || m === 'funicular' ? 'Platform' : m === 'boat' || m === 'ship' ? 'Pier' : 'Bay';
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const normName = (s: string) => String(s).toLowerCase().replace(/[^0-9a-zà-ÿ]+/g, ' ').trim();
// "Bern", "Bern, Hauptbahnhof", "Bern Bahnhof", "Bern Hbf" …: names that just say "this station"
function isStationName(P: Prepared, name: string) {
  if (!P.stationNames) {
    P.stationNames = new Set([P.model.name, ...(P.model.stops || []).map((s) => s.name)].filter(Boolean).map(normName));
  }
  const n = normName(name);
  if (P.stationNames.has(n)) return true;
  const base = normName(P.model.name || '');
  return !!base && new RegExp(`^${base} (bahnhof|hauptbahnhof|hbf|bhf|station|gare|stazione)$`).test(n);
}
const SQUARE = /(platz|place|square|plaza|piazza|hof)$/i;
/** What a stretch of a route is called in the steps. key: the same place has the same key. */
interface Place { key: string; kind: '' | 'platform' | 'plaza' | 'floor' | 'edge' | 'level'; text: string; prep: string; refs?: string[] }
const usefulName = (P: Prepared, n: string | undefined) => n && String(n).trim() && !isStationName(P, n);
const placeObj = (kind: Place['kind'], text: string, prep: string, refs?: string[]): Place => ({ key: text ? 'T' + text.toLowerCase() : '', kind, text, prep, refs });
function platformPlace(A: StationArea, keys: string[]) {
  const refs = platformRefs(A);
  if (!refs.length || !refs.every(isNumRef)) return null;
  const k = keys.find((x) => x && refs.includes(x));
  return Object.assign(placeObj('platform', `platform ${k || refs.join('/')}`, 'along', refs), { key: 'P' + refs.join('/') });
}
function areaPlace(P: Prepared, A: StationArea) {
  if (!A || !usefulName(P, A.name)) return null;
  const prep = A.kind === 'plaza' || SQUARE.test(A.name!) ? 'across' : A.kind === 'platform' ? 'along' : 'through';
  return placeObj(A.kind === 'plaza' ? 'plaza' : A.kind === 'platform' ? 'platform' : 'floor', articled(A.name!), prep, A.kind === 'platform' ? platformRefs(A) : undefined);
}
const edgePlace = (P: Prepared, ed: StationEdge | null) => (ed && usefulName(P, ed.name) ? placeObj('edge', articled(ed.name!), SQUARE.test(ed.name!) ? 'across' : 'along') : null);
function levelPlace(model: StationModel, lv: number) {
  const lr = Math.round(lv);
  if (lr === 0 || Math.abs(lv - lr) > 0.15) return null; // whole levels only; level 0 is the obvious one
  const l = levelObj(model, lr);
  if (!l || !l.name || /^level\s*-?\d+$/i.test(l.name.trim())) return null; // "Level 2" says nothing on a walk
  if (/^(street|ground|track|platform) level$/i.test(l.name.trim())) return null; // nor does "through platform level"
  return placeObj('level', articled(l.name), /(deck|terrace|square|platz|plaza)$/i.test(l.name) ? 'across' : 'through');
}

// Where a walk piece is: a train platform; indoors the named area containing it, then the edge's name; outdoors the
// street / square name of the edge first, then the area; last the name of its (whole) level. Never another level's.
function placeOf(P: Prepared, model: StationModel, p: XYL, q: XYL, edge: number, keys: string[]) {
  const lv = (p[2] + q[2]) / 2, x = (p[0] + q[0]) / 2, y = (p[1] + q[1]) / 2;
  const list = areasAt(P, x, y, lv);
  for (const A of list) if (A.kind === 'platform') { const pp = platformPlace(A, keys); if (pp) return pp; }
  const ed = edge >= 0 ? P.edges[edge] : null;
  let named = null;
  for (const A of list) { named = areaPlace(P, A); if (named) break; }
  const ep = edgePlace(P, ed);
  const outdoor = ed && ed.outdoor;
  return (outdoor ? ep || named : named || ep) || levelPlace(model, lv) || placeObj('', '', '');
}
// Where a level change arrives: the platform there; the named area containing the point; the name of the walk
// edges that follow; the level's name.
// Platform refs (numeric) of the train platforms whose nodes include the node at this point, e.g. ['12', '13']
const r2 = (v: number) => Math.round(v * 100) / 100;
function platformAtNode(P: Prepared, model: StationModel, pt: XYL) {
  if (!P.platNodes) {
    P.platNodes = new Map();
    for (const s of model.stops || []) {
      const k = platformKey(s.ref);
      if (!/^\d+$/.test(k)) continue;
      for (const n of stopNodes(P, model, s)) {
        const p = P.nodes[n], key = `${r2(p[0])},${r2(p[1])},${r2(p[2])}`;
        if (!P.platNodes.has(key)) P.platNodes.set(key, []);
        if (!P.platNodes.get(key)!.includes(k)) P.platNodes.get(key)!.push(k);
      }
    }
  }
  const ks = P.platNodes.get(`${r2(pt[0])},${r2(pt[1])},${r2(pt[2])}`);
  return ks ? ks.slice().sort((a, b) => (a as unknown as number) - (b as unknown as number)) : null;
}
/** What the walk after a level change starts on. */
interface WalkStart { firstPlatform: Place | null; edgeName: Place | null; firstArea: Place | null }
function arrivalPlace(P: Prepared, model: StationModel, pt: XYL, nextWalk: WalkStart | null, keys: string[]) {
  const list = areasAt(P, pt[0], pt[1], pt[2]);
  for (const A of list) if (A.kind === 'platform') { const pp = platformPlace(A, keys); if (pp) return pp; }
  const pk = platformAtNode(P, model, pt);
  if (pk) {
    const k = keys.find((x) => x && pk.includes(x));
    return Object.assign(placeObj('platform', `platform ${k || pk.join('/')}`, 'along', pk), { key: 'P' + pk.join('/') });
  }
  if (nextWalk && nextWalk.firstPlatform) return nextWalk.firstPlatform;
  for (const A of list) { const ap = areaPlace(P, A); if (ap) return ap; }
  // a lift door on the very edge of a floor lies in no area: the floor the walk from it starts on is where it arrives
  if (!list.length && nextWalk && nextWalk.firstArea) return nextWalk.firstArea;
  if (nextWalk && nextWalk.edgeName) return nextWalk.edgeName;
  const l = levelObj(model, pt[2]);
  return placeObj('level', l && l.name ? articled(l.name) : `level ${levelShort(Math.round(pt[2]))}`, 'through');
}

function turnOf(deg: number): StationRouteTurn {
  const a = Math.abs(deg);
  if (a < 30) return 'straight';
  if (a > 150) return 'around';
  if (a < 60) return deg > 0 ? 'bear-left' : 'bear-right';
  return deg > 0 ? 'left' : 'right';
}
const TURN_WORDS = { left: 'Turn left', right: 'Turn right', 'bear-left': 'Bear left', 'bear-right': 'Bear right', around: 'Turn around', straight: 'Keep straight on' };
const sectorText = (names: string[]) => (names.length === 1 ? `sector ${names[0]}` : `sectors ${names[0]}–${names[names.length - 1]}`);
const sectorShort = (names: string[]) => (names.length === 1 ? names[0] : `${names[0]}–${names[names.length - 1]}`);

// ---------- Steps ----------
/** A run of pieces segs[a] … segs[b − 1] that becomes one step. */
interface Run { kind: StationEdgeKind; dir: 'up' | 'down' | null; a: number; b: number; len: number }
/** The ends of the route, for the words of the steps. */
interface StepContext { toStop?: StationStop | null; fromStop?: StationStop | null; label?: string; toSectors?: string[] | false | null }
function buildSteps(P: Prepared, model: StationModel, pts: XYL[], segs: Seg[], ctx: StepContext) {
  const MIN_FRAG = 10, MIN_PLACE = 15, MIN_TURN = 20;
  // A level change is stairs, an escalator, a ramp or a lift; a sloping street is a walk
  const segDir = (s: Seg) => {
    if (s.kind === 'walk') return null;
    const dl = s.l1 - s.l0;
    if (Math.abs(dl) > 1e-6) return dl > 0 ? 'up' : 'down';
    if (Math.abs(s.dz) > 0.2) return s.dz > 0 ? 'up' : 'down';
    return null;
  };
  // 1. Runs of one kind and direction
  let runs: Run[] = [];
  segs.forEach((s, i) => {
    const d = segDir(s), r = runs[runs.length - 1];
    if (r && r.kind === s.kind && r.dir === d) { r.b = i + 1; r.len += s.len; }
    else runs.push({ kind: s.kind, dir: d, a: i, b: i + 1, len: s.len });
  });
  // 2. Tiny walk fragments: a landing between two flights joins them; otherwise it joins the level change next to it
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      if (r.kind !== 'walk' || r.len >= MIN_FRAG || runs.length === 1) continue;
      const p = runs[i - 1], n = runs[i + 1];
      if (p && n && p.kind === n.kind && p.dir === n.dir) {
        runs.splice(i - 1, 3, { kind: p.kind, dir: p.dir, a: p.a, b: n.b, len: p.len + r.len + n.len });
      } else if (p) {
        p.b = r.b; p.len += r.len; runs.splice(i, 1);
      } else if (n) {
        n.a = r.a; n.len += r.len; runs.splice(i, 1);
      } else continue;
      changed = true;
      break;
    }
  }
  // 3. Split long walks where the place changes or the path bends clearly
  const targetKey = ctx.toStop ? platformKey(ctx.toStop.ref) : '';
  const fromKey = ctx.fromStop ? platformKey(ctx.fromStop.ref) : '';
  const half = segs.reduce((a, s) => a + s.len, 0) / 2;
  let acc0 = 0;
  const keysAt: string[][] = [];
  const place = segs.map((s, i) => {
    const keys = acc0 < half ? [fromKey, targetKey] : [targetKey, fromKey];
    keysAt.push(keys);
    acc0 += s.len;
    return s.kind === 'walk' ? placeOf(P, model, pts[i], pts[i + 1], s.edge, keys) : null;
  });
  const heading = (i: number, back: boolean, limit: number[], win = 10) => {
    // direction over up to win m of horizontal path before (back) / after point i, within seg range limit [a, b)
    let d = 0, j = i;
    const [x, y] = pts[i];
    let px = x, py = y;
    for (;;) {
      const k = back ? j - 1 : j;
      if (k < limit[0] || k >= limit[1]) break;
      const s = segs[k];
      if (s.kind === 'elevator') break;
      j = back ? j - 1 : j + 1;
      px = pts[j][0]; py = pts[j][1];
      d += s.hlen;
      if (d >= win) break;
    }
    if (d < Math.min(2, win)) return NaN;
    return back ? Math.atan2(y - py, x - px) : Math.atan2(py - y, px - x);
  };
  const out: Run[] = [];
  for (const r of runs) {
    if (r.kind !== 'walk') { out.push(r); continue; }
    // by place
    let parts: { key: string; a: number; b: number; len: number }[] = [];
    for (let i = r.a; i < r.b; i++) {
      const k = place[i]!.key, last = parts[parts.length - 1];
      if (last && last.key === k) { last.b = i + 1; last.len += segs[i].len; }
      else parts.push({ key: k, a: i, b: i + 1, len: segs[i].len });
    }
    for (let changed = true; changed && parts.length > 1;) {
      changed = false;
      let mi = -1;
      parts.forEach((p, i) => { if (p.len < MIN_PLACE && (mi < 0 || p.len < parts[mi].len)) mi = i; });
      if (mi < 0) break;
      const p = parts[mi], prev = parts[mi - 1], next = parts[mi + 1];
      const into = !prev ? next : !next ? prev : (prev.len >= next.len ? prev : next);
      into.a = Math.min(into.a, p.a); into.b = Math.max(into.b, p.b); into.len += p.len;
      parts.splice(mi, 1);
      for (let i = 1; i < parts.length; i++) if (parts[i].key === parts[i - 1].key) { parts[i - 1].b = parts[i].b; parts[i - 1].len += parts[i].len; parts.splice(i, 1); i--; }
      changed = true;
    }
    // by bends
    for (const p of parts) {
      let start = p.a, along = 0, total = 0;
      for (let i = p.a; i < p.b; i++) total += segs[i].len;
      let acc = 0;
      const cut = [];
      for (let i = p.a + 1; i < p.b; i++) {
        acc += segs[i - 1].len;
        if (acc - along < MIN_TURN || total - acc < MIN_TURN) continue;
        const h1 = heading(i, true, [p.a, p.b]), h2 = heading(i, false, [p.a, p.b]);
        if (!(h1 === h1 && h2 === h2)) continue;
        const a = Math.abs(angleDiff(h1, h2)) * DEG;
        if (a < 45) continue;
        let bi = i, ba = a, acc2 = acc;
        for (let j = i + 1; j < p.b && acc2 + segs[j - 1].len - acc <= 10; j++) {
          acc2 += segs[j - 1].len;
          if (total - acc2 < MIN_TURN) break;
          const g1 = heading(j, true, [p.a, p.b]), g2 = heading(j, false, [p.a, p.b]);
          const aj = Math.abs(angleDiff(g1, g2)) * DEG;
          if (aj > ba) { ba = aj; bi = j; }
        }
        let accAtBi = acc;
        for (let j = i; j < bi; j++) accAtBi += segs[j].len;
        cut.push(bi);
        along = accAtBi; acc = accAtBi; i = bi;
      }
      cut.push(p.b);
      for (const c of cut) {
        let len = 0;
        for (let i = start; i < c; i++) len += segs[i].len;
        out.push({ kind: 'walk', dir: null, a: start, b: c, len });
        start = c;
      }
    }
  }
  runs = out;

  // 4. Text
  const steps: StationRouteStep[] = [];
  const sumT = (r: Run) => { let t = 0; for (let i = r.a; i < r.b; i++) t += segs[i].time; return t; };
  // the place covering most of a walk's length
  const bestPlace = (r: Run) => {
    const m = new Map<string, number>();
    for (let i = r.a; i < r.b; i++) { const p = place[i]; if (p) m.set(p.key, (m.get(p.key) || 0) + segs[i].len); }
    let bk: string | null = null, bl = -1;
    m.forEach((l, k) => { if (l > bl) { bl = l; bk = k; } });
    for (let i = r.a; i < r.b; i++) if (place[i] && place[i]!.key === bk) return place[i];
    return null;
  };
  // what a walk starts on: the platform of its first ~10 m, the named floor or square of its first piece, the
  // first edge name in its first ~60 m
  const walkStart = (r: Run | undefined): WalkStart | null => {
    if (!r || r.kind !== 'walk') return null;
    let d = 0, firstPlatform = null, edgeName = null, firstArea = null;
    for (let i = r.a; i < segs.length && segs[i].kind === 'walk' && d < 60; i++) {
      if (d < 10 && !firstPlatform && place[i] && place[i]!.kind === 'platform' && place[i]!.text) firstPlatform = place[i];
      if (i === r.a && place[i] && (place[i]!.kind === 'floor' || place[i]!.kind === 'plaza') && place[i]!.text) firstArea = place[i];
      if (!edgeName && segs[i].edge >= 0) edgeName = edgePlace(P, P.edges[segs[i].edge]);
      d += segs[i].len;
    }
    return { firstPlatform, edgeName, firstArea };
  };
  const lastWalk = (() => { for (let i = runs.length - 1; i >= 0; i--) if (runs[i].kind === 'walk') return i === runs.length - 1 ? i : -1; return -1; })();
  const endPt = pts[pts.length - 1];
  // sector at the end: only the aimed ones (a platform as a whole is reached where the route first gets to it;
  // route.toAssumed says where that is)
  let arriveSector: { names: string[]; aimed: boolean } | null = null;
  if (ctx.toSectors && ctx.toSectors.length) arriveSector = { names: ctx.toSectors, aimed: true };
  let lastPlaceText: string | null = null;
  runs.forEach((r, ri) => {
    const from = r.a, to = r.b;
    const level = pts[from][2], toLevel = pts[to][2];
    const st: StationRouteStep = { kind: r.kind, from, to, level, toLevel, dir: r.dir, len: Math.round(r.len), seconds: Math.round(sumT(r)), text: '' };
    if (segs.slice(r.a, r.b).some((s) => s.warn)) st.warn = true;
    // turn hint from the geometry around the start of this step
    let turn = null;
    if (ri > 0 && r.kind !== 'elevator' && runs[ri - 1].kind !== 'elevator') {
      const pr = runs[ri - 1];
      // a level change: the way its first piece points (stairs turn on their landings)
      const h1 = heading(from, true, [pr.a, pr.b]), h2 = heading(from, false, r.kind === 'walk' ? [r.a, r.b] : [r.a, r.a + 1], r.kind === 'walk' ? 10 : 0.3);
      if (h1 === h1 && h2 === h2) turn = turnOf(angleDiff(h1, h2) * DEG);
    }
    if (turn) st.turn = turn;
    if (r.kind === 'walk') {
      const pl = bestPlace(r);
      let tail = '';
      if (pl && pl.text) {
        st.place = pl.text;
        // the same place as the walk just before it (split at a bend): say it once
        const prevWalk = ri > 0 && runs[ri - 1].kind === 'walk';
        if (!(prevWalk && lastPlaceText === pl.text)) tail = ` ${pl.prep ? pl.prep + ' ' : ''}${pl.text}`;
      }
      if (ri === lastWalk && arriveSector && pl && pl.kind === 'platform') {
        // only when the walk actually goes some way along the platform
        const s0 = pts[from];
        if (Math.hypot(endPt[0] - s0[0], endPt[1] - s0[1]) > 12) tail += ` to ${sectorText(arriveSector.names)}`;
      }
      const d = fmtDist(r.len);
      if (turn === 'straight' && ri > 0 && runs[ri - 1].kind === 'walk') st.text = `Keep straight on for ${d}${tail}`;
      else if (turn && turn !== 'straight') st.text = `${TURN_WORDS[turn]} and walk ${d}${tail}`;
      else st.text = `Walk ${d}${tail}`;
      lastPlaceText = pl && pl.text ? pl.text : null;
    } else {
      const noun = { stairs: 'the stairs', escalator: 'the escalator', ramp: 'the ramp', elevator: 'the lift' }[r.kind];
      let dest = '';
      const fromL = Math.round(level), toL = Math.round(toLevel);
      if (fromL !== toL) {
        const ap = arrivalPlace(P, model, pts[to], walkStart(runs[ri + 1]), [targetKey]);
        dest = ` to ${ap.text}`;
        st.place = ap.text;
      }
      const verb = r.kind === 'stairs' && fromL === toL && r.len < 6 ? `take the steps` : `take ${noun}`;
      const dir = r.dir ? ` ${r.dir}` : '';
      const pre = turn === 'left' || turn === 'right' || turn === 'around' ? `${TURN_WORDS[turn]} and ` : '';
      st.text = cap(`${pre}${verb}${dir}${dest}`);
      lastPlaceText = null;
    }
    steps.push(st);
  });
  // 5. Arrive
  const last = pts.length - 1;
  let label = ctx.label || 'Arrive';
  if (arriveSector && arriveSector.aimed) label += `, ${sectorText(arriveSector.names)}`;
  const arrive: StationRouteStep = { kind: 'arrive', from: last, to: last, level: pts[last][2], toLevel: pts[last][2], dir: null, len: 0, seconds: 0, text: label };
  if (arriveSector) arrive.sector = sectorShort(arriveSector.names);
  steps.push(arrive);
  return steps;
}

function endLabel(model: StationModel, cand: End | null | undefined) {
  if (!cand) return null;
  let s = cand.stop;
  if (!s && cand.node != null) s = (model.stops || []).find((x) => x.node === cand.node);
  if (s) return s.ref ? `${nounFor(s)} ${s.ref}` : s.name || null;
  let en = cand.entrance;
  if (!en && cand.node != null) en = (model.entrances || []).find((x) => x.node === cand.node);
  if (en) return en.name || 'Exit';
  return null;
}
// metres from a point to a sector's stretch of platform (its span, else its sign)
function sectorDist(P: Prepared, model: StationModel, key: string, name: string, pt: XYL) {
  let d = Infinity;
  for (const sp of model.sectorSpans || []) if (sp && sp.a && sp.b && platformKey(sp.ref) === key && String(sp.name) === name) d = Math.min(d, distToLine([sp.a, sp.b], pt[0], pt[1]));
  for (const s of sectorsOf(model, key)) if (String(s.name) === name) { const xy = s.xy || P.nodes[s.node!]; d = Math.min(d, Math.hypot(xy[0] - pt[0], xy[1] - pt[1])); }
  return d;
}
// { sector?, xy, text }: "from the stairs at sector B", "to the lift", "from sector A"
const CONN_NOUN = { stairs: 'the stairs', escalator: 'the escalator', ramp: 'the ramp', elevator: 'the lift' };
function assumed(P: Prepared, model: StationModel, stop: StationStop, pt: XYL, segs: Seg[], atStart: boolean) {
  const o = { xy: [Math.round(pt[0] * 100) / 100, Math.round(pt[1] * 100) / 100] } as StationRouteAssumed; // text: below
  const key = platformKey(stop.ref);
  // the sector whose stretch of platform (model.sectorSpans) the point is on, else the nearest sector sign
  let best = null, bd = Infinity;
  for (const sp of (model.sectorSpans || []).filter((x) => x && x.a && x.b && platformKey(x.ref) === key)) {
    const d = distToLine([sp.a, sp.b], pt[0], pt[1]);
    if (d < bd) { bd = d; best = sp; }
  }
  if (!best || bd > 30) {
    best = null; bd = Infinity;
    for (const s of sectorsOf(model, key)) {
      const xy = s.xy || P.nodes[s.node!];
      const d = Math.hypot(xy[0] - pt[0], xy[1] - pt[1]);
      if (d < bd) { bd = d; best = s; }
    }
  }
  if (best) o.sector = String(best.name);
  // the level change the route takes right there (within the first / last 15 m of walking)
  let conn = null, d = 0;
  const order = atStart ? segs : segs.slice().reverse();
  for (const s of order) {
    if (s.kind !== 'walk') { conn = s.kind; break; }
    d += s.len;
    if (d > 15) break;
  }
  const where = conn ? CONN_NOUN[conn] : null;
  const pre = atStart ? 'from' : 'to';
  const noun = nounFor(stop) === 'Platform' ? 'platform' : 'stop';
  o.text = where ? `${pre} ${where}${o.sector ? ` at sector ${o.sector}` : ''}` : o.sector ? `${pre} sector ${o.sector}`
    : atStart ? `from the end of the ${noun} nearest your way` : `to the end of the ${noun} you reach first`;
  return o;
}
const stopOf = (model: StationModel, c: End | null | undefined) => c && (c.stop || (c.node != null ? (model.stops || []).find((x) => x.node === c.node) : null));

// ---------- route ----------
// The search part shared by route() and why(): { r, Q, closures, incomplete } or { fail: reason }
type Walked = ReturnType<typeof reconstruct>;
/** What plan() gives: why there is no route, or the search and the path it found. */
type Plan = { fail: StationRouteWhy }
  | { fail?: undefined; P: Prepared; S: SearchSettings; Q: Query; r: Walked; closures: StationRouteClosure[]; incomplete: boolean; through: boolean; src: End[]; dst: End[] };
function plan(model: StationModel, from: Endpoint, to: Endpoint, prefs: Prefs): Plan {
  if (!model || !model.graph) return { fail: 'unknown-position' };
  const P = prepare(model);
  const S = settings(prefs);
  const C = closedFor(P, S.date);
  const src = resolve(model, from, S.date), dst = resolve(model, to, S.date);
  const unknown = (ep: Endpoint): StationRouteWhy => (ep && ep.stop ? 'unknown-stop' : ep && ep.entrance != null ? 'unknown-entrance' : ep && ep.node != null ? 'unknown-node' : 'unknown-position');
  if (!src.length) return { fail: unknown(from) };
  if (!dst.length) return { fail: unknown(to) };
  const closures: StationRouteClosure[] = [];
  const seenObj = new Set(), seenKey = new Set();
  // one entry per closure: the same thing (or the same note) on several edges / connectors is listed once
  const addClosure = (s: ClosureSource) => {
    if (seenObj.has(s.obj)) return;
    seenObj.add(s.obj);
    const o = closureEntry(s, model);
    const key = o.note ? `${o.what === 'stop' || o.what === 'entrance' ? o.what + o.ref + o.name : 'way'}|${o.note}` : `${o.what}|${o.kind}|${o.name}|${o.ref}|${o.until}`;
    if (seenKey.has(key)) return;
    seenKey.add(key);
    closures.push(o);
  };
  // closed endpoints: still routed to (the traveller asked for them), but said
  for (const c of [src[0], dst[0]]) {
    if (c.closedStop) addClosure({ what: 'stop', obj: c.stop!, name: c.stop!.name || '' });
    if (c.closedEntrance) addClosure({ what: 'entrance', obj: c.entrance!, name: c.entrance!.name || '' });
  }
  let Q = makeQuery(P, S, C.any ? C.mask : null, src, dst);
  let arcs = forward(Q);
  let incomplete = false;
  if (C.any) {
    // the way it would go without closures: what is closed on it (a detour, or what cuts it off)
    const Q0 = makeQuery(P, S, null, src, dst);
    const arcs0 = forward(Q0);
    if (!arcs0) return { fail: 'not-connected' };
    const blocking = [];
    for (const a of arcs0) { const e = Q0.edge(a); if (e >= 0 && C.mask[e]) for (const s of C.by.get(e) || []) blocking.push(s); }
    if (!arcs) {
      // only closed ways lead there: go as close as possible
      incomplete = true;
      const seen = reachable(Q);
      const target = dst[0].point;
      let best = -1, bd = Infinity;
      for (let v = 0; v < P.N; v++) {
        if (!seen[v]) continue;
        const p = P.nodes[v];
        const d = Math.hypot(p[0] - target[0], p[1] - target[1]) + 15 * Math.abs(p[2] - target[2]);
        if (d < bd) { bd = d; best = v; }
      }
      const startNodes = new Set(src.map((c) => (c.node != null ? c.node : -1)));
      if (best < 0 || startNodes.has(best)) {
        // the start itself is shut in (you are on a closed platform, say): you still have to get out, so take the
        // way through the closure and say so
        Q = Q0; arcs = arcs0; incomplete = false;
        Q.through = true;
      } else {
        const near = [{ node: best, point: P.nodes[best].slice(0, 3) as XYL, dist: 0 }];
        Q = makeQuery(P, S, C.mask, src, near);
        arcs = forward(Q);
        if (!arcs) return { fail: 'closed' };
        Q.wantedPoint = target;
        Q.wanted = dst[0];
      }
    }
    for (const s of blocking) addClosure(s);
  } else if (!arcs) return { fail: 'not-connected' };
  const r = reconstruct(Q, arcs);
  return { P, S, Q, r, closures, incomplete, through: !!Q.through, src, dst };
}

function route(model: StationModel, from: Endpoint, to: Endpoint, prefs?: Prefs): StationRouteResult | null {
  const pl = plan(model, from, to, prefs);
  if (pl.fail) return null;
  const { P, S, Q, r, closures, incomplete } = pl;
  let { pts, segs } = r;
  const dc = incomplete ? Q.wanted! : r.dstCand, sc = r.srcCand;
  const toStop = stopOf(model, dc), fromStop = stopOf(model, sc);
  const same = !incomplete && segs.length === 0;
  const still = segs.length === 0; // nothing to walk: same place, or shut in by closures
  let label = endLabel(model, dc) || 'Arrive';
  if (still) pts = [pts[0], pts[0].slice() as XYL];
  if (incomplete) label = 'As close as the route can get';
  if (same) {
    // a change on the same platform (or two stop edges at one node): a drawable route of two equal points
    const k1 = fromStop ? platformKey(fromStop.ref) : '', k2 = toStop ? platformKey(toStop.ref) : '';
    if (toStop && (!fromStop || k1 === k2)) label = toStop.ref ? `Stay ${nounFor(toStop) === 'Platform' ? 'on' : 'at'} ${nounFor(toStop).toLowerCase()} ${toStop.ref}` : `You are at ${toStop.name || 'the stop'}`;
    else if (toStop) label = nounFor(toStop) === 'Platform' ? `${label} is across the same platform` : `${label} is at the same stop`;
    else label = `You are at ${label === 'Arrive' ? 'the destination' : label}`;
  }
  let steps: StationRouteStep[];
  if (still) {
    steps = [{ kind: 'arrive', from: 0, to: 1, level: pts[0][2], toLevel: pts[1][2], dir: null, len: 0, seconds: 0, text: label }];
  } else {
    steps = buildSteps(P, model, pts, segs, { toStop: incomplete ? null : toStop, fromStop, label, toSectors: !incomplete && dc && dc.sectors });
  }
  const dists = [0];
  let length = 0, seconds = 0;
  for (const s of segs) { length += s.len; seconds += s.time; dists.push(Math.round(length * 100) / 100); }
  if (still) dists.push(0);
  const rd = (v: number) => Math.round(v * 100) / 100;
  const out: StationRouteResult = {
    points: pts.map((p) => [rd(p[0]), rd(p[1]), rd(p[2])]),
    nodes: r.nodes,
    length: Math.round(length),
    seconds: Math.round(seconds),
    steps,
    dists,
    edges: still ? [-1] : segs.map((s) => s.edge),
    fromDist: rd(sc && sc.dist || 0),
    toDist: rd(incomplete ? Math.hypot(pts[pts.length - 1][0] - Q.wantedPoint![0], pts[pts.length - 1][1] - Q.wantedPoint![1]) : (dc && dc.dist) || 0),
  };
  if (same) out.same = true;
  // Where on a whole platform the route was taken to start / end
  if (!same && sc && sc.onPlatform) {
    out.fromAssumed = assumed(P, model, sc.stop!, pts[0], segs, true);
    // name the sector the way sectorTimes does (from each sector's middle), when the start is at that sector
    const fa = out.fromAssumed;
    if (fa.sector && from && from.stop) {
      const st = sectorTimes(model, { stop: { uic: from.stop.uic, ref: platformKey(sc.stop!.ref) } }, to, prefs);
      if (st && st.best !== fa.sector && sectorDist(P, model, platformKey(sc.stop!.ref), st.best, pts[0]) <= 25) {
        fa.text = fa.text.replace(`sector ${fa.sector}`, `sector ${st.best}`);
        fa.sector = st.best;
      }
    }
  }
  if (!same && !incomplete && dc && dc.onPlatform) out.toAssumed = assumed(P, model, dc.stop!, pts[pts.length - 1], segs, false);
  if (fromStop && sc.stop) out.fromStop = fromStop;
  if (toStop && dc.stop) out.toStop = toStop;
  if (sc && sc.sectors) out.fromSectors = sc.sectors;
  if (dc && dc.sectors && !incomplete) out.toSectors = dc.sectors;
  const sentences = [];
  const relaxed: StationRouteRelaxed[] = [];
  if (r.used & (V_WCF | V_STEEP) || (S.wheel && r.used & (V_STAIRS | V_ESC))) relaxed.push('wheelchair');
  if (S.stepFree && r.used & (V_STAIRS | V_ESC)) relaxed.push('stepFree');
  if (S.noEsc && r.used & V_ESC) relaxed.push('noEscalators');
  if (relaxed.length) {
    out.relaxed = relaxed;
    const what = [];
    if (r.used & V_STAIRS) what.push('stairs');
    if (r.used & V_ESC) what.push('an escalator');
    if (r.used & V_WCF) what.push('a part marked not suitable for wheelchairs');
    if (r.used & V_STEEP) what.push('a steep slope');
    const lead = S.wheel ? 'No wheelchair-accessible way here' : S.stepFree ? 'No step-free way here' : 'No way here without escalators';
    sentences.push(`${lead}: this route has ${what.join(' and ')}.`);
  }
  if (closures.length) {
    out.closed = closures;
    // the stop or entrance first, then what the route goes around; two sentences at most
    // a stop without its own note, on a closed platform area that says it already: one sentence
    const said = closures.filter((c) => !(c.what === 'stop' && !c.note && closures.some((a) => a.what === 'area' && a.ref && a.ref.split('/').includes(platformKey(c.ref)))));
    const texts = [...new Set(said.map((c) => closureSentence(c, model)))];
    sentences.push(...texts.slice(0, 2));
    if (incomplete) sentences.push('This route goes as close as it can.');
    if (pl.through) sentences.push('The way out goes through the closed part.');
  }
  if (incomplete) out.incomplete = true;
  if (pl.through) out.throughClosed = true;
  if (sentences.length) out.notice = sentences.join(' ');
  return out;
}

function why(model: StationModel, from: Endpoint, to: Endpoint, prefs?: Prefs): StationRouteWhy | null {
  const pl = plan(model, from, to, prefs);
  if (pl.fail) return pl.fail;
  return pl.incomplete || pl.through ? 'closed' : null;
}

// ---------- Sector times ----------
/** A sector's walk, with the search cost the sectors are compared by (taken off before they are returned). */
type SectorWalk = StationRouteSectorTime & { _cost?: number };
function sectorTimes(model: StationModel, from: Endpoint, to: Endpoint, prefs?: Prefs): StationRouteSectorTimes | null {
  if (!model || !model.graph || !from || !from.stop) return null;
  const P = prepare(model);
  const S = settings(prefs);
  const C = closedFor(P, S.date);
  const key = platformKey(from.stop.ref);
  const plat = resolve(model, { stop: { uic: from.stop.uic, ref: key } }, S.date);
  if (!plat.length) return null;
  const level = plat[0].stop!.level != null ? plat[0].stop!.level : plat[0].point[2];
  const secs = sectorsOf(model, key);
  if (!secs.length) return null;
  const cands: End[] = [], names: string[] = [];
  for (const s of secs) {
    const aim = sectorAim(P, model, key, { list: [String(s.name).toUpperCase()] }, level, C.any ? C.mask : null);
    if (aim) { cands.push(aim); names.push(String(s.name)); }
  }
  if (!cands.length) return null;
  const dst = resolve(model, to, S.date);
  if (!dst.length) return null;
  const Q = makeQuery(P, S, C.any ? C.mask : null, cands, dst);
  const { g, nxt } = backward(Q);
  const out: SectorWalk[] = [];
  cands.forEach((c, ci) => {
    let best = -1, bv = Infinity;
    for (const a of Q.sOut) {
      if (Q.vCs[a - Q.B] !== ci || !(g[a] < Infinity)) continue;
      const v = Q.trans(-1, a) + g[a];
      if (v < bv) { bv = v; best = a; }
    }
    if (best < 0) return;
    const arcs: Arcs = [];
    for (let a = best; a >= 0; a = nxt[a]) arcs.push(a);
    arcs.cost = bv;
    const r = reconstruct(Q, arcs);
    let length = 0, seconds = 0;
    for (const s of r.segs) { length += s.len; seconds += s.time; }
    const conn = r.segs.find((s) => s.kind !== 'walk');
    const e: SectorWalk = { name: names[ci], seconds: Math.round(seconds), length: Math.round(length), via: conn ? conn.kind as StationRouteConnectorKind : null };
    if (r.used) e.warn = true;
    e._cost = bv;
    out.push(e);
  });
  if (!out.length) return null;
  let best = out[0];
  for (const e of out) if (e._cost! < best._cost! - 1e-6 || (Math.abs(e._cost! - best._cost!) <= 1e-6 && e.seconds < best.seconds)) best = e;
  const secsList = out.map((e) => e.seconds);
  out.forEach((e) => { delete e._cost; });
  return { best: best.name, sectors: out, spreadSeconds: Math.max(...secsList) - Math.min(...secsList) };
}

// ---------- Position on a route ----------
function dists(route: StationRoutePath) {
  if (route.dists && route.dists.length === route.points.length) return route.dists;
  const d = [0];
  for (let i = 1; i < route.points.length; i++) {
    const p = route.points[i - 1], q = route.points[i];
    d.push(d[i - 1] + Math.hypot(q[0] - p[0], q[1] - p[1]));
  }
  return d;
}
const climbCache = new WeakMap<StationRoutePath, number[]>();
function climbs(route: StationRoutePath) {
  let c = climbCache.get(route);
  if (c && c.length === route.points.length) return c;
  const pts = route.points;
  c = [0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    const flat = Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.05; // a lift
    c.push(c[i - 1] + (flat ? 0 : Math.abs(q[2] - p[2])));
  }
  climbCache.set(route, c);
  return c;
}
function stepAt(route: StationRoutePath, index: number) {
  const st = route.steps || [];
  for (let i = 0; i < st.length; i++) if (st[i].kind !== 'arrive' && index >= st[i].from && index < st[i].to) return i;
  return Math.max(0, st.length - 1);
}

/** The hint of snap() once it is known to carry a previous position. */
type PrevSnap = StationRouteSnapHint & { along: number };
interface SnapBest { score: number; index: number; t: number; point: XYL; dist: number; along: number }
function snap(model: StationModel, route: StationRoutePath | null | undefined, xy: StationRouteXY | { ll: LngLat }, hint?: number | StationRouteSnapHint | null): StationRouteSnap | null {
  if (!route || !route.points || !route.points.length) return null;
  if (xy && !Array.isArray(xy) && xy.ll) xy = toLocal(model, xy.ll);
  const pts = route.points, D = dists(route), total = D[D.length - 1];
  let hl = null, prev: PrevSnap | null = null;
  // A previous result keeps the position continuous along the route (which also keeps it on the right one of two
  // floors that overlap in plan, and lets it change floor in a lift); a level number only when the caller knows it.
  if (typeof hint === 'number' && isFinite(hint)) hl = hint;
  else if (hint && typeof hint === 'object') {
    if (isFinite(hint.along!)) prev = hint as PrevSnap;
    if (isFinite(hint.level!)) hl = +hint.level!;
  }
  const x = (xy as StationRouteXY)[0], y = (xy as StationRouteXY)[1];
  if (pts.length === 1) {
    return { index: 0, t: 0, point: pts[0].slice() as XYL, dist: Math.hypot(x - pts[0][0], y - pts[0][1]), along: 0, remaining: 0, step: stepAt(route, 0) };
  }
  // climb[i]: levels changed on stairs, escalators, ramps and slopes before point i (lifts do not count: they have
  // no length, so the next fix can be on the new floor). Between two fixes the floor may change only by about as
  // much as the route climbs in between, so a fix cannot hop onto the floor above or below.
  const CL = climbs(route);
  const climbAt = (i: number, t: number) => CL[i] + t * (CL[i + 1] - CL[i]);
  const LA = []; // pieces that are lift rides (no length, change of level)
  for (let i = 0; i + 1 < pts.length; i++) {
    if (Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) < 0.05 && Math.abs(pts[i + 1][2] - pts[i][2]) > 0.3) LA.push(i);
  }
  let prevClimb = 0;
  if (prev) {
    let pi = Number.isInteger(prev.index) && prev.index! >= 0 && prev.index! < pts.length - 1 ? prev.index! : -1, pt = isFinite(prev.t!) ? prev.t! : 0;
    if (pi < 0) {
      pi = 0;
      while (pi < pts.length - 2 && D[pi + 1] < prev.along) pi++;
      pt = D[pi + 1] > D[pi] ? Math.min(1, Math.max(0, (prev.along - D[pi]) / (D[pi + 1] - D[pi]))) : 0;
    }
    prevClimb = climbAt(pi, pt);
    if (!Number.isInteger(prev.index)) prev = Object.assign({}, prev, { index: pi });
  }
  let best: SnapBest | null = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy;
    let t;
    if (l2 > 1e-6) t = ((x - p[0]) * dx + (y - p[1]) * dy) / l2;
    else if (hl != null && q[2] !== p[2]) t = (hl - p[2]) / (q[2] - p[2]);
    else if (prev) t = prev.index! >= i ? 1 : 0; // in a lift: at the floor you are going to once past it
    else t = 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = p[0] + t * dx, py = p[1] + t * dy, lv = p[2] + t * (q[2] - p[2]);
    const d = Math.hypot(x - px, y - py);
    const along = D[i] + t * (D[i + 1] - D[i]);
    let score = d;
    if (hl != null) score += 10 * Math.max(0, Math.abs(lv - hl) - 0.3);
    if (prev) {
      const jump = along - prev.along;
      // going back counts from the furthest point reached so far, so noise cannot creep the dot backwards
      const back = Math.max(-jump, (isFinite(prev.progress!) ? prev.progress! : prev.along) - along);
      if (back > 3) score += 0.5 * (back - 3);
      else if (jump > 30) score += 0.2 * (jump - 30);
      const hop = Math.abs(climbAt(i, t) - prevClimb);
      if (hop > 0.3) score += 15 * (hop - 0.3);
      // through a lift only from the lift: a fix still walking towards it cannot already be on the floor it serves
      for (const li of LA) {
        const la = D[li];
        if (prev.index! < li && i > li) score += Math.max(0, la - prev.along - 5);
        else if (prev.index! > li && i < li) score += Math.max(0, prev.along - la - 5);
      }
    }
    if (!best || score < best.score - 1e-9) best = { score, index: i, t, point: [px, py, lv], dist: d, along };
  }
  const progress = Math.max(best!.along, prev ? (isFinite(prev.progress!) ? prev.progress! : prev.along) : 0);
  return { index: best!.index, t: best!.t, point: best!.point, dist: best!.dist, along: best!.along, remaining: Math.max(0, total - best!.along), step: stepAt(route, best!.index), progress };
}

function pointAt(route: StationRoutePath, m: number): XYL | null {
  const pts = route.points, D = dists(route);
  if (!pts.length) return null;
  if (!(m > 0)) return pts[0].slice() as XYL;
  if (m >= D[D.length - 1]) return pts[pts.length - 1].slice() as XYL;
  let lo = 0, hi = D.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (D[mid] <= m) lo = mid; else hi = mid; }
  const seg = D[hi] - D[lo], t = seg > 0 ? (m - D[lo]) / seg : 0;
  const p = pts[lo], q = pts[hi];
  return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])];
}

export const StationRoute: StationRouteApi = { toLocal, toLngLat, z, route, snap, pointAt, sectorTimes, why, isClosed, notices, resolve, platformKey, levelName, TIME };
