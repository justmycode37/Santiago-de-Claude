// Which coach to take on a train ride, chosen once for the whole ride: the one with the shortest walk to its door
// where you get on plus from its door where you get off, among the coaches that suit you (your class, open, a
// wheelchair space when you need one, in the part of a train that splits that goes where you get off). The same
// choice is shown wherever the 3D view opens: at the boarding platform (the walk leads into the coach), at the
// alighting platform (the walk starts from it) and at a change (from the coach you arrive in to the one you take).
// docs/train-formation.md
//
//   planCoach(train, ctx) → Promise<CoachPlan | null>     null: not a train, or nothing to choose from
//   pickCoach(candidates) → id | null                      (pure: the tests use it)
//   doorsOf(layout, idx) → Door[]                          a coach's doors on the platform, as the view draws them
//
// Crowding does not take part: the occupancy forecast is one figure per class for the whole train (no open source
// has it per coach), so it cannot tell two coaches of your class apart. The card shows it as it is.
import { coachesAt, coachesFor, formationFor } from './train-formation.ts';
import type { Station3DTrain, TrainCoach, TrainEngine, TrainPickMissing } from './train-formation.ts';
import { layoutTrain } from './train-layout.ts';
import type { TrainLayout } from './train-layout.ts';
import type { StationRoute, StationRouteEndpoint, StationRoutePrefs } from './station-route.ts';

/** A door's middle from the end of its coach (m; from a driving end with its sloped nose, NOSE_DOOR_M), and its spot
 *  on the platform from the middle of the track (m). The renderer draws the doors at the same places. */
export const DOOR_IN_M = 2.9;
export const NOSE_DOOR_M = 4.4;
export const DOOR_SIDE_M = 2.6;

/** A coach door: where along the platform (s), the spot on the platform in front of it, and the coach's inside. */
export interface Door { s: number; xy: XY; inside: XY; sector: string | null }
/** Where you get on or off the chosen coach, and the walk weighed there (seconds; null: not weighed). */
export interface CoachEnd { idx: number; door: Door | null; seconds: number | null }
export interface CoachPlan {
  coachId: string | null;
  board: CoachEnd | null;
  alight: CoachEnd | null;
  /** Why no coach is chosen. */
  missing: TrainPickMissing | 'unreachable' | 'unmatched' | null;
  /** The walks the choice weighed: to the train ('in'), from it ('out'). */
  weighed: ('in' | 'out')[];
}
export interface CoachPlanContext {
  engine: TrainEngine;
  /** A station model and the router (Station3D.loadData); null when it cannot be had. */
  loadModel(key: string): Promise<StationModel | null>;
  router(): typeof StationRoute | null;
  cls: 1 | 2;
  prefs: StationRoutePrefs | null;
}

/** The doors of coach `idx` (an index into the coaches the layout was made from): none for a locomotive. */
export function doorsOf(layout: TrainLayout, idx: number): Door[] {
  const car = layout.cars.find((c) => c.idx === idx);
  if (!car || !car.coach || car.coach.kind === 'loco' || car.coach.kind === 'luggage' || car.coach.kind === 'other') return [];
  const L = car.s1 - car.s0, ia = car.noseA ? NOSE_DOOR_M : DOOR_IN_M, ib = car.noseB ? NOSE_DOOR_M : DOOR_IN_M;
  const at = L > ia + ib + 2 ? [car.s0 + ia, car.s1 - ib] : [(car.s0 + car.s1) / 2];
  return at.map((s) => {
    const p = layout.at(s);
    const sec = layout.sectors.find((x) => s >= Math.min(x.s0, x.s1) && s <= Math.max(x.s0, x.s1));
    return { s, xy: [p[0] + layout.side[0] * DOOR_SIDE_M, p[1] + layout.side[1] * DOOR_SIDE_M] as XY, inside: p, sector: sec ? sec.name : null };
  });
}

/** The candidate with the shortest walk in plus out. A side weighed for some candidates rules out those it has no
 *  way for (Infinity); a side weighed for none (null everywhere) does not count. Ties: the shorter walk in, then
 *  the order given. */
