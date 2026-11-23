// AR core: the decisions behind the AR camera (src/arview.ts), without the DOM, the camera or the network, so that
// Node can test them (tools/test_arcore.mts) and the iOS app (rightside/) can share them.
//
// 1. Which vehicle is this? A port of RightSide's DepartureDisplayMatcher + VehicleTextRules + VehicleServiceMatcher
//    (rightside/redesign/apps/ios/RightSide/Sensors/DepartureDisplayMatcher.swift, VehicleEvidence.swift): the text read
//    on a vehicle's display is compared with the services that can actually stop here (the ride you want plus the
//    stop's other departures). A service only wins when it explains the glyphs clearly better than every other one.
//    OCR text is never rewritten; the answer is a scored choice or an honest "ambiguous / unlisted / unreadable".
//    Same constants, same rules, same order as the Swift, so the display bench gives the same numbers
//    (tools/test_arcore.mts replays rightside/tools/display-bench through this file).
//
// Boxes are [x, y, width, height], normalised to the picture (0–1), top-left origin, as in the Swift.

/** [x, y, width, height] in the picture, normalised 0–1, top-left origin. */
export type ArBox = [number, number, number, number];
/** One piece of text OCR read: what, where, how sure (0–1). */
export interface ArText { text: string; box: ArBox; score: number }
/** Where a vehicle (or, on the web, the aim frame around its display) is in the picture; score: the detector's, 1 for the aim frame. */
export interface ArDetection { box: ArBox; score: number }
/** A service that can stop here soon: the ride you want, or another departure of the stop. */
export interface ArCandidate { line: string; destination: string; vias?: string[]; isExpected?: boolean }
export type ArLineEvidence = 'exact' | 'confusable' | 'unseen' | 'contradicted';
export interface ArCandidateScore {
  candidate: ArCandidate;
  /** 0–1: how well the best display row fits the destination (or a via). */
  destination: number;
  line: ArLineEvidence;
  /** The text that gave `destination`. */
  observed: string;
  ocrScore: number;
  /** 0–1 from live vehicle positions; 0 when unknown. */
  position: number;
  total: number;
}
export type ArMatchOutcome = 'matched' | 'ambiguous' | 'unlisted' | 'unreadable';
export interface ArBoardMatch {
  outcome: ArMatchOutcome;
  best: ArCandidateScore | null;
  runnerUp: ArCandidateScore | null;
  margin: number;
  /** How far this one frame can be trusted, 0–1. */
  confidence: number;
}
/** What one frame shows on one vehicle. at: seconds. */
export interface ArReading {
  frameId: string;
  at: number;
  line: string | null;
  destination: string | null;
  outOfService: boolean;
  ambiguous: boolean;
  raw: string[];
  observed: ArText[];
  /** 0.56–1: how far a reading from this frame can be trusted on image grounds. */
  frameQuality: number;
}
/** The ride you want, and what else can stop here (the board), for the vehicle decision. */
export interface ArExpectation {
  line: string;
  destination: string;
  vias?: string[];
  /** Other services due at the stop: a misread is then not taken for a wrong vehicle, and a wrong one can be named. */
  board?: ArCandidate[];
  /** The ride's stops before where you get off: the same line showing one of them is a short working. */
  stopsBefore?: string[];
}
export type ArDecisionState = 'unknown' | 'wrong' | 'match';
export type ArBasis = 'consensus' | 'best_single_frame';
export interface ArDecision {
  state: ArDecisionState;
  reason: string;
  /** The other service the display shows (state 'wrong'). */
  other?: ArCandidate;
  observed?: string;
  basis?: ArBasis | null;
  confidence?: number | null;
}

type Box = ArBox;

// ---------------------------------------------------------------- boxes
const midX = (b: Box) => b[0] + b[2] / 2;
const midY = (b: Box) => b[1] + b[3] / 2;
const isEmptyBox = (b: Box) => !(b[2] > 0 && b[3] > 0);
const containsPoint = (b: Box, x: number, y: number) => x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3];
const containsBox = (o: Box, i: Box) => !isEmptyBox(i) && i[0] >= o[0] && i[1] >= o[1] && i[0] + i[2] <= o[0] + o[2] && i[1] + i[3] <= o[1] + o[3];
const intersects = (a: Box, b: Box) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
function union(a: Box, b: Box): Box {
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
  return [x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0];
}
function iou(a: Box, b: Box) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  if (x1 <= x0 || y1 <= y0) return 0;
  const area = (x1 - x0) * (y1 - y0);
  return area / Math.max(0.000001, a[2] * a[3] + b[2] * b[3] - area);
}

