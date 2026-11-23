// Signs as position evidence inside stations: text read by the camera (stopvision.ts OCR, or typed in) is matched
// against the station model (station3d/<uic>.js via indoorloc.ts) and turned into candidate positions for the
// indoor Filter, with a strength that reflects how much the sign really says about where you stand:
//
//   platform sign   "7" + "A" / "Gleis 7 Sektor A" / "Voie 7"        → you are ON platform 7, near sector A
//                   (SBB sector signs are in data.sbb.ch with their position): strong, ~15–40 m
//   direction sign  "Gleis 3–18 →" / "Voies 31/32" / several numbers  → you are near the way to those platforms
//                   (the concourse end of the stairs/escalators/lifts that lead there): weak
//   exit            "Ausgang Bahnhofplatz" / "Sortie" / "Uscita"     → near the paths to that exit: weak
//   passage / hall  "Passage Löwenstrasse", "ShopVille"               → in or near that passage: medium
//   shop / service  "Starbucks", "Coop Pronto", "Apotheke"            → in sight of that shop (all branches of a
//                   chain are candidates, so a chain alone is ambiguous): medium
//   departure board line + destination found in the live departures   → on (or looking at) that platform
//
// A sign is evidence, never a fix: a direction sign says where something is, not where you are, sector letters
// repeat on every platform, and a shop can be seen from 30 m. The Filter weighs it against everything else.
const norm = (s: string | null | undefined) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[|]/g, 'l').replace(/[^a-z0-9→←↑↓\-–/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
function lev(a: string, b: string) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const ratio = (a: string, b: string) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);
// does the (OCR'd) text contain this name, allowing a few misread letters?
function contains(text: string, name: string) {
  // "Bahnhofplatz (main hall)": the sign says "Bahnhofplatz"
  const bare = String(name || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (bare && bare !== name) return Math.max(contains1(text, name), contains1(text, bare));
  return contains1(text, name);
}
function contains1(text: string, name: string) {
  const t = ' ' + text + ' ', n = norm(name);
  if (!n || n.length < 3) return 0;
  if (t.includes(' ' + n + ' ')) return 1;
  if (n.length < 5) return 0;
  const words = text.split(' '), nw = n.split(' ').length;
  let best = 0;
  for (let i = 0; i + nw <= words.length; i++) best = Math.max(best, ratio(words.slice(i, i + nw).join(' '), n));
  return best >= 0.82 ? best : 0;
}

const PLATFORM_WORDS = ['gleis', 'gleise', 'gl', 'voie', 'voies', 'binario', 'binari', 'bin', 'track', 'tracks', 'perron', 'quai', 'kante', 'platform'];
const SECTOR_WORDS = ['sektor', 'sektoren', 'secteur', 'secteurs', 'settore', 'settori', 'sector'];
const EXIT_WORDS = ['ausgang', 'ausgange', 'sortie', 'sorties', 'uscita', 'uscite', 'exit', 'zugang', 'acces'];
const ARROWS = /[→←↑↓]|->|<-/;

// What does the sign say? → { platforms: [..], ranges: [[a, b]], sectors: [..], exit: bool, arrows: bool, words }
function parse(text: string) {
  const t = norm(text);
  const words = t.split(' ').filter(Boolean);
  const out: SignLocParse = { text: t, words, platforms: [], ranges: [], sectors: [], exit: false, arrows: ARROWS.test(text), platformWord: false };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (PLATFORM_WORDS.includes(w)) {
      out.platformWord = true;
      // numbers (and ranges / lists) after the word
      for (let j = i + 1; j < Math.min(words.length, i + 8); j++) {
        const m = /^(\d{1,2})(?:[-–/](\d{1,2}))?$/.exec(words[j]);
        if (m) {
          if (m[2] != null && words[j].includes('/')) out.platforms.push(m[1], m[2]);
          else if (m[2] != null) out.ranges.push([+m[1], +m[2]]);
          else out.platforms.push(m[1]);
        } else if (/^[a-h]$/.test(words[j]) && PLATFORM_WORDS.includes(w) && w === 'kante') out.platforms.push(words[j].toUpperCase());
        else if (!['und', 'et', 'e', 'and', '-', '–'].includes(words[j])) break;
      }
    }
    if (SECTOR_WORDS.includes(w)) {
      for (let j = i + 1; j < Math.min(words.length, i + 6); j++) {
        if (/^[a-h]$/.test(words[j])) out.sectors.push(words[j].toUpperCase());
        else if (/^[a-h][-–][a-h]$/.test(words[j])) { const a = words[j].charCodeAt(0), b = words[j].charCodeAt(2); for (let c = a; c <= b; c++) out.sectors.push(String.fromCharCode(c).toUpperCase()); }
        else break;
      }
    }
    if (EXIT_WORDS.includes(w)) out.exit = true;
  }
  // an SBB sector sign without words: a big track number and a sector letter, e.g. "7 A" or "A 7 B"
  if (!out.platformWord && words.length <= 4) {
    const nums = words.filter((w) => /^\d{1,2}$/.test(w));
    const lets = words.filter((w) => /^[a-h]$/.test(w));
    if (nums.length === 1 && lets.length >= 1) { out.platforms.push(nums[0]); lets.forEach((l) => out.sectors.push(l.toUpperCase())); out.bare = true; }
  }
  // ranges written with a space: "Gleis 3 - 18"
  const r = /(?:gleis|gleise|voies?|binari?o?|tracks?)\s+(\d{1,2})\s*[-–]\s*(\d{1,2})/.exec(t);
  if (r && !out.ranges.length) { out.ranges.push([+r[1], +r[2]]); out.platforms = out.platforms.filter((p) => p !== r[1] && p !== r[2]); }
  out.platforms = [...new Set(out.platforms)];
  out.sectors = [...new Set(out.sectors)];
  return out;
}

// Station lookups, built once per model
/** A sector sign (or a sector's centre): the platform's ref and the letters on it. */
interface SignSector { ref: string; letters: string; li: number; x: number; y: number }
interface SignIndex {
  /** Platform ref → its stops. */
  plat: Map<string, IndoorLandmark[]>;
  sectors: SignSector[];
  /** Everything else that has a name. */
  named: IndoorLandmark[];
  /** Normalised name → how many places have it. */
  count: Map<string, number>;
}
/** The model, with the lookups kept on it. */
type SignModel = IndoorModel & { _signIndex?: SignIndex };
function index(M: SignModel) {
  if (M._signIndex) return M._signIndex;
  const plat = new Map<string, IndoorLandmark[]>(), sectors: SignSector[] = [], named: IndoorLandmark[] = [];
  for (const l of M.landmarks) {
    if (l.kind === 'platform') { if (!plat.has(l.text)) plat.set(l.text, []); plat.get(l.text)!.push(l); }
    else if (l.kind === 'sector') { const [ref, letters] = String(l.text).split(':'); sectors.push({ ref, letters: letters || '', li: l.li, x: l.x, y: l.y }); }
    else if (l.text) named.push(l);
  }
  // how many times each name occurs (a chain is ambiguous)
  const count = new Map<string, number>(), groups = new Set<string>();
  for (const l of named) {
    const k = norm(l.text);
    if (l.group) { if (groups.has(l.group)) continue; groups.add(l.group); }   // one place with several points
    count.set(k, (count.get(k) || 0) + 1);
  }
  return (M._signIndex = { plat, sectors, named, count });
}

// The concourse ends of the stairs / escalators / lifts that lead to a platform: where signs to it hang
function accessesTo(M: IndoorModel, ref: string) {
  const I = index(M);
  const ps = I.plat.get(ref) || [];
  const out: IndoorCandidate[] = [];
  for (const p of ps) {
    const near = M.nearEdges(p.x, p.y, p.li, 160);
    for (const c of near) {
      const e = c.e, k = M.ek[e];
      if (k < 1 || k > 3) continue;
      const a = M.ea[e], b = M.eb[e];
      if (M.li[a] === M.li[b]) continue;
      const other = M.li[a] === p.li ? b : (M.li[b] === p.li ? a : -1);
      if (other < 0) continue;
      out.push({ x: M.x[other], y: M.y[other], li: M.li[other], sigma: 25, w: 1, label: `way to platform ${ref}` });
    }
  }
  return out;
}

// Match a sign → { observations: [{ kind, candidates, strength, label }], candidates, strength, explain, parsed }
// opts.departures: live departures at this station [{ platform, line, to }], to read departure boards
function match(text: string | SignLocParse, M: IndoorModel, opts: SignLocOptions = {}): SignLocMatch {
  const P = typeof text === 'string' ? parse(text) : text;
  const I = index(M);
  const obs: SignLocObservation[] = [];
  const known = (r: string | number) => I.plat.has(String(r));
  // 1. platform sign or direction sign
  const listed = P.platforms.filter(known);
  for (const [a, b] of P.ranges) for (let r = a; r <= b; r++) if (known(r) && !listed.includes(String(r))) listed.push(String(r));
  const isDirection = P.arrows || P.ranges.length > 0 || listed.length > 2;
  if (listed.length && !isDirection) {
    // on the platform: at its sector signs (matching letters if read), else anywhere along it. "Voies 7/8" names
    // the two edges of one island platform, or the platforms a sign leads to: one observation with both as
    // alternatives, weaker than a single number
    const cands: IndoorCandidate[] = [];
    for (const ref of listed) {
      let c = I.sectors.filter((s) => s.ref === ref && (!P.sectors.length || P.sectors.some((l) => s.letters.includes(l))))
        .map((s) => ({ x: s.x, y: s.y, li: s.li, sigma: P.sectors.length ? 15 : 35, w: 1, label: `platform ${ref}${s.letters ? ' sector ' + s.letters : ''}` }));
      if (!c.length) c = I.plat.get(ref)!.map((p) => ({ x: p.x, y: p.y, li: p.li, sigma: 40, w: 1, label: `platform ${ref}` }));
      cands.push(...c);
    }
    const one = listed.length === 1;
    obs.push({ kind: 'platform', label: `On platform ${listed.join(' or ')}${P.sectors.length ? ', sector ' + P.sectors.join('') : ''}`,
      candidates: cands, strength: (P.sectors.length ? 0.9 : 0.75) * (one ? 1 : 0.7) });
  } else if (listed.length) {
    const cands: IndoorCandidate[] = [];
    for (const ref of listed) cands.push(...accessesTo(M, ref));
    if (cands.length) obs.push({ kind: 'direction', label: `Sign to platform${listed.length > 1 ? 's' : ''} ${compact(listed)}: near the way there`, candidates: thin(cands, 40), strength: 0.35 });
  }
  // 2. named places: exits, passages, shops, services (longest names first, each name once)
  const seen = new Set<string>();
  const named = I.named.slice().sort((a, b) => String(b.text).length - String(a.text).length);
  for (const l of named) {
    const k = norm(l.text);
    if (seen.has(k) || k.length < 3 || /^\d+$/.test(k)) continue;
    const score = contains(P.text, l.text);
    if (!score) continue;
    seen.add(k);
    const all = named.filter((m) => norm(m.text) === k);
    const n = I.count.get(k) || 1;
    const kind = l.kind;
    const sigma = kind === 'exit' ? (P.exit ? 60 : 30) : kind === 'passage' ? 40 : 25;
    const strength = (kind === 'exit' && P.exit ? 0.3 : kind === 'passage' ? 0.55 : 0.5) * score / Math.sqrt(n);
    obs.push({
      kind, label: `${kind === 'exit' ? (P.exit ? 'Sign to exit' : 'Exit') : kind === 'passage' ? 'Passage' : 'Shop/service'} “${l.text}”${n > 1 ? ` (${n} places)` : ''}`,
      candidates: all.map((m) => ({ x: m.x, y: m.y, li: m.li, sigma, w: 1, label: m.text })), strength,
    });
  }
  // 3. departure boards: a line and its destination, at the platform the live data gives
  for (const d of opts.departures || []) {
    if (!d.platform || !known(d.platform) || !d.to) continue;
    const line = norm(d.line || '');
    if (contains(P.text, d.to) && (!line || P.words.includes(line) || P.text.includes(line))) {
      obs.push({ kind: 'board', label: `Departure board: ${d.line || ''} to ${d.to} → platform ${d.platform}`, candidates: I.plat.get(String(d.platform))!.map((p) => ({ x: p.x, y: p.y, li: p.li, sigma: 45, w: 1 })), strength: 0.5 });
      break;
    }
  }
  obs.sort((a, b) => b.strength - a.strength);
  const top = obs[0];
  return {
    parsed: P, observations: obs,
    candidates: top ? top.candidates : [], strength: top ? top.strength : 0,
    explain: obs.length ? obs.map((o) => o.label).join(' · ') : 'Nothing on this sign matches this station',
  };
}

// Feed every observation of a match into an indoor Filter
function apply(filter: IndoorFilter, result: SignLocMatch, t: number) {
  let est = null;
  for (const o of result.observations) est = filter.landmark({ t, candidates: o.candidates, strength: o.strength });
  return est;
}

const compact = (refs: string[]) => refs.length > 3 ? `${refs[0]}–${refs[refs.length - 1]}` : refs.join(', ');
// drop candidates closer than d metres to one already kept (same floor)
function thin(cands: IndoorCandidate[], d: number) {
  const out: IndoorCandidate[] = [];
  for (const c of cands) if (!out.some((o) => o.li === c.li && Math.hypot(o.x - c.x, o.y - c.y) < d)) out.push(c);
  return out;
}

export const SIGNLOC: SignLocApi = { parse, match, apply, norm };
