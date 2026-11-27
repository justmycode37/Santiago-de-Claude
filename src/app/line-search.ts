// ---- Lines in the search: "Tram 9", "9", "Bus 12", "S1", "IC 8" typed where to go lists the lines of that name with
//      vehicles on the way nearby (the engine has no list of lines: its live vehicles around where the search measures
//      from, src/vehicle-pick.ts). Their rows come first in the results; choosing one shows that line's vehicles on the
//      map to follow one (vehicle-follow.ts showLine()).
//      A provider of its own beside the place search: it listens to the destination field itself (also to one
//      character, which the place search leaves alone) and to Enter, and the results list asks it for its rows
//      (lineRows() in search-pins.ts render()). Not while a journey is on show. ----
import { form, inputs } from './search.ts';
import { onTap, render } from './search-pins.ts';
import { closeSearch } from './trip-ends.ts';
import { gpsOn, userLngLat } from './location.ts';
import { map } from './map.ts';
import { MODE_NAME, h, kBadge } from './sheet.ts';
import { fmtDist } from './live-vehicles.ts';
import { lineLabel, modeOf } from './journey-steps.ts';
import { showLine } from './vehicle-follow.ts';
import { journey, searchState } from './state.ts';
import { KANTE } from '../engine.ts';
import { KANTE_LIVE } from '../live.ts';
import { groupLines, lineQuery } from '../vehicle-pick.ts';
import type { LineGroup } from '../vehicle-pick.ts';

// Around where the search measures from: a town's lines (about 9 km across), else a region's (about 45 km)
const BOXES: [dLon: number, dLat: number][] = [[0.06, 0.04], [0.3, 0.2]];
const MAX_ROWS = 4;
/** What the rows were found for: the text, the lines, the box they were found in. */
let found: { text: string; groups: LineGroup[]; box: KanteBbox | null; busy: boolean; at: number } | null = null;
let req = 0, timer: ReturnType<typeof setTimeout> | undefined;
// The vehicles of a box, kept for a moment (typing "9", "91", "9" again asks once)
const cache = new Map<string, { at: number; data: KanteVehiclesResponse }>();

const asked = () => searchState.field === 'to' && !journey.dest;
// You, while the map shows where you are; else the middle of the map (as the place search measures)
const origin = (): LngLat => (gpsOn() && userLngLat && map.getBounds().contains(userLngLat) ? userLngLat : map.getCenter().toArray());

function onInput() {
  const text = inputs.to.value.trim(), q = asked() ? lineQuery(text) : null;
  clearTimeout(timer);
  if (!q || !KANTE.available()) { if (found) found = null; req++; return; }
  if (found && found.text === text && Date.now() - found.at < 60000) return;
  found = { text, groups: [], box: null, busy: true, at: Date.now() };
  const id = ++req;
  timer = setTimeout(() => { void look(text, q, id); }, 200);
}
async function look(text: string, q: NonNullable<ReturnType<typeof lineQuery>>, id: number) {
  const from = origin();
  for (const [dx, dy] of BOXES) {
    const box: KanteBbox = [from[0] - dx, from[1] - dy, from[0] + dx, from[1] + dy];
    const key = KANTE_LIVE.bboxParam(box.map((x) => Math.round(x * 100) / 100) as KanteBbox);
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.at > 20000) {
      const data = await KANTE.vehicles({ bbox: key }).catch(() => null);
      if (id !== req) return;
      if (!data) break;
      if (cache.size > 8) cache.clear();
      cache.set(key, hit = { at: Date.now(), data });
    }
    const groups = groupLines(q, hit.data.vehicles || [], from);
    if (groups.length) { found = { text, groups: groups.slice(0, MAX_ROWS), box, busy: false, at: Date.now() }; rerender(); return; }
  }
  if (id !== req) return;
  found = { text, groups: [], box: null, busy: false, at: Date.now() };
  rerender();
}
function rerender() {
  if (found && inputs.to.value.trim() === found.text && asked() && document.activeElement === inputs.to) render();
}
const lineName = (line: KanteLine) => {
  const j = KANTE_LIVE.journeyLike(line), mode = modeOf(j.category), label = lineLabel(j);
  return mode === 'train' ? label : `${MODE_NAME[mode] || 'Bus'} ${label}`;
};
function choose(g: LineGroup) {
  const box = found && found.box;
  if (!box) return;
  closeSearch();
  showLine(g, box);
}

/** The rows of the lines found for what the destination field says now (search-pins.ts render() puts them first). */
export function lineRows(): HTMLElement[] {
  if (!found || found.busy || found.text !== inputs.to.value.trim() || !asked()) return [];
  return found.groups.map((g) => {
    const li = h('li', 'line-row');
    li.setAttribute('role', 'option');
    const n = g.vehicles.length;
    const where = g.headsigns.map((x) => `to ${x}`).join(' · ');
    const many = n === 1 ? `1 on the way, ${fmtDist(g.nearestKm * 1000)} away` : `${n} on the way nearby`;
    li.append(h('span', 'icon line-icon kj', kBadge(KANTE_LIVE.journeyLike(g.line), 'lg')),
      h('div', 'text', h('div', 'title', lineName(g.line)), h('div', 'subtitle', [where, many].filter(Boolean).join(' · '))));
    onTap(li, () => choose(g));
    return li;
  });
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  inputs.to.addEventListener('input', onInput);
  // back in the field: the lines found for it again (the place search has no list for one character), looked for
  // anew after a minute
  inputs.to.addEventListener('focus', () => {
    const text = inputs.to.value.trim();
    if (found && found.text === text && !found.busy && Date.now() - found.at < 60000) { if (found.groups.length) render(); }
    else onInput();
  });
  // Enter with a line's rows first in the list: that line (before the place search takes the first place)
  form.addEventListener('submit', (e) => {
    const rows = lineRows();
    if (!rows.length || !found) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    choose(found.groups[0]);
  }, true);
}