/** Swappable for tests: tools/test_arcore.mts replays the Swift bench as it runs on Linux (see there). */
const OPTIONS = { containsBox };

// ---------------------------------------------------------------- DisplayText: normalisation, no dictionary
const ABBREVIATIONS: Record<string, string> = {
  bhf: 'bahnhof', bf: 'bahnhof', bahnhf: 'bahnhof', hbf: 'hauptbahnhof', hb: 'hauptbahnhof',
  str: 'strasse', pl: 'platz', stn: 'station',
};
const fold = (s: string) => String(s).replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const wordCache = new Map<string, string[]>();
/** Lowercased, accent-free ASCII alphanumeric words; "9Wankdorf" → "9", "wankdorf"; known abbreviations expanded. */
function words(value: string): string[] {
  const hit = wordCache.get(value);
  if (hit) return hit;
  const raw = fold(value).split(/[^a-z0-9]+/).filter(Boolean);
  const split: string[] = [];
  for (const w of raw) {
    const m = /^(\d{1,3})([a-z]{3,})$/.exec(w);
    if (m) split.push(m[1], m[2]); else split.push(w);
  }
  const out: string[] = [];
  for (const w of split) {
    if (w.length > 4 && w.endsWith('bhf')) { out.push(w.slice(0, -3), 'bahnhof'); continue; }
    out.push(ABBREVIATIONS[w] || w);
  }
  if (wordCache.size > 4096) wordCache.clear();
  wordCache.set(value, out);
  return out;
}
const canonical = (v: string) => words(v).join(' ');
/** Route numerals on Swiss displays: 1–3 digits, an optional one- or two-letter prefix (N1, S7) or one-letter suffix (10E). */
const isRouteToken = (w: string) => /^[a-z]{0,2}\d{1,3}[a-z]?$/.test(w);
function lineKey(line: string) {
  const joined = words(line).join('');
  for (const p of ['bus', 'tram', 'nfb', 'nft', 'b', 't']) {
    if (joined.startsWith(p) && /^\d{1,3}[a-z]?$/.test(joined.slice(p.length))) return joined.slice(p.length);
  }
  return joined;
}
const CONFUSION: Record<string, string> = { o: '0', i: '1', l: '1', s: '5', b: '8', z: '2', g: '6' };
const confusionKey = (t: string) => [...t].map((c) => CONFUSION[c] || c).join('');

const GENERIC_STOP = new Set(['endstation', 'busendstation', 'tramendstation', 'bahnhof', 'post', 'dorf', 'zentrum', 'schleife', 'station', 'gare', 'stazione']);
const DROPPED_TERMINUS = new Set(['endstation', 'busendstation', 'tramendstation', 'schleife', 'post', 'dorf']);
type Variant = { words: string[]; weight: number };
const variantCache = new Map<string, Variant[]>();
/** How a display may render a destination ("Bern, Wankdorf Bahnhof" → "Wankdorf Bahnhof"), with a weight. */
function weightedVariants(destination: string): Variant[] {
  const hit = variantCache.get(destination);
  if (hit) return hit;
  const out: Variant[] = [];
  const add = (w: string[], weight: number) => {
    if (w.length && !out.some((v) => v.words.join(' ') === w.join(' '))) out.push({ words: w, weight });
  };
  add(words(destination), 1);
  const at = destination.indexOf(',');
  if (at >= 0) {
    const locality = words(destination.slice(0, at)), stop = words(destination.slice(at + 1));
    if (locality.length >= 2) add([...locality.slice(1), ...stop], 1);
    if (GENERIC_STOP.has(stop.join('')) || stop.every((w) => GENERIC_STOP.has(w))) {
      if (DROPPED_TERMINUS.has(stop.join('')) || stop.every((w) => DROPPED_TERMINUS.has(w))) add(words(destination.slice(0, at)), 0.92);
      add(stop, 0.75);
    } else add(stop, 1);
  }
  if (variantCache.size > 512) variantCache.clear();
  variantCache.set(destination, out);
  return out;
}
const variants = (d: string) => weightedVariants(d).map((v) => v.words);

