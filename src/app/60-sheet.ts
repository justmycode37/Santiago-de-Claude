// ---- Journey sheet, as in the Kante app (branch nikitas-implementation, screens/journey.tsx): a bottom sheet with
//      three detents, the leg chain and times in its header, the trip as one timeline (time · rail · names ·
//      platform), "where to stand" at every boarding, written walking directions, and Start · share · arrival
//      in a bar below. The map and the bar at the top of the screen are this app's own. ----
const KICON = {
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  nav: '<path d="M12 3l7 17-7-4-7 4z" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  walk: '<circle cx="13" cy="4.5" r="1.7" fill="currentColor"/><path d="M9.5 21l2.2-6.2-2.4-2.6L10.6 8l3 3 3 .8M10.6 8L7.8 9.4 7 12.6M11.7 14.8l3.2 2.4.9 3.8"/>',
  tram: '<rect x="6" y="5.5" width="12" height="11.5" rx="3"/><path d="M6 11.5h12M9.5 20.5l1-3.5M14.5 20.5l-1-3.5M12 5.5V3M9 3h6"/><path d="M9.5 14.2h.01M14.5 14.2h.01" stroke-width="2.6"/>',
  bus: '<rect x="5" y="4" width="14" height="13" rx="3"/><path d="M5 11h14M8 17v2.5M16 17v2.5"/><path d="M8.6 14h.01M15.4 14h.01" stroke-width="2.6"/>',
  rail: '<rect x="6" y="3" width="12" height="14" rx="3.5"/><path d="M6 10.5h12M9 21l2-4M15 21l-2-4"/><path d="M9.5 13.8h.01M14.5 13.8h.01" stroke-width="2.6"/>',
  boat: '<path d="M3 18.5c1.5 1.4 3 1.4 4.5 0s3-1.4 4.5 0 3 1.4 4.5 0 3-1.4 4.5 0M5.2 15l-1-4h15.6l-1 4M8 11V6.5h8V11M12 6.5V4"/>',
  cable: '<path d="M3 5.5l18-2.5M12 4.3V8"/><rect x="7" y="8" width="10" height="10.5" rx="2.5"/><path d="M7 13h10"/>',
  'stairs-up': '<path d="M4 20h4v-4h4v-4h4V8h4M5 10l5-5M10 5H6.5M10 5v3.5"/>',
  'stairs-down': '<path d="M4 20h4v-4h4v-4h4V8h4M5 4l5 5M10 9H6.5M10 9V5.5"/>',
  flag: '<path d="M5 21V4M5 4.5h12l-2.5 4 2.5 4H5"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  down: '<path d="M5 9l7 7 7-7"/>',
  up: '<path d="M5 15l7-7 7 7"/>',
  map: '<path d="M9 4L3 6.2V20l6-2.2 6 2.2 6-2.2V4l-6 2.2L9 4zM9 4v13.8M15 6.2V20"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" stroke-width="2.8"/>',
  alert: '<path d="M12 4l9.3 16H2.7L12 4zM12 10v4.5"/><path d="M12 17.3h.01" stroke-width="2.6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.7h.01" stroke-width="2.6"/>',
  share: '<path d="M12 15V3.5M12 3.5L8 7.5M12 3.5l4 4M5 12.5V20h14v-7.5"/>',
  ticket: '<path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z"/><path d="M15 7.5v1.5M15 11.25v1.5M15 15v1.5"/>',
  go: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  arrow: '<path d="M12 3.5l5.5 15-5.5-3.3-5.5 3.3z" fill="currentColor" stroke-linejoin="round"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 11-2.4-5.5M19.5 4.5v4h-4"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9"/>',
};
const MODE_K: Record<LineMode, KIconName> = { train: 'rail', tram: 'tram', bus: 'bus', boat: 'boat', cable: 'cable' };
const MODE_NAME = { train: 'Train', tram: 'Tram', bus: 'Bus', boat: 'Boat', cable: 'Cable car' };
const STEP_K: Record<JourneyDirection['kind'], KIconName> = { depart: 'nav', walk: 'walk', 'stairs-up': 'stairs-up', 'stairs-down': 'stairs-down', arrive: 'flag' };
const kTpl = document.createElement('template');
function kIcon(name: KIconName, size = 20, cls?: string) {
  kTpl.innerHTML = `<svg class="icon${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${KICON[name] || KICON.dot}</svg>`;
  return kTpl.content.firstChild as SVGSVGElement;
}
// h('div', 'cls', …children): strings become text, null / false / '' are skipped, arrays are flattened
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, ...kids: HChild[]): HTMLElementTagNameMap[K] {
  const e = mk(tag, cls);
  ((kids as unknown[]).flat(Infinity) as HLeaf[]).forEach((k) => { if (k != null && k !== false && k !== '') e.append(typeof k === 'object' ? k : String(k)); });
  return e;
}
function kBtn(cls: string, label: string | null, onClick: (e: MouseEvent) => void, ...kids: HChild[]) {
  const b = h('button', cls, ...kids);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

// "< 1 min", "23 min", "1 h 05 min"; never "0 min" for a time that is not zero
function kDur(s: number) {
  if (s > 0 && s < 60) return '< 1 min';
  const m = Math.max(0, Math.round(s / 60));
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60), r = m % 60;
  return r ? `${hh} h ${String(r).padStart(2, '0')} min` : `${hh} h`;
}
// …and in words, for what is read out: "23 minutes", "1 hour 5 minutes"
function durWords(s: number) {
  if (s > 0 && s < 60) return 'less than 1 minute';
  const m = Math.max(0, Math.round(s / 60)), hh = Math.floor(m / 60), r = m % 60;
  const hours = hh ? `${hh} ${hh === 1 ? 'hour' : 'hours'}` : '';
  return [hours, r || !hh ? A11Y.minutes(r) : ''].filter(Boolean).join(' ');
}
// where seconds decide: "45 s", "1 min 15 s", then whole minutes rounded down
function kDurExact(s: number) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  if (s < 90) return s % 60 ? `1 min ${s % 60} s` : '1 min';
  return kDur(Math.floor(s / 60) * 60);
}
// "+4 min" after a time, in the alarm colour; nothing when on time
// (drawn "+4 min", read out "4 minutes late": an aria-label on a plain span is not read by every screen reader)
function kDelay(min: number) {
  if (!min) return null;
  return h('span', 'delay ' + (min > 0 ? 'late' : 'early'), A11Y.seen(`${min > 0 ? '+' : '−'}${Math.abs(min)} min`),
    A11Y.sr(` ${A11Y.minutes(Math.abs(min))} ${min > 0 ? 'late' : 'early'} `));
}
// Line badge: a plain rounded rectangle in the line's colour ("IC 8", "S3"; a bare number gets its mode icon)
function kBadge(j: LineLike, size?: 'lg' | null, withIcon?: boolean) {
  const label = lineLabel(j), mode = modeOf(j.category);
  const b = h('span', 'badge' + (size ? ' ' + size : ''), withIcon || !label ? kIcon(MODE_K[mode] || 'bus', size === 'lg' ? 16 : 13) : null, label);
  b.setAttribute('role', 'img');
  b.setAttribute('aria-label', mode === 'train' ? label : `${MODE_NAME[mode] || 'Bus'} ${label}`);
  return lineVars(b, j);
}
const chainIcon = (j: LineLike) => !(modeOf(j.category) === 'train' && /[A-Za-z]/.test(lineLabel(j))); // "IC 8" says train by itself

