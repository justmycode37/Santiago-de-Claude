// ---- Line colours: every line gets one colour of the app palette (sun stays for walks),
//      the same on its badge and on the map. [name, light bg, light text, dark bg, dark (vivid) colour] ----
const PALETTE = [
  ['navy', '#344D77', '#FFFFFF', '#141D2D', '#9DB4DD'],
  ['rose', '#C55A82', '#FFFFFF', '#2C1520', '#E28CAD'],
  ['tang', '#FF7241', INK, '#2E1810', '#FF7241'],
].map(([name, bg, fg, dbg, dfg]) => ({ name, bg, fg, dbg, dfg }));
const colorNamed = (n) => PALETTE.find((p) => p.name === n) || PALETTE[0];
// Zürich's trams are known by their colour (VBZ network map, snapped to the palette)
const VBZ_TRAM = { 2: 'rose', 3: 'navy', 4: 'navy', 5: 'tang', 6: 'tang', 7: 'navy', 8: 'navy', 9: 'rose', 10: 'rose', 11: 'navy', 13: 'tang', 14: 'navy', 15: 'rose', 17: 'rose' };
const LONG_DISTANCE = /^(IC|ICE|ICN|EC|IR|IRE|RE|RJ|RJX|TGV|NJ|EN|PE|GEX|BEX|VAE|TER|RB|EXT)/;
function hashText(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const lineColors = new Map();
function lineColor(j) {
  const cat = (j.category || '').toUpperCase(), num = String(j.number || ''), label = lineLabel(j);
  const key = `${j.operator || ''}|${cat}|${num}`;
  if (lineColors.has(key)) return lineColors.get(key);
  const mode = modeOf(cat);
  let c;
  if (mode === 'tram' && /VBZ|Verkehrsbetriebe Z/i.test(j.operator || '') && VBZ_TRAM[num]) c = colorNamed(VBZ_TRAM[num]);
  else if (/^(BN|TN|SN|NB)$/.test(cat) || /^(N|SN)\d/.test(label)) c = colorNamed('navy'); // night services
  else if (mode === 'boat') c = colorNamed('navy');
  else if (mode === 'cable') c = colorNamed('tang');
  else if (mode === 'train' && (LONG_DISTANCE.test(cat) || !num)) c = colorNamed('navy');
  else if (/^\d+$/.test(label)) c = PALETTE[Number(label) % PALETTE.length]; // consecutive numbers get different colours
  else c = PALETTE[hashText(label || cat) % PALETTE.length];
  lineColors.set(key, c);
  return c;
}
// CSS picks the light or the dark pair
function lineVars(el, j) {
  const c = lineColor(j);
  el.style.setProperty('--lc', c.bg);
  el.style.setProperty('--lf', c.fg);
  el.style.setProperty('--ldc', c.dbg);
  el.style.setProperty('--ldf', c.dfg);
  return el;
}

const MODE_ICON = {
  train: '<path d="M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM4 10h16M8 17l-2 4M16 17l2 4"/>',
  tram:  '<path d="M7 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9 2.5h6M12 2.5V6M5 12h14M8 18l-2 3M16 18l2 3"/>',
  bus:   '<path d="M6 3h12a2 2 0 0 1 2 2v12H4V5a2 2 0 0 1 2-2zM4 11h16M7 17v3M17 17v3"/>',
  boat:  '<path d="M3 15l2 5h14l2-5zM6 15V9h12v6M12 5v4"/>',
  cable: '<path d="M3 4l18 4M12 6v4M7 10h10v8H7zM7 14h10"/>',
  walk:  '<circle cx="13" cy="4.2" r="1.9"/><path d="M10.5 21l1.5-5.5 2.5 2.5v3M8.5 12.5l2.5-4.5 3 1 2 3.5M12 15.5l-1.2-6.5"/>',
  pin:   '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  change: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  left: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/>',
  right: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0-6 6v5"/>',
  straight: '<path d="M12 20V4M6 10l6-6 6 6"/>',
  stairs: '<path d="M4 20h5v-5h5v-5h5V5"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${MODE_ICON[name]}</svg>`;

function modeOf(category) {
  const c = (category || '').toUpperCase(); // some rides come without a category
  if (/^(IC|ICE|ICN|IR|IRE|EC|EN|EXT|NJ|RE|R|RB|S|SN|PE|TGV|RJX|TER)$/.test(c)) return 'train';
  if (/^(T|TRAM|M)$/.test(c)) return 'tram';
  if (/^(BAT|FAE|BAV)$/.test(c)) return 'boat';
  if (/^(FUN|PB|GB|SL|LB|ASC)$/.test(c)) return 'cable';
  return 'bus';
}
function lineLabel(j) {
  const c = (j.category || '').toUpperCase();
  // "000063" → "63"; a placeholder like "?" (replacement buses) is no number
  const n = /[A-Za-z0-9]/.test(j.number || '') ? String(j.number).replace(/^0+(?=\d)/, '') : '';
  if (!n) return c;
  if (/^(S|SN|R|RE|IR|IC|EC|ICE)$/.test(c)) return /^(S|SN)$/.test(c) ? c + n : `${c} ${n}`;
  if (c === 'B' || c === 'T' || c === 'BUS' || c === 'TRAM') return n;
  return `${c} ${n}`.trim();
}

const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : '--:--';
function fmtDuration(d) {
  const m = /(\d+)d(\d+):(\d+)/.exec(d || '');
  if (!m) return '';
  const h = +m[1] * 24 + +m[2], min = +m[3];
  return h ? `${h} h ${min} min` : `${min} min`;
}
function dayLabel(iso) {
  const d = new Date(iso), now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
const coordOf = (stop) => {
  const c = stop && (stop.station || stop.location) && (stop.station || stop.location).coordinate;
  return c && c.x != null && c.y != null ? [c.y, c.x] : null; // API: x = lat, y = lng
};

const sameStop = (a, b) => !!(a && b && a.station && b.station && a.station.id && a.station.id === b.station.id);

// Every stop of a ride on its exact platform/edge (falls back to the station position)
function placeRide(s) {
  const list = s.journey.passList;
  const raw = list.map(coordOf);
  const at = list.map((stop, k) =>
    platformAt(k === 0 ? s.departure : k === list.length - 1 ? s.arrival : stop, raw[k - 1] || null, raw[k + 1] || null));
  const pts = at.map((a) => a.ll);
  return { path: pts.filter(Boolean), idx: pts.map((p, k) => (p ? k : -1)).filter((k) => k >= 0), // idx: each path stop's place in passList
    dep: pts[0] || coordOf(s.departure), arr: pts[pts.length - 1] || coordOf(s.arrival), depAt: at[0], arrAt: at[at.length - 1] };
}

// Turn the API's sections into swipeable steps: walk → ride → change → ride → … → walk → arrive
function buildSteps(conn, destTitle) {
  const steps = [];
  let walk = { min: 0, lines: [], start: null };
  let lastRide = null;
  const flushWalk = () => { const w = walk; walk = { min: 0, lines: [], start: null }; return w; };
  const at = new Map(conn.sections.filter((s) => s.journey).map((s) => [s, placeRide(s)]));
  conn.sections.forEach((s, idx) => {
    if (!s.journey) {
      walk.min += Math.round((s.walk && s.walk.duration || 0) / 60);
      walk.start = walk.start || s.departure.departure;
      // walks start/end on the platform you get off / on, not at the station's centre
      let a = coordOf(s.departure), b = coordOf(s.arrival);
      if (lastRide && sameStop(s.departure, lastRide.arrival)) a = at.get(lastRide).arr || a;
      const nextRide = conn.sections.slice(idx + 1).find((x) => x.journey);
      if (nextRide && sameStop(s.arrival, nextRide.departure)) b = at.get(nextRide).dep || b;
      if (a && b) walk.lines.push([a, b]);
      return;
    }
    const w = flushWalk();
    const here = at.get(s);
    if (!lastRide) {
      if (w.min > 0) {
        const t0 = new Date(w.start || conn.from.departure).getTime();
        steps.push({ type: 'walk', min: w.min, lines: w.lines, start: w.start, toName: s.departure.station.name, next: s,
          board: here.dep, t0, t1: t0 + w.min * 60000 });
      }
    } else {
      const t0 = new Date(lastRide.arrival.arrival).getTime();
      const pa = at.get(lastRide).arr, pd = here.dep;
      // changing platforms inside a station: show the way from one platform to the other
      const lines = w.lines.length ? w.lines : pa && pd && distKm(pa, pd) > 0.015 ? [[pa, pd]] : [];
      steps.push({ type: 'change', prev: lastRide, next: s, walkMin: w.min, lines,
        points: [pa, pd], t0, t1: w.min > 0 ? t0 + w.min * 60000 : new Date(s.departure.departure).getTime() });
    }
    steps.push({ type: 'ride', s, path: here.path, stops: here.path, stopIdx: here.idx, depLL: here.dep, arrLL: here.arr, depAt: here.depAt, arrAt: here.arrAt,
      t0: new Date(s.departure.departure).getTime(), t1: new Date(s.arrival.arrival).getTime() });
    lastRide = s;
  });
  const w = flushWalk();
  const end = lastRide ? at.get(lastRide).arr : null;
  if (w.min > 0 || !lastRide) {
    const t0 = new Date(w.start || (lastRide ? lastRide.arrival.arrival : conn.from.departure)).getTime();
    steps.push({ type: 'walk', min: w.min, lines: w.lines, start: w.start, toName: destTitle, final: true,
      from: lastRide, alight: end, t0, t1: t0 + w.min * 60000 });
  }
  steps.push({ type: 'arrive', destTitle, time: conn.to.arrival, from: lastRide, end });
  steps.forEach((st, i) => {
    st.prevRide = steps.slice(0, i).reverse().find((x) => x.type === 'ride');
    st.nextRide = steps.slice(i + 1).find((x) => x.type === 'ride');
  });
  if (conn.kante) KanteJourney.decorate(steps, conn); // the engine's walks: their path, directions and floor changes
  applyLiveTimes(steps);
  return steps;
}

// Live (real-time) time at a stop in ms: the operator's forecast when there is one, else the timetable
function liveMs(stop, which) {
  const t = (stop && stop.prognosis && stop.prognosis[which]) || (stop && stop[which]);
  return t ? new Date(t).getTime() : null;
}
// Minutes late (forecast − timetable)
function lateMin(stop, which) {
  const live = liveMs(stop, which), plan = stop && stop[which] ? new Date(stop[which]).getTime() : null;
  return live != null && plan != null ? Math.round((live - plan) / 60000) : 0;
}
// Time every ride, change and the last walk by the live forecasts (run again whenever they change)
function applyLiveTimes(steps) {
  let end = null;
  steps.forEach((st) => {
    if (st.type === 'ride') {
      st.t0 = liveMs(st.s.departure, 'departure');
      st.t1 = liveMs(st.s.arrival, 'arrival');
      end = st.t1;
    } else if (st.type === 'change') {
      st.t0 = liveMs(st.prev.arrival, 'arrival');
      st.t1 = st.walkMin > 0 ? st.t0 + st.walkMin * 60000 : liveMs(st.next.departure, 'departure');
    } else if (st.type === 'walk' && st.final) {
      if (st.from) { st.t0 = liveMs(st.from.arrival, 'arrival'); st.t1 = st.t0 + st.min * 60000; }
      end = st.t1;
    } else if (st.type === 'arrive' && end != null) st.time = end;
  });
}

function stepCoords(st) {
  const c = [];
  (st.lines || []).forEach((l) => c.push(...l));
  if (st.path) c.push(...st.path);
  if (st.points) c.push(...st.points.filter(Boolean));
  if (st.board) c.push(st.board);
  if (st.alight) c.push(st.alight);
  if (st.type === 'arrive') {
    if (destMarker._map) c.push(destMarker.getLngLat().toArray());
    if (st.end) c.push(st.end);
  }
  return c;
}

// Split a line at a fraction of its length → [travelled, ahead]
function splitLine(cs, frac) {
  const total = lengthKm(cs);
  let target = total * frac, acc = 0;
  for (let i = 1; i < cs.length; i++) {
    const d = distKm(cs[i - 1], cs[i]);
    if (acc + d >= target) {
      const r = d ? (target - acc) / d : 0;
      const p = [cs[i - 1][0] + (cs[i][0] - cs[i - 1][0]) * r, cs[i - 1][1] + (cs[i][1] - cs[i - 1][1]) * r];
      return [[...cs.slice(0, i), p], [p, ...cs.slice(i)], p];
    }
    acc += d;
  }
  return [cs, [cs[cs.length - 1]], cs[cs.length - 1]];
}

// A point a set distance along a line (km), from its start or (negative) from its end
function pointAlong(cs, km) {
  if (!cs || cs.length < 2) return cs && cs[0];
  const total = lengthKm(cs);
  const at = km >= 0 ? Math.min(km, total / 2) : Math.max(total / 2, total + km);
  return splitLine(cs, total ? at / total : 0)[2];
}

// Floor change on a walk ("Go down to level −4"); platforms without a level are at street level
function levelChange(st) {
  const lv = (x) => (x == null ? 0 : x);
  const depLevel = (r) => r && r.depAt && r.depAt.edge && r.depAt.edge.level;
  const arrLevel = (r) => r && r.arrAt && r.arrAt.edge && r.arrAt.edge.level;
  const walk = (st.lines || []).flat();
  let from = 0, to = 0, at = null;
  if (st.type === 'walk' && !st.final) { to = lv(depLevel(st.nextRide)); at = pointAlong(walk, -0.03); }
  else if (st.type === 'walk') { from = lv(arrLevel(st.prevRide)); at = pointAlong(walk, 0.03); }
  else if (st.type === 'change') {
    from = lv(arrLevel(st.prevRide)); to = lv(depLevel(st.nextRide));
    at = walk.length > 1 ? splitLine(walk, .5)[2] : st.points[1];
  } else return null;
  if (from === to) return null;
  return { from, to, at, text: `Go ${to < from ? 'down' : 'up'} to ${to === 0 ? 'street level' : 'level ' + levelShort(to)}` };
}

function signId(st) {
  const j = st.s.journey, raw = platformOf(st.s.departure);
  const edge = st.depAt && st.depAt.edge;
  const label = splitPlatform(raw === '–' ? '' : raw).num || (edge && edge.ref) || '';
  return `sg|l|${label}|${label ? platformWord(j) : ''}`;
}

function stepFeatures(steps) {
  const f = [];
  const add = (geometry, properties) => f.push({ type: 'Feature', properties, geometry });
  const line = (cs, kind, step, extra) => cs && cs.length > 1 && add({ type: 'LineString', coordinates: cs }, { kind, step, ...extra });
  const pt = (c, props) => c && add({ type: 'Point', coordinates: c }, props);
  // where you are on the trip: everything before it is drawn faded ("done")
  const p = journeyProgress();
  const doneLine = (cs, kind, step, from, extra) => { // from: km into its step where this line starts
    if (!cs || cs.length < 2) return;
    if (!p || step > p.i) return line(cs, kind, step, extra);
    const len = lengthKm(cs), k = p.kmIn - from;
    if (step < p.i || k >= len) return line(cs, kind, step, { ...extra, done: true });
    if (k <= 0) return line(cs, kind, step, extra);
    const [a, b] = splitLine(cs, k / len);
    line(a, kind, step, { ...extra, done: true });
    line(b, kind, step, extra);
  };
  steps.forEach((st, i) => {
    let from = 0;
    (st.lines || []).forEach((l) => { doneLine(l, 'walk', i, from); from += lengthKm(l); });
    if (st.type === 'ride') {
      const c = lineColor(st.s.journey), colors = { color: c.bg, dcolor: c.dfg };
      doneLine(st.path, 'ride', i, 0, colors);
      const kms = p && p.i === i ? stopKms(st) : null;
      const passed = (m) => !!p && (i < p.i || (!!kms && kms[m] <= p.kmIn));
      st.stops.slice(1, -1).forEach((q, m) => pt(q, { kind: 'stop', step: i, end: false, done: passed(m + 1), ...colors }));
      pt(st.arrLL, { kind: 'stop', step: i, end: true, done: !!p && i < p.i, ...colors });
      pt(st.depLL, { kind: 'sign', step: i, img: signId(st), sort: 10 });
    }
    // floor changes: every one on a walk through a modelled station (st.floors), else the one the platform levels imply
    const lvl = st.floors ? null : levelChange(st);
    if (lvl && lvl.at) pt(lvl.at, { kind: 'lvl', step: i, img: `lv|${lvl.to > lvl.from ? 'u' : 'd'}|${levelShort(lvl.to)}` });
    (st.floors || []).forEach((m) => pt(m.at, { kind: 'lvl', step: i, img: `lv|${m.to > m.from ? 'u' : 'd'}|${levelShort(m.to)}` }));
  });
  const first = steps[0];
  if (first && first.type === 'walk' && first.lines[0]) pt(first.lines[0][0], { kind: 'pin', step: 0, img: 'pin|from' });
  return f;
}