export function pickCoach(cands: { id: string; inS: number | null; outS: number | null }[]): string | null {
  const weighIn = cands.some((c) => c.inS != null), weighOut = cands.some((c) => c.outS != null);
  const ok = cands.filter((c) => (!weighIn || (c.inS != null && Number.isFinite(c.inS))) && (!weighOut || (c.outS != null && Number.isFinite(c.outS))));
  if (!ok.length) return null;
  const tot = (c: { inS: number | null; outS: number | null }) => (weighIn ? c.inS! : 0) + (weighOut ? c.outS! : 0);
  let best = ok[0];
  for (const c of ok.slice(1)) if (tot(c) < tot(best) - 0.5 || (Math.abs(tot(c) - tot(best)) <= 0.5 && (c.inS ?? 0) < (best.inS ?? 0))) best = c;
  return best.id;
}

const plans = new Map<string, Promise<CoachPlan | null>>();
const prefsKey = (ctx: CoachPlanContext) => { const p = ctx.prefs || {}; return [ctx.cls, p.wheelchair ? 'w' : '', p.stepFree ? 's' : '', p.fewerStairs ? 'f' : '', p.noEscalators ? 'e' : ''].join(''); };
/** The coach for this ride (whichever end the view shows), chosen once per ride, class and access settings. A ride
 *  that is one of several trains in a row (changes from train to train, `t.chain`) is chosen with the others. */
export function planCoach(t: Station3DTrain, ctx: CoachPlanContext): Promise<CoachPlan | null> {
  const id = [t.id, prefsKey(ctx)].join('|');
  if (!plans.has(id)) {
    const chain = t.chain && t.chain.length > 1 ? t.chain : null;
    const job = (chain ? planChain(chain, ctx).then((m) => m.get(t.id) || plan(t, ctx)) : plan(t, ctx)).catch((e) => { console.warn(e); return null; });
    plans.set(id, job);
    job.then((r) => { if (!r) plans.delete(id); });
  }
  return plans.get(id)!;
}

/** What a ride offers to choose from: its coaches at both ends, the ones that suit you, and how each is laid out. */
interface Stage { t: Station3DTrain; atB: TrainCoach[]; atA: TrainCoach[]; picks: number[]; idxA(c: TrainCoach): number }
async function stageOf(t: Station3DTrain, ctx: CoachPlanContext): Promise<Stage | { missing: CoachPlan['missing'] } | null> {
  const boardT: Station3DTrain = { ...t, role: 'board', uic: t.board.uic, ref: t.board.ref, sectors: t.board.sectors, toUic: t.alight.uic, toName: t.alight.name };
  const f = await formationFor(boardT, ctx.engine);
  const atB = coachesAt(f, boardT).coaches;
  if (!atB) return null;
  const atA = t.through ? coachesAt(f, { ...t, role: 'alight', uic: t.alight.uic, ref: t.alight.ref, sectors: t.alight.sectors }).coaches : null;
  const fit = coachesFor(atB, ctx.cls, !!(ctx.prefs && ctx.prefs.wheelchair));
  if (fit.missing) return { missing: fit.missing };
  // the coach must be there at the other end too (a coach that is not would be one left on the way)
  const idxA = (c: TrainCoach) => (atA ? atA.findIndex((x) => x.id === c.id) : -1);
  const picks = atA ? fit.picks.filter((i) => idxA(atB[i]) >= 0) : fit.picks;
  if (!picks.length || !atA) return picks.length ? null : { missing: 'unmatched' };
  return { t, atB, atA, picks, idxA };
}

const chains = new Map<string, Promise<Map<string, CoachPlan>>>();
/** Several trains in a row, changing from one to the next: the coaches chosen together, for the shortest walk over
 *  all of it (to the first train, from coach to coach at each change, from the last train), not one ride at a time.
 *  A change whose walk cannot be weighed (no model, or no way) counts as nothing; a ride that cannot take part (no
 *  formation, another class missing, …) leaves the others to be chosen on their own. */