// Where a ride stops: the label ("7", "C"), its noun, and the timetable's platform when it has changed today
function quayOf(r: JourneyRideStep, end: 'dep' | 'arr'): Quay {
  const s = r.s, stop = end === 'dep' ? s.departure : s.arrival, at = ((end === 'dep' ? r.depAt : r.arrAt) || {}) as Partial<JourneyPlatformAt>;
  const live = stop.prognosis && stop.prognosis.platform, plan = stop.platform;
  const { num, sectors } = splitPlatform(live || plan || '');
  const edge = at.edge || null;
  const label = num || (edge && edge.ref) || '';
  const word = platformWord(s.journey); // Platform · Bay · Pier
  return { label, sectors, word, short: word === 'Platform' ? 'Pl.' : word, edge, travel: at.travel,
    planned: live && plan && live !== plan ? splitPlatform(plan).num : null, station: stop.station!.name };
}
// The boarding point in its fixed slot: right-aligned, bold ("Pl. 7", "Bay C"); nothing for an unsigned stop
function kPlat(q: Quay | null | undefined, long?: boolean) {
  if (!q || !q.label) return null;
  // drawn "Pl. 7", read out "Platform 7"
  return h('span', 'plat' + (q.planned ? ' changed' : ''), A11Y.seen(h('span', 'plat-noun', long ? q.word : q.short)), A11Y.seen(h('b', null, q.label)),
    A11Y.sr(` ${q.word} ${q.label}${q.planned ? `, changed from ${q.planned}` : ''} `));
}

