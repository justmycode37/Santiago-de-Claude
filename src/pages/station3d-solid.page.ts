import { open } from './station3d-solid.js';
import type { SolidChange, SolidView } from '../station3d-solid.js';
declare global {
  /** The view, for the console. */
  var SOLID: SolidView | undefined;
}
/** The page's elements, by id. */
interface SolidPageElements {
  view: HTMLElement; title: HTMLElement; journey: HTMLSelectElement; sum: HTMLElement; floors: HTMLElement;
  stepText: HTMLElement; stepMeta: HTMLElement; attrib: HTMLElement;
  prev: HTMLButtonElement; next: HTMLButtonElement; wholeBtn: HTMLButtonElement; stretch: HTMLButtonElement;
}
/** A journey of the menu: its label, its two ends and its preferences (comma-separated), as in the page's address. */
type SolidPreset = [label: string, from: string, to: string, prefs: string];
const $ = <K extends keyof SolidPageElements>(id: K) => document.getElementById(id) as SolidPageElements[K];
const q = new URLSearchParams(location.search);
const key = await window.SOLID_READY.catch((e) => { $('title').textContent = 'No 3D model: ' + e.message; throw e; });
const model = window.STATION3D![key];
// "stop:uic:ref[@sector]" | "entrance:Name" | "node:i" | "ll:lon,lat[,level]"
const end = (t: string): StationRouteEndpoint | null => {
  if (!t) return null;
  const [k, ...rest] = t.split(':');
  if (k === 'stop') { let ref = rest[1] || '', sector: string | undefined; if (ref.includes('@')) [ref, sector] = ref.split('@'); return { stop: Object.assign({ uic: rest[0], ref }, sector ? { sector } : {}) }; }
  if (k === 'entrance') return { entrance: rest.join(':') };
  if (k === 'node') return { node: +rest[0] };
  if (k === 'll') { const n = rest.join(':').split(',').map(Number); return n.length >= 2 && n.every(isFinite) ? Object.assign({ ll: [n[0], n[1]] as LngLat }, n.length > 2 ? { level: n[2] } : {}) : null; }
  return null;
};
const presets = ({
  zurich: [
    ['Bahnhofplatz → platform 32 (Löwenstrasse, −4)', 'entrance:Bahnhofplatz', 'stop:8503000:32', ''],
    ['Platform 7 → platform 43 (Museumstrasse, −3)', 'stop:8503000:7', 'stop:8503000:43', ''],
    ['Platform 33 → platform 16, step-free', 'stop:8503000:33', 'stop:8503000:16', 'stepFree'],
    ['Platform 44 → tram at Bahnhofquai', 'stop:8503000:44', 'stop:8587349:', ''],
    ['Platform 31 → Sihlpost tram', 'stop:8503000:31', 'stop:8591367:', ''],
  ],
  bern: [
    ['Bahnhofplatz → RBS platform 23 (−2)', 'entrance:Bahnhofplatz (main hall)', 'stop:8507000:23', ''],
    ['Platform 7 → bus terminal on the Welle', 'stop:8507000:7', 'stop:8507785:U', ''],
  ],
} as Record<string, SolidPreset[] | undefined>)[key] || [];
const prefsOf = (s: string | undefined): StationRoutePrefs => Object.fromEntries((s || '').split(',').filter(Boolean).map((p) => [p, true]));
let initial: SolidPreset | undefined = q.get('from') && q.get('to') ? ['Your journey', q.get('from')!, q.get('to')!, q.get('prefs') || ''] : presets[0];
const opts = [...(initial && !presets.includes(initial) ? [initial] : []), ...presets];
$('journey').innerHTML = opts.map((p, i) => `<option value="${i}">${p[0]}</option>`).join('') + '<option value="x">Explore the station</option>';
$('title').textContent = model.name;
$('attrib').textContent = (model.attribution || []).join(' · ');