function planChain(chain: Station3DTrain[], ctx: CoachPlanContext): Promise<Map<string, CoachPlan>> {
  const id = chain.map((t) => t.id).join('>') + '|' + prefsKey(ctx);
  if (!chains.has(id)) {
    const job = chainPlan(chain, ctx).catch((e) => { console.warn(e); return new Map<string, CoachPlan>(); });
    chains.set(id, job);
  }
  return chains.get(id)!;
}
async function chainPlan(chain: Station3DTrain[], ctx: CoachPlanContext): Promise<Map<string, CoachPlan>> {
  const out = new Map<string, CoachPlan>();
  const stages = await Promise.all(chain.map((t) => stageOf({ ...t, role: "board" }, ctx)));
  if (stages.some((s) => !s || 'missing' in s)) return out;   // each ride on its own
  const S = stages as Stage[], n = S.length;
  const SR = ctx.router();
  if (!SR) return out;
  const prefs = Object.assign({}, ctx.prefs || {});
  // the walk to the first train and from the last one
  const first = await side(ctx, S[0].t.board.key, S[0].t.board.uic, S[0].t.board.ref, S[0].atB, 'in', S[0].t.board.walk);
  const last = await side(ctx, S[n - 1].t.alight.key, S[n - 1].t.alight.uic, S[n - 1].t.alight.ref, S[n - 1].atA, 'out', S[n - 1].t.alight.walk);
  // each change: from every door of a coach of the train before to every door of one of the next
  const changes = await Promise.all(S.slice(0, -1).map(async (a, k) => {
    const b = S[k + 1], key = a.t.alight.key;
    if (!key || key !== b.t.board.key) return null;
    const model = await ctx.loadModel(key);
    const LA = model && layoutTrain(model, a.t.alight.ref, { coaches: a.atA, sectors: [] });
    const LB = model && layoutTrain(model, b.t.board.ref, { coaches: b.atB, sectors: [] });
    if (!model || !LA || !LB || LA.guessed || LB.guessed) return null;
    const memo = new Map<string, { from: Door; to: Door; seconds: number } | null>();
    return {
      LA, LB,
      walk(ia: number, ib: number) {
        const mk = ia + '>' + ib;
        if (memo.has(mk)) return memo.get(mk)!;
        let best: { from: Door; to: Door; seconds: number } | null = null;
        for (const da of doorsOf(LA, ia)) for (const db of doorsOf(LB, ib)) {
          const r = SR.route(model, { stop: { uic: a.t.alight.uic, ref: a.t.alight.ref, at: da.xy, sector: da.sector } },
            { stop: { uic: b.t.board.uic, ref: b.t.board.ref, at: db.xy, sector: db.sector } }, prefs);
          if (r && !r.incomplete && (!best || r.seconds < best.seconds)) best = { from: da, to: db, seconds: r.seconds };
        }
        memo.set(mk, best);
        return best;
      },
    };
  }));
  if (!first && !last && changes.every((c) => !c)) return out;   // nothing weighed: each on its own
  // shortest total, stage by stage (dynamic programming over the coaches of each train)
  type Cell = { cost: number; prev: number };
  const table: Cell[][] = [];
  table[0] = S[0].picks.map((i) => {
    const b = first ? first.best(i) : null;
    return { cost: first ? (b ? b.seconds : Infinity) : 0, prev: -1 };
  });
  for (let k = 1; k < n; k++) {
    const ch = changes[k - 1];
    table[k] = S[k].picks.map((ib) => {
      let cell: Cell = { cost: Infinity, prev: -1 };
      S[k - 1].picks.forEach((i, j) => {
        const before = table[k - 1][j].cost;
        if (!Number.isFinite(before)) return;
        const w = ch ? ch.walk(S[k - 1].idxA(S[k - 1].atB[i]), ib) : null;
        const c = before + (ch ? (w ? w.seconds : Infinity) : 0);
        if (c < cell.cost) cell = { cost: c, prev: j };
      });
      return cell;
    });
  }
  let end = -1, total = Infinity;
  S[n - 1].picks.forEach((i, j) => {
    const a = last ? last.best(S[n - 1].idxA(S[n - 1].atB[i])) : null;
    const c = table[n - 1][j].cost + (last ? (a ? a.seconds : Infinity) : 0);
    if (c < total) { total = c; end = j; }
  });
  if (end < 0 || !Number.isFinite(total)) return out;
  // back from the end: the coach of each train
  const pick: number[] = [];
  for (let k = n - 1, j = end; k >= 0; k--) { pick[k] = j; j = table[k][j].prev; }
  for (let k = 0; k < n; k++) {
    const st = S[k], i = st.picks[pick[k]], ia = st.idxA(st.atB[i]);
    const inW = k === 0 ? (first ? first.best(i) : null) : null;
    const chIn = k > 0 && changes[k - 1] ? changes[k - 1]!.walk(S[k - 1].idxA(S[k - 1].atB[S[k - 1].picks[pick[k - 1]]]), i) : null;
    const chOut = k < n - 1 && changes[k] ? changes[k]!.walk(ia, S[k + 1].picks[pick[k + 1]]) : null;
    const outW = k === n - 1 ? (last ? last.best(ia) : null) : null;
    const LB = k === 0 ? (first ? first.layout : await layoutAt(ctx, st.t.board.key, st.t.board.ref, st.atB)) : changes[k - 1] ? changes[k - 1]!.LB : await layoutAt(ctx, st.t.board.key, st.t.board.ref, st.atB);
    const LA = k === n - 1 ? (last ? last.layout : await layoutAt(ctx, st.t.alight.key, st.t.alight.ref, st.atA)) : changes[k] ? changes[k]!.LA : await layoutAt(ctx, st.t.alight.key, st.t.alight.ref, st.atA);
    const boardDoor = inW ? inW.door : chIn ? chIn.to : LB ? doorsOf(LB, i)[0] || null : null;
    const alightDoor = outW ? outW.door : chOut ? chOut.from : LA ? doorsOf(LA, ia)[0] || null : null;
    const weighed: ('in' | 'out')[] = [...((k === 0 ? first : changes[k - 1]) ? ['in' as const] : []), ...((k === n - 1 ? last : changes[k]) ? ['out' as const] : [])];
    out.set(st.t.id, {
      coachId: st.atB[i].id, missing: null, weighed,
      board: { idx: i, door: boardDoor, seconds: inW ? inW.seconds : chIn ? chIn.seconds : null },
      alight: { idx: ia, door: alightDoor, seconds: outW ? outW.seconds : chOut ? chOut.seconds : null },
    });
  }
  return out;
}