// ---- Sheet: low (fitted to its header), middle (half the screen), expanded (stopping below the top bar) ----
let sheetDetent: SheetDetent = 'low';
let sheetY = 0;
const SHEET_GRIP = 20;
function sheetPositions(): SheetPositions {
  const hgt = window.innerHeight;
  const full = Math.round(Math.max(topUiBottom(), menu.getBoundingClientRect().bottom, 0) + 8);
  const footH = jFoot.offsetHeight || 0, headH = jHead.offsetHeight || 60;
  const low = Math.max(full + 40, hgt - SHEET_GRIP - headH - footH);
  const mid = Math.min(low, Math.max(full, Math.round(hgt * 0.5)));
  return { full, mid, low, h: hgt };
}
function placeSheet(d: SheetDetent, animate: boolean) {
  const pos = sheetPositions();
  sheetDetent = d;
  sheetY = pos[d];
  journeyEl.style.height = `${pos.h - pos.full}px`;
  journeyEl.style.transition = animate ? '' : 'none';
  journeyEl.style.transform = `translate3d(0,${sheetY}px,0)`;
  journeyEl.dataset.detent = d;
  jHandle.setAttribute('aria-label', d === 'full' ? 'Show more of the map' : 'Expand panel');
}
// the camera refits its subject into the free part of the map once the sheet has settled
function setDetent(d: SheetDetent, refit?: boolean) {
  const changed = d !== sheetDetent;
  placeSheet(d, true);
  if (!changed) return;
  renderHead(true); // the list / map button follows the detent
  if (refit && d !== 'full' && journeyConn) setTimeout(() => (routeOverview ? fitJourney() : fitStep(journeyStep)), 320);
}
function openSheet() {
  journeyEl.style.transition = 'none';
  journeyEl.style.transform = `translate3d(0,${window.innerHeight}px,0)`;
  void journeyEl.offsetHeight;
  placeSheet('low', true);
}
(function sheetDrag() {
  const el = journeyEl;
  let startY = 0, startX = 0, base = 0, mode = '', samples: { t: number; y: number }[] = [];
  const begin = (cx: number, cy: number) => { startX = cx; startY = cy; base = sheetY; mode = ''; samples = [{ t: performance.now(), y: cy }]; };
  const move = (cx: number, cy: number, target: EventTarget | null, ev: TouchEvent | PointerEvent) => {
    const dy = cy - startY;
    if (mode === '') {
      const dx = cx - startX;
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
      if (Math.abs(dx) > Math.abs(dy)) mode = 'native';
      else if (sheetDetent === 'full' && target && jBody.contains(target as Node)) mode = jBody.scrollTop > 0 || dy < 0 ? 'native' : 'drag';
      else mode = 'drag';
      if (mode === 'drag') el.style.transition = 'none';
    }
    if (mode !== 'drag') return;
    if (ev.cancelable) ev.preventDefault();
    const pos = sheetPositions();
    let ny = base + dy;
    if (ny < pos.full) ny = pos.full - Math.sqrt(pos.full - ny) * 2; // rubber band above the top
    if (ny > pos.low) ny = pos.low + (ny - pos.low) * 0.35;
    sheetY = ny;
    el.style.transform = `translate3d(0,${ny}px,0)`;
    const now = performance.now();
    samples.push({ t: now, y: cy });
    while (samples.length > 2 && now - samples[0].t > 120) samples.shift();
  };
  const end = () => {
    if (mode !== 'drag') { mode = ''; return; }
    mode = '';
    const a = samples[0], b = samples[samples.length - 1];
    const v = b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0; // px per ms
    const pos = sheetPositions(), order: SheetDetent[] = ['full', 'mid', 'low'];
    let best = order[0];
    for (const d of order) if (Math.abs(pos[d] - sheetY) < Math.abs(pos[best] - sheetY)) best = d;
    // a fling over 500 px/s moves one detent in its direction
    const cur = sheetDetent;
    if (Math.abs(v) > 0.5) {
      const i = order.indexOf(cur) + (v > 0 ? 1 : -1);
      if (order[i] && (best === cur || order.indexOf(best) === i)) best = order[i];
    }
    if (best === cur) placeSheet(cur, true);
    else setDetent(best, true);
  };
  el.addEventListener('touchstart', (e) => { if (e.touches.length === 1) begin(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  el.addEventListener('touchmove', (e) => { if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY, e.target, e); }, { passive: false });
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
  // mouse: drag by the header only
  el.querySelector<HTMLElement>('.sheet-top')!.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || (e.target as HTMLElement).closest('button, a, input')) return;
    begin(e.clientX, e.clientY);
    const mm = (ev: PointerEvent) => move(ev.clientX, ev.clientY, null, ev);
    const mu = () => { removeEventListener('pointermove', mm); removeEventListener('pointerup', mu); end(); };
    addEventListener('pointermove', mm);
    addEventListener('pointerup', mu);
  });
  el.addEventListener('wheel', (e) => {
    let next: SheetDetent | null = null;
    if (sheetDetent !== 'full' && e.deltaY > 0) next = 'full';
    else if (sheetDetent === 'full' && e.deltaY < -30 && jBody.scrollTop <= 0) next = 'mid';
    if (next) setDetent(next, true);
  }, { passive: true });
  jHandle.addEventListener('click', () => setDetent(sheetDetent === 'full' ? 'mid' : 'full', true));
  const inJourney = () => document.body.classList.contains('journey-mode');
  addEventListener('resize', () => { if (inJourney()) placeSheet(sheetDetent, false); });
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { if (inJourney() && sheetDetent === 'low') placeSheet('low', false); });
    ro.observe(jHead);
    ro.observe(jFoot);
  }
})();

// ---- What the sheet says about the trip ----
let jFocus: JourneyFocus | null = null;              // { step, dir }: a walking direction picked in the list; the header then steps through them
const openDirs = new Set<number>();     // walks whose directions you opened (changes start open)
const closedDirs = new Set<number>();   // …and changes whose directions you closed
const openStops = new Set<number>();    // rides with all their stops listed

// Where a walk ends: "Bay C", "Platform 7", the stop's name, or your destination
