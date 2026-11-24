// Makes the search evaluation's cases (cases.json) from its targets (targets.json, make-targets.mts) and the queries
// subagents wrote for them (queries/batch-*.jsonl: {"t": target id, "q": the text, "style", "local"}). A query that
// only makes sense on the spot ("zytglogge", "closest pharmacy") is asked with the map near its target, one that says
// where ("Bern, Zytglogge") with the map in another town.
//   node tools/search-eval/build-cases.mts
// See tools/search-eval/README.md.
import fs from 'node:fs';
import type { Target } from './make-targets.mts';

/** One query of the evaluation. */
export interface EvalCase {
  /** 'stop/T081-2' */
  id: string;
  /** The kind of target: stop, station, platform, address, place, category, town, postcode. */
  group: string;
  /** How it is typed: exact, casual, partial, typo, alias, descriptive. */
  style: string;
  q: string;
  /** Where the map is centred, which is also where the search measures distances from. */
  at: LngLat;
  /** Half of the map's diagonal, km (1.5 ≈ a phone at zoom 14). */
  viewKm: number;
  /** A result is right when it lies within `m` metres of one of these. */
  ll: LngLat[];
  m: number;
  /** The map is near the target (the query only makes sense on the spot), or in another town. */
  local: boolean;
  /** What the person wanted, in words, for the judges: 'tram stop "Bern, Zytglogge" (Bern)'. */
  want: string;
  /** The target, and where its answer comes from. */
  target: string;
  src: string;
}

const HERE = new URL('./', import.meta.url);
const STYLES = new Set(['exact', 'casual', 'partial', 'typo', 'alias', 'descriptive']);
const targets = new Map((JSON.parse(fs.readFileSync(new URL('targets.json', HERE), 'utf8')) as Target[]).map((t) => [t.id, t]));
const files = fs.readdirSync(new URL('queries/', HERE)).filter((f) => /^batch-\d+\.jsonl$/.test(f)).sort();
/** What the person wanted, in words. */
function wantOf(t: Target) {
  const f = t.facts;
  switch (t.type) {
    case 'stop': case 'station': return `${f.kind} "${f.name}"`;
    case 'platform': return `${f.kind} ${f.platform} at "${f.stop}"`;
    case 'address': return `the address ${f.street_and_number}, ${f.postcode} ${f.town}`;
    case 'place': return `the ${f.kind} "${f.name}" in ${f.town}${f.address ? ` (${f.address})` : ''}, or a nearer one of the same name`;
    case 'category': return `the nearest ${f.kind} to where they are (in ${f.town})`;
    case 'town': return `the town ${f.town}`;
    default: return `the area of postcode ${f.postcode}`;
  }
}
const cases: EvalCase[] = [];
const bad: string[] = [];
const seen = new Set<string>();
const perTarget = new Map<string, number>();
for (const f of files) {
  for (const [n, line] of fs.readFileSync(new URL(`queries/${f}`, HERE), 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    let r: { t?: unknown; q?: unknown; style?: unknown; local?: unknown };
    try { r = JSON.parse(line); } catch { bad.push(`${f}:${n + 1} not JSON`); continue; }
    const t = typeof r.t === 'string' ? targets.get(r.t) : undefined;
    const q = typeof r.q === 'string' ? r.q.trim() : '';
    if (!t || !q || q.length > 80 || typeof r.local !== 'boolean') { bad.push(`${f}:${n + 1} ${line.slice(0, 80)}`); continue; }
    const style = typeof r.style === 'string' && STYLES.has(r.style) ? r.style : 'other';
    const key = `${t.id}|${q.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const i = (perTarget.get(t.id) || 0) + 1;
    perTarget.set(t.id, i);
    cases.push({ id: `${t.type}/${t.id}-${i}`, group: t.type, style, q, at: r.local ? t.near : t.far, viewKm: 1.5, ll: t.ll, m: t.m,
      local: r.local, want: wantOf(t), target: t.id, src: t.src });
  }
}
cases.sort((a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id, 'en', { numeric: true }));
fs.writeFileSync(new URL('cases.json', HERE), '[\n' + cases.map((c) => JSON.stringify(c)).join(',\n') + '\n]\n');

const tally = (f: (c: EvalCase) => string) => Object.entries(cases.reduce<Record<string, number>>((a, c) => ({ ...a, [f(c)]: (a[f(c)] || 0) + 1 }), {}));
console.log(`${cases.length} cases from ${files.length} files, ${perTarget.size} of ${targets.size} targets`);
console.log('  by group:', Object.fromEntries(tally((c) => c.group)));
console.log('  by style:', Object.fromEntries(tally((c) => c.style)));
const without = [...targets.keys()].filter((id) => !perTarget.has(id));
if (without.length) console.log(`  targets without queries: ${without.length} (${without.slice(0, 10).join(', ')}${without.length > 10 ? ', …' : ''})`);
if (bad.length) { console.log(`  ${bad.length} lines left out:`); for (const b of bad.slice(0, 10)) console.log(`    ${b}`); }