async function plan(t: Station3DTrain, ctx: CoachPlanContext): Promise<CoachPlan | null> {
  if (t.mode !== 'train') return null;
  // the end you board is the one the coach is chosen at; across trips (staying seated on another train number) only
  // the end shown can be weighed, so only a boarding view chooses then
  if (!t.through && t.role === 'alight') return null;
  const boardT: Station3DTrain = { ...t, role: 'board', uic: t.board.uic, ref: t.board.ref, sectors: t.board.sectors, toUic: t.alight.uic, toName: t.alight.name };
  const f = await formationFor(boardT, ctx.engine);
  const atB = coachesAt(f, boardT).coaches;
  if (!atB) return null;
  const atA = t.through ? coachesAt(f, { ...t, role: 'alight', uic: t.alight.uic, ref: t.alight.ref, sectors: t.alight.sectors }).coaches : null;
  const wheelchair = !!(ctx.prefs && ctx.prefs.wheelchair);
  const fit = coachesFor(atB, ctx.cls, wheelchair);
  if (fit.missing) return { coachId: null, board: null, alight: null, missing: fit.missing, weighed: [] };
  // the coach must be there at the other end too (a coach that is not would be one left on the way)
  const idxA = (c: TrainCoach) => (atA ? atA.findIndex((x) => x.id === c.id) : -1);
  const picks = atA ? fit.picks.filter((i) => idxA(atB[i]) >= 0) : fit.picks;
  if (!picks.length) return { coachId: null, board: null, alight: null, missing: 'unmatched', weighed: [] };

  const sideB = await side(ctx, t.board.key, t.board.uic, t.board.ref, atB, 'in', await anchorIn(t, ctx));
  const sideA = t.through && atA ? await side(ctx, t.alight.key, t.alight.uic, t.alight.ref, atA, 'out', t.alight.walk) : null;
  const cands = picks.map((i) => {
    const c = atB[i], ia = idxA(c);
    const b = sideB ? sideB.best(i) : null, a = sideA && ia >= 0 ? sideA.best(ia) : null;
    return { id: c.id, i, ia, b, a, inS: sideB ? (b ? b.seconds : Infinity) : null, outS: sideA ? (a ? a.seconds : Infinity) : null };
  });
  const chosen = pickCoach(cands);
  const weighed: ('in' | 'out')[] = [...(sideB ? ['in' as const] : []), ...(sideA ? ['out' as const] : [])];
  if (!chosen) return { coachId: null, board: null, alight: null, missing: 'unreachable', weighed };
  const c = cands.find((x) => x.id === chosen)!;
  // the door you take: the walk's best door; without a walk weighed, the middle door of the coach as drawn
  const doorOr = (L: TrainLayout | null, idx: number, got: { door: Door } | null) => (got ? got.door : L ? doorsOf(L, idx)[0] || null : null);
  return {
    coachId: chosen,
    board: { idx: c.i, door: doorOr(sideB ? sideB.layout : await layoutAt(ctx, t.board.key, t.board.ref, atB), c.i, c.b), seconds: c.b ? c.b.seconds : null },
    alight: atA && c.ia >= 0 ? { idx: c.ia, door: doorOr(sideA ? sideA.layout : await layoutAt(ctx, t.alight.key, t.alight.ref, atA), c.ia, c.a), seconds: c.a ? c.a.seconds : null } : null,
    missing: null, weighed,
  };
}