let view: SolidView | null = null;
view = await open({
  mount: $('view'), key,
  from: initial && end(initial[1]), to: initial && end(initial[2]), prefs: prefsOf(initial && initial[3]),
  onChange: sync,
});
const levels = view!.levels.slice().reverse();
$('floors').innerHTML = levels.map((l) => `<button data-l="${l.id}" title="${l.name}">${l.id > 0 ? '+' + l.id : l.id}</button>`).join('') + '<hr><button data-l="all" title="Whole building">⌂</button>';
$('floors').onclick = (e) => { const b = (e.target as HTMLElement).closest('button'); if (!b) return; b.dataset.l === 'all' ? view!.whole() : view!.floor(+b.dataset.l!); };
$('journey').onchange = () => {
  const v = $('journey').value;
  if (v === 'x') { view!.plan(null, null); return; }
  const p = opts[+v];
  view!.plan(end(p[1]), end(p[2]), prefsOf(p[3]));
};
$('prev').onclick = () => view!.prev();
$('next').onclick = () => view!.route && view!.next();
$('wholeBtn').onclick = () => view!.whole();
$('stretch').onclick = () => { const s = view!.stretch > 1.5 ? 1 : 2.2; view!.setStretch(s); $('stretch').textContent = `↕ ${s}×`; };

function sync({ route, step, focusLevel }: SolidChange) {
  const used = new Set(route ? route.points.map((p) => Math.round(p[2])) : []);
  for (const b of $('floors').querySelectorAll<HTMLButtonElement>('button[data-l]')) {
    b.classList.toggle('used', used.has(+b.dataset.l!));
    b.classList.toggle('on', b.dataset.l === 'all' ? (step < 0 && focusLevel == null) : focusLevel === +b.dataset.l!);
  }
  if (!route) {
    $('sum').textContent = 'Explore: pick a floor, drag to turn, pinch to zoom';
    const lvls = window.STATION3D_SOLID![key].levels;
    $('stepText').textContent = focusLevel != null ? `Level ${focusLevel}: ${(lvls.find((l) => l.id === focusLevel) || {} as Partial<StationLevel>).name || ''}` : model.name;
    $('stepMeta').textContent = (opts.length && $('journey').value !== 'x' ? 'No way found for this journey. ' : '') + `${lvls.length} levels, from ${lvls[0].z} m to ${lvls[lvls.length - 1].z} m`;
    $('prev').disabled = $('next').disabled = true;
    return;
  }
  const changes = route.steps.filter((s) => s.kind !== 'walk' && s.kind !== 'arrive' && Math.round(s.toLevel) !== Math.round(s.level));
  if (focusLevel != null) {
    const lv: Partial<StationLevel> = window.STATION3D_SOLID![key].levels.find((l) => l.id === focusLevel) || {};
    $('stepText').textContent = `Level ${focusLevel}: ${lv.name || ''}`;
    $('stepMeta').textContent = `${lv.z} m · the floors above it are lifted away (their outlines stay). ⌂ shows the whole building.`;
    $('next').textContent = 'Start ›'; $('prev').disabled = true; $('next').disabled = false;
    return;
  }
  $('sum').textContent = `${Math.round(route.length)} m · ${Math.max(1, Math.round(route.seconds / 60))} min · ${changes.length} change${changes.length === 1 ? '' : 's'} of floor`
    + (route.notice ? ' · ' + route.notice : '');
  $('prev').disabled = step <= 0; $('next').disabled = step >= route.steps.length - 1;
  if (step < 0) {
    $('stepText').textContent = changes.filter((s) => s.toLevel !== s.level).map((s) => `${s.kind === 'elevator' ? 'Lift' : s.kind[0].toUpperCase() + s.kind.slice(1)} ${s.dir === 'down' ? '↓' : '↑'} ${s.toLevel}`).join('  ·  ') || 'All on one floor';
    $('stepMeta').textContent = 'The whole way. Next › goes step by step.';
    $('next').textContent = 'Start ›';
  } else {
    const s = route.steps[step];
    $('stepText').textContent = s.text;
    $('stepMeta').textContent = `Step ${step + 1} of ${route.steps.length} · level ${s.level}${s.toLevel !== s.level ? ' → ' + s.toLevel : ''}${s.len ? ' · ' + Math.round(s.len) + ' m' : ''}`;
    $('next').textContent = 'Next ›';
  }
}
sync({ route: view!.route, step: -1, focusLevel: null });
window.SOLID = view!;