// Letters LED matrices render alike (half an edit) and glyphs that are the same shape (no edit).
// The substitution cost of every pair of ASCII codes, once (the matcher's hot loop reads it millions of times).
const COST = new Float64Array(128 * 128).fill(1);
for (let i = 0; i < 128; i++) COST[i * 128 + i] = 0;
for (const [a, b] of [[97, 111], [99, 101], [102, 116], [98, 104], [104, 110], [105, 108], [117, 118], [118, 119],
  [117, 119], [109, 119], [109, 110], [101, 111], [99, 111]]) { COST[a * 128 + b] = 0.5; COST[b * 128 + a] = 0.5; }
for (const [a, b] of [[111, 48], [105, 49], [108, 49], [105, 108], [115, 53], [98, 56], [122, 50], [103, 54]]) { COST[a * 128 + b] = 0; COST[b * 128 + a] = 0; }
const toBytes = (s: string) => { const b = new Array<number>(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 127; return b; };
let prevRow = new Float64Array(64), curRow = new Float64Array(64);
/** 1 − (LED-aware) Levenshtein distance / longer length, on normalised ASCII codes. */
function similarityBytes(x: number[], y: number[]) {
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  if (prevRow.length <= y.length) { prevRow = new Float64Array(y.length + 1); curRow = new Float64Array(y.length + 1); }
  let prev = prevRow, cur = curRow;
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    const row = x[i - 1] * 128;
    for (let j = 1; j <= y.length; j++) {
      const cost = COST[row + y[j - 1]];
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  const d = prev[y.length];
  prevRow = prev; curRow = cur;
  return 1 - d / Math.max(x.length, y.length);
}
const similarity = (a: string, b: string) => similarityBytes(toBytes(words(a).join('')), toBytes(words(b).join('')));
function destinationSimilarity(a: string, b: string) {
  let best = 0;
  for (const x of variants(a)) for (const y of variants(b)) best = Math.max(best, similarity(x.join(''), y.join('')));
  return best;
}

// ---------------------------------------------------------------- DisplayRows
const IGNORED = new Set(['bernmobil', 'hybrid', 'postauto', 'sbb', 'bls', 'vbz', 'bvb', 'tpg', 'tl', 'rbs', 'linie', 'line', 'ligne']);
const VIA = new Set(['via', 'uber', 'ia', 'vla', 'vio', 'va', 'ria', 'wia']);
interface Row { words: string[]; routeTokens: string[]; destinationWords: string[]; weight: number; score: number; isVia: boolean; letterCount: number }
const hasLetter = (s: string) => /\p{L}/u.test(s);
function makeRows(texts: ArText[]): Row[] {
  const usable = texts.filter((t) => Number.isFinite(t.score) && t.score >= 0.3 && !isEmptyBox(t.box))
    .slice().sort((a, b) => midY(a.box) - midY(b.box));
  const tallest = Math.max(0, ...usable.filter((t) => hasLetter(t.text)).map((t) => t.box[3]));
  const groups: ArText[][] = [];
  for (const t of usable) {
    const g = groups.find((grp) => {
      const r = grp[0], h = Math.max(r.box[3], t.box[3]), ratio = t.box[3] / Math.max(r.box[3], 0.000001);
      return Math.abs(midY(r.box) - midY(t.box)) <= h * 0.35 && ratio <= 2.2 && ratio >= 0.45;
    });
    if (g) g.push(t); else groups.push([t]);
  }
  const rows: Row[] = [];
  const seen = new Set<string>();
  const add = (value: string, height: number, score: number) => {
    const ws = words(value).filter((w) => !IGNORED.has(w));
    const key = ws.join(' ');
    if (!ws.length || seen.has(key)) return;
    seen.add(key);
    const routes = ws.filter((w) => isRouteToken(w) && !w.replace(/^[a-z]+/, '').startsWith('0')).map(lineKey);
    const dest = ws.filter((w) => !isRouteToken(w));
    rows.push({ words: ws, routeTokens: routes, destinationWords: dest,
      weight: tallest > 0 ? (height >= tallest * 0.75 ? 1 : 0.8) : 1, score,
      isVia: ws.length > 1 && VIA.has(ws[0]), letterCount: dest.join('').replace(/[^a-z]/g, '').length });
  };
  for (const g of groups) {
    if (g.length > 1) {
      add(g.slice().sort((a, b) => a.box[0] - b.box[0]).map((t) => t.text).join(' '),
        Math.max(...g.map((t) => t.box[3])), Math.min(...g.map((t) => t.score)));
    }
    for (const t of g) add(t.text, t.box[3], t.score);
  }
  return rows;
}

// ---------------------------------------------------------------- DepartureDisplayMatcher
const DESTINATION_ACCEPT = 0.8, DESTINATION_ACCEPT_WITH_LINE = 0.7, MARGIN_ACCEPT = 0.25, UNLISTED_BELOW = 0.5;
const POSITION_WEIGHT = 0.3;
const LINE_TERM: Record<ArLineEvidence, number> = { exact: 0.6, confusable: 0.45, unseen: 0, contradicted: -0.6 };
const identity = (c: ArCandidate) => lineKey(c.line) + '|' + canonical(c.destination);
const total = (s: ArCandidateScore) => s.destination + LINE_TERM[s.line] + s.position * POSITION_WEIGHT;

interface Win { bytes: number[]; key: string; text: string; weight: number; score: number }
function windows(rows: Row[]): Win[] {
  const out: Win[] = [];
  const index = new Map<string, number>();
  for (const row of rows) {
    const ws = row.isVia ? row.destinationWords.slice(1) : row.destinationWords;
    const weight = (row.isVia ? 0.7 : 1) * row.weight;
    for (let s = 0; s < ws.length; s++) {
      let str = '';
      for (let e = s; e < Math.min(ws.length, s + 6); e++) {
        str += ws[e];
        if (str.length > 48) break;
        const w: Win = { bytes: toBytes(str), key: str, text: ws.slice(s, e + 1).join(' '), weight, score: row.score };
        const at = index.get(str);
        if (at != null) {
          if (out[at].weight < weight || (out[at].weight === weight && out[at].score < row.score)) out[at] = w;
        } else { index.set(str, out.length); out.push(w); }
      }
    }
  }
  return out;
}

function score(c: ArCandidate, wins: Win[], routeTokens: string[]): ArCandidateScore {
  const vs = [...weightedVariants(c.destination),
    ...(c.vias || []).slice(0, 4).flatMap(weightedVariants).map((v) => ({ words: v.words, weight: v.weight * 0.9 }))];
  let best = 0, bestText = '', bestScore = 1;
  for (const v of vs) {
    const target = toBytes(v.words.join(''));
    if (!target.length) continue;
    for (const w of wins) {
      const weight = v.weight * w.weight, a = w.bytes.length, b = target.length;
      if (a > b * 2 + 4) continue;
      if (Math.min(a, b) / Math.max(a, b) * weight <= best) continue;
      const sim = similarityBytes(target, w.bytes) * weight;
      if (sim > best) { best = sim; bestText = w.text; bestScore = w.score; }
    }
  }
  const key = lineKey(c.line);
  let line: ArLineEvidence;
  if (!routeTokens.length) line = 'unseen';
  else if (routeTokens.includes(key)) line = 'exact';
  else if (routeTokens.some((t) => confusionKey(t) === confusionKey(key))) line = 'confusable';
  else if (routeTokens.some((t) => t.length < key.length && (key.endsWith(t) || key.startsWith(t)))) line = 'unseen'; // "9" read off a "19"
  else line = 'contradicted';
  return { candidate: c, destination: best, line, observed: bestText, ocrScore: bestScore, position: 0, total: 0 };
}

function sameDisplay(a: ArCandidate, b: ArCandidate) {
  return lineKey(a.line) === lineKey(b.line) && destinationSimilarity(a.destination, b.destination) >= 0.9;
}

/** Compare one frame's display text with every candidate service. positions: likelihoods per identity (0–1). */
function match(texts: ArText[], candidates: ArCandidate[], positions?: Record<string, number>): ArBoardMatch {
  const none: ArBoardMatch = { outcome: 'unreadable', best: null, runnerUp: null, margin: 0, confidence: 0 };
  const rows = makeRows(texts);
  const routeTokens = rows.flatMap((r) => r.routeTokens);
  if (!candidates.length || !(rows.some((r) => r.letterCount >= 3) || routeTokens.length)) return none;
  const byId = new Map<string, ArCandidate>();
  for (const c of candidates) {
    if (!c.line || !c.destination) continue;
    const k = identity(c), old = byId.get(k);
    if (!old || (c.isExpected && !old.isExpected)) byId.set(k, c);
  }
  const wins = windows(rows);
  const scores = [...byId.entries()].map(([k, c]) => {
    const s = score(c, wins, routeTokens);
    s.position = (positions && positions[k]) || 0;
    s.total = total(s);
    return s;
  }).sort((a, b) => b.total - a.total);
  const best = scores[0];
  if (!best) return none;
  const runnerUp = scores.slice(1).find((s) => !sameDisplay(s.candidate, best.candidate)) || null;
  const margin = best.total - (runnerUp ? runnerUp.total : 0);
  const readable = rows.some((r) => r.letterCount >= 4);
  const accepted = best.destination >= DESTINATION_ACCEPT
    || (best.destination >= DESTINATION_ACCEPT_WITH_LINE && (best.line === 'exact' || best.line === 'confusable'));
  let outcome: ArMatchOutcome;
  if (accepted && best.line !== 'contradicted') outcome = margin >= MARGIN_ACCEPT ? 'matched' : 'ambiguous';
  else if (readable && best.destination < UNLISTED_BELOW) outcome = 'unlisted';
  else outcome = readable ? 'ambiguous' : 'unreadable';
  return { outcome, best, runnerUp, margin, confidence: confidenceOf(outcome, best, margin) };
}
/** How far one frame's reading can be trusted (0–1): destination fit × numeral × margin × the OCR's own score. */
function confidenceOf(outcome: ArMatchOutcome, best: ArCandidateScore | null, margin: number) {
  if (outcome === 'unreadable' || !best) return 0;
  const line = { exact: 1, confusable: 0.85, unseen: 0.7, contradicted: 0.3 }[best.line];
  const m = 0.5 + 0.5 * Math.min(1, Math.max(0, margin) / 0.5);
  return Math.min(1, best.destination) * line * m * (0.6 + 0.4 * Math.min(1, Math.max(0, best.ocrScore)));
}

// ---------------------------------------------------------------- VehicleTextRules: one vehicle's display text in one frame
/** Lowercase, accent-free words joined by spaces (Unicode letters kept). */
const normalize = (v: string) => fold(v).split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean).join(' ');
const ROUTE = /^[A-Za-z]{0,2}\s?\d{1,3}$/;
const PAIR = /^\s*([A-Za-z]{0,2}\s?\d{1,3}|[A-Za-z])\s+(.+?)\s*$/;
const SUFFIX = /^\s*(.+?)\s+([A-Za-z]{0,2}\s?\d{1,3})\s*$/;
const CLOSED = ['ausser betrieb', 'außer betrieb', 'nicht einsteigen', 'dienstfahrt', 'extrafahrt', 'out of service', 'not in service', 'depot', 'garage'].map(normalize);
const inDisplayBand = (t: ArText, d: ArDetection) => midY(t.box) < d.box[1] + d.box[3] * 0.65;
/** Without a segmentation mask a text belongs to the vehicle when its box lies inside the vehicle's and in no other vehicle. */
const associated = (t: ArText, d: ArDetection, others: Box[]) => !isEmptyBox(t.box) && OPTIONS.containsBox(d.box, t.box) && !others.some((o) => intersects(o, t.box));
function adjacentDestination(text: ArText, route: ArText, eitherSide: boolean) {
  const h = Math.max(text.box[3], route.box[3]);
  if (!(h > 0) || !(route.box[3] > 0) || Math.abs(midY(text.box) - midY(route.box)) > h * 0.3) return false;
  const r = text.box[3] / route.box[3];
  if (r < 0.5 || r > 1.8 || !hasLetter(text.text)) return false;
  const right = text.box[0] >= route.box[0] + route.box[2] && text.box[0] - (route.box[0] + route.box[2]) <= h * 2;
  const left = text.box[0] + text.box[2] <= route.box[0] && route.box[0] - (text.box[0] + text.box[2]) <= h * 2;
  return right || (eitherSide && left);
}
/** Display-zone text for closed-set matching: score ≥ 0.3, centred in the vehicle's upper 65 %, not in another vehicle. */
function displayEvidence(texts: ArText[], d: ArDetection, others: Box[]): ArText[] {
  const out: ArText[] = [];
  for (const t of texts) {
    if (!(Number.isFinite(t.score) && t.score >= 0.3) || isEmptyBox(t.box)) continue;
    const cx = midX(t.box), cy = midY(t.box);
    if (!containsPoint(d.box, cx, cy) || !inDisplayBand(t, d) || others.some((o) => containsPoint(o, cx, cy))) continue;
    const i = out.findIndex((o) => o.text === t.text && iou(o.box, t.box) > 0.5);
    if (i >= 0) { if (t.score > out[i].score) out[i] = t; } else out.push(t);
  }
  return out.slice(0, 24);
}
/** What one frame shows on one vehicle. Expected journey words are never put into it. eitherSide: the route number may stand right of the destination. */
function read(texts: ArText[], d: ArDetection, others: Box[], at: number, frameId: string, eitherSide = true): ArReading {
  const assoc = texts.filter((t) => t.score >= 0.7 && associated(t, d, others));
  const raw = assoc.map((t) => t.text);
  const closed = raw.some((v) => CLOSED.some((c) => normalize(v).includes(c)));
  const rows = assoc.filter((t) => inDisplayBand(t, d));
  const routes = rows.filter((t) => ROUTE.test(t.text));
  for (const route of routes) {
    const cands = rows.filter((t) => adjacentDestination(t, route, eitherSide));
    const neighbours: ArText[] = [];
    for (const c of cands) {
      if (!eitherSide || !neighbours.some((n) => normalize(n.text) === normalize(c.text) && iou(n.box, c.box) > 0.5)) neighbours.push(c);
    }
    if (neighbours.length === 1) {
      const n = neighbours[0];
      rows.push({ text: route.text + ' ' + n.text, box: union(route.box, n.box), score: Math.min(route.score, n.score) });
    }
  }
  const pairs: [string, string][] = [];
  for (const item of rows) {
    if (!inDisplayBand(item, d)) continue;
    const m = PAIR.exec(item.text);
    if (!m || !hasLetter(m[2])) continue;
    pairs.push([normalize(m[1]).replace(/ /g, ''), normalize(m[2])]);
  }
  if (eitherSide) {
    for (const item of rows) {
      if (!PAIR.test(item.text)) continue;
      const m = SUFFIX.exec(item.text);
      if (!m || !hasLetter(m[1])) continue;
      pairs.push([normalize(m[2]).replace(/ /g, ''), normalize(m[1])]);
    }
  }
  const unique = new Set(pairs.map((p) => p[0] + '|' + p[1]));
  const one = unique.size === 1;
  const score = Math.max(0, d.score), height = Math.max(0, d.box[3]);
  return {
    frameId, at, line: one ? pairs[0][0] : null, destination: one ? pairs[0][1] : null, outOfService: closed,
    ambiguous: unique.size > 1, raw, observed: displayEvidence(texts, d, others),
    frameQuality: (0.7 + 0.3 * Math.min(1, score / 0.6)) * (0.8 + 0.2 * Math.min(1, height / 0.3)),
  };
}

// ---------------------------------------------------------------- VehicleServiceMatcher: the decision over the last 2 s
const RANKED_FRAMES = 3, CONSENSUS_MIN = 0.35, SINGLE_FRAME_MIN = 0.6;
/** A reading that really says something else, not a misread or a short form of the expected display. */
function credibleContradiction(r: ArReading, expected: ArExpectation) {
  const expectedLine = lineKey(expected.line);
  if (r.line != null) {
    const key = lineKey(r.line);
    if (!isRouteToken(key) || !/\d/.test(key) || key.replace(/^[a-z]+/, '').startsWith('0')) return false;
  }
  if (r.destination == null) return r.line != null;
  const ws = words(r.destination);
  if (ws.join('').replace(/[^a-z]/g, '').length < 3 || ws[0] === 'via' || ws[0] === 'uber') return false;
  const sameLine = r.line == null || lineKey(r.line) === expectedLine || confusionKey(lineKey(r.line)) === confusionKey(expectedLine);
  if (sameLine) {
    if (destinationSimilarity(r.destination, expected.destination) >= 0.6) return false;
    const observed = ws.join('');
    if (observed.length >= 4 && variants(expected.destination).some((v) => v.join('').startsWith(observed))) return false;
  }
  return true;
}

// match(), memoised per camera frame: every frame is judged again while it stays in the 2 s window.
const matchCache = new Map<string, ArBoardMatch>();
function matchFrame(frameId: string, texts: ArText[], candidates: ArCandidate[], positions?: Record<string, number>) {
  const key = frameId + '|' + candidates.map(identity).join(';') + '|'
    + Object.keys(positions || {}).sort().map((k) => k + '=' + Math.trunc(positions![k] * 100)).join(';');
  const hit = matchCache.get(key);
  if (hit) return hit;
  const m = match(texts, candidates, positions);
  matchCache.set(key, m);
  if (matchCache.size > 64) matchCache.delete(matchCache.keys().next().value!);
  return m;
}

interface BoardEvidence { expectedFrames: number[]; other: ArCandidate | null; split: boolean; acceptedExpected: boolean; basis: ArBasis | null; confidence: number | null }
function boardEvidence(readings: ArReading[], expected: ArExpectation, positions?: Record<string, number>): BoardEvidence {
  const own: ArCandidate = { line: expected.line, destination: expected.destination, vias: expected.vias, isExpected: true };
  const alternatives = (expected.board || []).filter((c) => !c.isExpected && !sameDisplay(c, own));
  const candidates = [own, ...alternatives];
  const ev: BoardEvidence = { expectedFrames: [], other: null, split: false, acceptedExpected: false, basis: null, confidence: null };
  const scored: { candidate: ArCandidate; confidence: number }[] = [];
  const seen = new Set<string>();
  for (const r of readings) {
    if (!r.observed.length || seen.has(r.frameId)) continue;
    seen.add(r.frameId);
    const texts = alternatives.length ? r.observed : r.observed.filter((t) => t.score >= 0.7);
    if (!texts.length) continue;
    const m = matchFrame(r.frameId, texts, candidates, positions);
    if (!m.best) continue;
    if (!alternatives.length) {
      if (m.outcome === 'matched' && m.best.line === 'exact' && m.best.destination >= 0.85) ev.expectedFrames.push(r.at);
      continue;
    }
    if (m.outcome !== 'matched') continue;
    scored.push({ candidate: m.best.candidate, confidence: m.confidence * r.frameQuality });
  }
  if (!alternatives.length || !scored.length) return ev;
  const top = scored.slice().sort((a, b) => b.confidence - a.confidence).slice(0, RANKED_FRAMES);
  const votes = new Map<string, { candidate: ArCandidate; count: number; best: number; least: number }>();
  for (const t of top) {
    const k = identity(t.candidate), v = votes.get(k) || { candidate: t.candidate, count: 0, best: 0, least: 1 };
    votes.set(k, { candidate: v.candidate, count: v.count + 1, best: Math.max(v.best, t.confidence), least: Math.min(v.least, t.confidence) });
  }
  let leader = null as null | { candidate: ArCandidate; count: number; best: number; least: number };
  for (const v of votes.values()) if (!leader || v.count > leader.count || (v.count === leader.count && v.best > leader.best)) leader = v;
  const L = leader!;
  const rival = Math.max(0, ...top.filter((t) => identity(t.candidate) !== identity(L.candidate)).map((t) => t.confidence));
  const settle = (c: ArCandidate, basis: ArBasis, confidence: number) => {
    if (c.isExpected) ev.acceptedExpected = true; else ev.other = c;
    ev.basis = basis; ev.confidence = confidence;
  };
  if (L.count >= 2 && L.least >= CONSENSUS_MIN) {
    if (rival >= L.best * 0.8) ev.split = true; else settle(L.candidate, 'consensus', L.best);
  } else if (top[0] && top[0].confidence >= SINGLE_FRAME_MIN) {
    const first = top[0];
    const contradiction = scored.some((s) => identity(s.candidate) !== identity(first.candidate) && s.confidence >= first.confidence * 0.5);
    if (contradiction) ev.split = true; else settle(first.candidate, 'best_single_frame', first.confidence);
  }
  return ev;
}

/**
 * Is the vehicle whose readings these are the ride you want? now/at in seconds. The answer is never stronger than
 * 'match' here: a trip binding (Kante /api/identify, the engine's live trip) is a separate, later check.
 */
function decide(readingsIn: ArReading[], lastSeen: number, expected: ArExpectation | null, now: number, positions?: Record<string, number>): ArDecision {
  const ans = (state: ArDecisionState, reason: string, extra?: Partial<ArDecision>): ArDecision => ({ state, reason, ...extra });
  if (!expected || !expected.line || !expected.destination) return ans('unknown', 'missing_journey_display');
  if (!(now >= lastSeen && now - lastSeen < 0.8)) return ans('unknown', 'track_stale');
  const readings = readingsIn.filter((r) => r.at <= now && now - r.at <= 2);
  const latest = readings[readings.length - 1];
  if (!latest || now - latest.at >= 0.8) return ans('unknown', 'display_stale');
  if (readings.some((r) => r.outOfService)) return ans('wrong', 'out_of_service');
  if (readings.some((r) => r.ambiguous)) return ans('unknown', 'ambiguous_display');
  const line = normalize(expected.line).replace(/ /g, ''), destination = normalize(expected.destination);
  const board = boardEvidence(readings, expected, positions);
  const withBasis = (d: ArDecision) => (board.basis ? { ...d, basis: board.basis, confidence: board.confidence } : d);
  if (board.other) {
    const o = board.other, service = `${o.line} ${o.destination}`;
    const stops = expected.stopsBefore || [];
    if (lineKey(o.line) === lineKey(expected.line) && stops.some((s) => destinationSimilarity(s, o.destination) >= 0.9)) {
      return withBasis(ans('wrong', 'display_short_turn_before_alighting', { other: o, observed: service }));
    }
    return withBasis(ans('wrong', 'display_matches_other_departure', { other: o, observed: service }));
  }
  if (board.split) return ans('unknown', 'display_matches_several_departures');
  if (board.acceptedExpected) return withBasis(ans('match', 'display_matches'));
  const ef = board.expectedFrames;
  if (ef.length >= 3 && latest.at - ef[0] >= 0.8 && ef[ef.length - 1] === latest.at) return ans('match', 'display_matches');
  const differing = readings.filter((r) => (r.line != null && r.line !== line) || (r.destination != null && r.destination !== destination));
  if (differing.length) {
    if (ef.length) return ans('unknown', 'insufficient_temporal_evidence');
    const credible = differing.filter((r) => credibleContradiction(r, expected));
    if (new Set(credible.map((r) => r.frameId)).size < 2) return ans('unknown', 'display_conflict_unconfirmed');
    const stops = (expected.stopsBefore || []).map(normalize);
    if (credible.some((r) => r.line === line && r.destination != null && stops.includes(r.destination))) return ans('wrong', 'display_short_turn_before_alighting');
    return ans('wrong', 'wrong_line_destination_or_short_working');
  }
  if (latest.line == null || latest.destination == null) return ans('unknown', ef.length ? 'insufficient_temporal_evidence' : 'display_unreadable');
  const complete = readings.filter((r) => r.line === line && r.destination === destination);
  if (new Set(complete.map((r) => r.frameId)).size < 3 || latest.at - complete[0].at < 0.8) return ans('unknown', 'insufficient_temporal_evidence');
  return ans('match', 'display_matches');
}

/** In words for the screen. */
function decisionText(d: ArDecision, expected: ArExpectation | null): string {
  const want = expected ? `${expected.line} to ${expected.destination}` : 'your ride';
  if (d.state === 'match') return d.basis === 'best_single_frame' ? `Looks like your ${want} · check the display` : `This is your ${want}`;
  if (d.state === 'wrong') return d.observed ? `This is the ${d.observed.replace(' ', ' to ')} · not yours` : (d.reason === 'out_of_service' ? 'Not in service' : 'Not your ride');
  return 'Reading the display…';
}

export const ARCORE = {
  words, canonical, lineKey, isRouteToken, confusionKey, weightedVariants, similarity, destinationSimilarity, sameDisplay,
  identity, normalize, match, read, decide, decisionText, credibleContradiction, iou, options: OPTIONS,
};