/** Where the walk to the train starts: the door of the coach you arrive in (a change from another train), else the
 *  walk's own start. */
async function anchorIn(t: Station3DTrain, ctx: CoachPlanContext): Promise<StationRouteEndpoint | null> {
  const via = t.board.via;
  if (via && via.alight.key === t.board.key) {
    const vp = await planCoach({ ...via, role: 'alight' }, ctx);
    const d = vp && vp.alight && vp.alight.door;
    if (d) return { stop: { uic: via.alight.uic, ref: via.alight.ref, at: d.xy, sector: d.sector } };
  }
  return t.board.walk;
}

async function layoutAt(ctx: CoachPlanContext, key: string | null, ref: string, coaches: TrainCoach[]): Promise<TrainLayout | null> {
  const model = key ? await ctx.loadModel(key) : null;
  return model ? layoutTrain(model, ref, { coaches, sectors: [] }) : null;
}

/** One end of the ride in a station model: the walk to (in) or from (out) each door of the coaches asked about. */
async function side(ctx: CoachPlanContext, key: string | null, uic: string, ref: string, coaches: TrainCoach[], dir: 'in' | 'out', anchor: StationRouteEndpoint | null) {
  if (!key || !anchor) return null;
  const model = await ctx.loadModel(key);
  const SR = ctx.router();
  if (!model || !SR) return null;
  const layout = layoutTrain(model, ref, { coaches, sectors: [] });
  if (!layout || layout.guessed) return null;
  const prefs = Object.assign({}, ctx.prefs || {});
  const memo = new Map<number, { door: Door; seconds: number } | null>();
  return {
    layout,
    best(idx: number) {
      if (memo.has(idx)) return memo.get(idx)!;
      let best: { door: Door; seconds: number } | null = null;
      for (const door of doorsOf(layout, idx)) {
        const at: StationRouteEndpoint = { stop: { uic, ref, at: door.xy, sector: door.sector } };
        const r = dir === 'in' ? SR.route(model, anchor, at, prefs) : SR.route(model, at, anchor, prefs);
        // a way that ends short (closed), or one that could not even find the sector, says nothing about this door
        const reached = r && !r.incomplete && (dir === 'in' ? r.toAt || (r.toSectors && r.toSectors.length) : r.fromAt || (r.fromSectors && r.fromSectors.length));
        if (r && reached && (!best || r.seconds < best.seconds)) best = { door, seconds: r.seconds };
      }
      memo.set(idx, best);
      return best;
    },
  };
}
