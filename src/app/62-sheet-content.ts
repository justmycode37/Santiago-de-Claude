// ---- 3D station view (station3d.js): for walks and changes in a station that has a 3D model (stations3d/) ----
const S3_NEAR_KM = 0.5; // a station model reaches about this far around its platforms
const s3Key = (stop) => (window.Station3D && stop && stop.station && Station3D.has(stop.station.id)) || null;
// A ride's boarding / alighting point for the station router: the platform, with its position as a fallback
function s3End(stop, at) {
  const edge = at && at.edge, raw = platformOf(stop);
  const ref = raw !== '–' ? raw : (edge && edge.ref) || '';
  const ll = (at && at.ll) || coordOf(stop);
  if (!ref && !ll) return null;
  const end = {};
  if (ref) end.stop = { uic: String(stop.station.id), ref };
  if (ll) end.ll = ll;
  if (edge && edge.level != null) end.level = edge.level;
  return end;
}
// Where a step's walk starts and ends inside the modelled station, or null when it is not in one
function s3Plan(st) {
  let key = null, from = null, to = null;
  if (st.type === 'walk' && st.next) {
    key = s3Key(st.next.departure);
    const start = userLngLat || (st.lines[0] && st.lines[0][0]);
    to = s3End(st.next.departure, st.nextRide && st.nextRide.depAt);
    // from further away the model only shows the last stretch: where the walk comes in, not where you are
    const far = start && to && to.ll && distKm(start, to.ll) > S3_NEAR_KM;
    from = start ? (far ? { ll: start, label: 'the way in' } : userLngLat ? { ll: start } : { ll: start, label: 'the start' }) : null;
  } else if (st.type === 'walk') {
    key = st.from ? s3Key(st.from.arrival) : null;
    from = key && s3End(st.from.arrival, st.prevRide && st.prevRide.arrAt);
    const end = (journeyDest && journeyDest.lngLat) || (st.lines.length ? st.lines[st.lines.length - 1][1] : null);
    const far = end && from && from.ll && distKm(from.ll, end) > S3_NEAR_KM;
    to = end ? { ll: end, label: far ? `the way to ${st.toName}` : st.toName } : null;
  } else if (st.type === 'change') {
    const ka = s3Key(st.prev.arrival), kb = s3Key(st.next.departure);
    key = kb || ka;
    from = ka === key ? s3End(st.prev.arrival, st.prevRide && st.prevRide.arrAt)
      : st.points[0] ? { ll: st.points[0], label: st.prev.arrival.station.name } : null;
    to = kb === key ? s3End(st.next.departure, st.nextRide && st.nextRide.depAt)
      : st.points[1] ? { ll: st.points[1], label: st.next.departure.station.name } : null;
  }
  return key && from && to ? { key, from, to } : null;
}
// The journey options for the station router, for the day of that step (closures in the model have dates)
const s3Prefs = (st) => ({ ...SETTINGS.journey(), date: st && st.t0 ? dateValue(new Date(st.t0)) : undefined });
let s3Step = null; // the journey step the 3D view was opened from
function s3Open(st, button) {
  const plan = s3Plan(st); // now, not when the sheet was drawn: the start follows your position
  if (!plan) return;
  s3Step = st;
  Station3D.open({ ...plan, prefs: s3Prefs(st), returnFocus: button });
}
// "Done" at the end of the 3D walk: back to the journey, on the step that follows
if (window.Station3D) Station3D.on('done', () => {
  const i = journeySteps.indexOf(s3Step);
  Station3D.close();
  if (i >= 0 && i < journeySteps.length - 1) goToStep(i + 1);
});

function walkTarget(st) {
  const r = st.type === 'change' || !st.final ? st.nextRide : null;
  if (!r) return st.toName || (journeyDest && journeyDest.title) || 'your destination';
  const q = quayOf(r, 'dep');
  return q.label ? `${q.word} ${q.label}` : r.s.departure.station.name;
}
// Metres on foot, once every part of the walk has been routed (null until then)
function walkDist(st) {
  const lines = st.lines || [];
  if (!lines.length) return 0;
  const ws = st.walks || [];
  return lines.every((_, k) => ws[k] && ws[k].dist != null) ? ws.reduce((sum, w) => sum + (w ? w.dist : 0), 0) : null;
}
const walkMinOf = (st) => (st.type === 'change' ? st.walkMin || 0 : st.min || 0);

// Written directions for a walk, from the walking router's turn-by-turn steps, with the floor change in its place
const TURN = { left: 'Turn left', right: 'Turn right', 'slight left': 'Bear left', 'slight right': 'Bear right',
  'sharp left': 'Turn sharp left', 'sharp right': 'Turn sharp right', straight: 'Continue straight', uturn: 'Turn around' };
function walkDirections(st) {
  if (st._dirsV === geoVersion) return st._dirs;
  const out = [];
  (st.walks || []).forEach((w) => {
    // a stretch through a modelled station: its own directions, floor changes included
    if (w && w.dirs) out.push(...w.dirs);
  else ((w && w.steps) || []).forEach((s) => {
    const m = s.maneuver || {}, d = Math.round(s.distance || 0);
    if (m.type === 'arrive' || d < 3) return;
    const along = s.name ? ` along ${s.name}` : '';
    const verb = m.type === 'depart' ? 'Walk' : `${TURN[m.modifier] || 'Continue'} and walk`;
    out.push({ kind: m.type === 'depart' ? 'depart' : 'walk', text: `${verb} ${fmtDist(d)}${along}`, coords: s.geometry && s.geometry.coordinates });
  });
  });
  const lvl = st.floors ? null : levelChange(st);
  if (lvl) {
    const item = { kind: lvl.to < lvl.from ? 'stairs-down' : 'stairs-up', text: lvl.text, from: lvl.from, to: lvl.to, coords: lvl.at ? [lvl.at] : null };
    if (st.type === 'walk' && st.final) out.unshift(item);
    else if (st.type === 'walk') out.push(item);
    else out.splice(Math.ceil(out.length / 2), 0, item);
  }
  if (out.length) {
    const cs = (st.lines || []).flat();
    out.push({ kind: 'arrive', text: `Arrive at ${walkTarget(st)}`, coords: cs.length ? [cs[cs.length - 1]] : null });
  }
  st._dirs = out;
  st._dirsV = geoVersion;
  return out;
}

// What to do first, and when: the verb is yours when the trip starts on foot ("Leave in 4 min"), the vehicle's otherwise
function firstAction(now) {
  const first = journeySteps[0], ride = journeySteps.find((st) => st.type === 'ride');
  const walkFirst = first && first.type === 'walk';
  const when = walkFirst ? first.t0 : ride ? ride.t0 : null;
  if (when == null) return { text: '', quay: ride && quayOf(ride, 'dep') };
  const s = (when - now) / 1000;
  let text = '';
  if (s < -45) text = `Left ${kDur(-s)} ago`;
  else if (s < 60) text = walkFirst ? 'Leave now' : 'Leaves now';
  else if (s < 3600) text = `${walkFirst ? 'Leave' : 'Leaves'} in ${kDur(Math.floor(s / 60) * 60)}`;
  const late = ride ? lateMin(ride.s.departure, 'departure') : 0;
  const forecast = ride && ride.s.departure.prognosis && ride.s.departure.prognosis.departure;
  return { text, gone: s < -45, state: !forecast ? 'plain' : late > 0 ? 'late' : 'ok', delay: late, quay: ride && quayOf(ride, 'dep') };
}

function legChain() {
  const items = journeySteps.filter((st) => st.type === 'ride' || ((st.type === 'walk' || st.type === 'change') && walkMinOf(st) >= 1));
  const max = 7, cut = items.length > max ? items.slice(0, max - 1) : items;
  const chain = h('span', 'chain');
  chain.setAttribute('aria-hidden', 'true');
  cut.forEach((st, i) => {
    if (i) chain.append(kIcon('right', 12, 'chain-sep'));
    chain.append(st.type === 'ride' ? kBadge(st.s.journey, null, chainIcon(st.s.journey))
      : h('span', 'chain-walk', kIcon('walk', 14), String(Math.max(1, walkMinOf(st)))));
  });
  if (cut.length < items.length) chain.append(h('span', 'chain-more', `+${items.length - cut.length}`));
  return chain;
}
function sheetActions() {
  const full = sheetDetent === 'full';
  return h('span', 'sheet-actions',
    kBtn('round-btn', full ? 'Show the map' : 'Show the list', () => setDetent(sheetDetent === 'full' ? 'mid' : 'full', true), kIcon(full ? 'map' : 'list', 18)),
    kBtn('round-btn', 'Close journey', endJourney, kIcon('close', 18)));
}
// A walking direction picked: step through them, or back to the whole journey
function stepNav() {
  const st = journeySteps[jFocus.step], dirs = st ? walkDirections(st) : [], k = jFocus.dir, d = dirs[k];
  if (!d) { jFocus = null; return buildHead(); }
  const text = h('div', 'stepnav-text', h('small', null, `${k + 1} of ${dirs.length}`), h('strong', 'trunc2', d.text));
  text.setAttribute('aria-live', 'polite');
  const prev = kBtn('round-btn', 'Previous direction', () => focusDir(jFocus.step, k - 1), kIcon('back', 18));
  const next = kBtn('round-btn', 'Next direction', () => focusDir(jFocus.step, k + 1), kIcon('go', 18));
  prev.disabled = k === 0;
  next.disabled = k === dirs.length - 1;
  return h('div', 'stepnav', prev, text, next, kBtn('round-btn', 'Back to the whole journey', overview, kIcon('close', 18)));
}
function buildHead() {
  if (jFocus) return stepNav();
  const head = h('div', 'jhead');
  if (!journeyConn) {
    head.append(h('div', 'sheet-title', h('h1', 'trunc', journeyDest ? journeyDest.title : 'Journey'), sheetActions()));
    if (sheetMsg) head.append(h('div', 'jhead-act', h('span', 'jrow-act gone', sheetMsg)));
    return head;
  }
  const now = Date.now(), end = journeyEnd();
  const rides = journeySteps.filter((st) => st.type === 'ride');
  const tr = Math.max(0, rides.length - 1);
  const onFoot = () => { const d = walkDist(journeySteps[0]); return d ? `${fmtDist(d)} on foot` : 'On foot'; };
  head.append(
    h('div', 'sheet-title', legChain(), sheetActions()),
    h('div', 'jhead-times', h('b', null, `${fmtTime(journeyConn.from.departure)} – ${fmtTime(end)}`),
      h('span', null, !rides.length ? onFoot() : tr === 0 ? 'Direct' : `${tr} ${tr === 1 ? 'change' : 'changes'}`)));
  const act = h('div', 'jhead-act');
  // live: off the route, missed a ride, followed by GPS, or a ride under way — otherwise what to do first
  const lp = liveParts(now);
  const rideNow = rides.some((st) => st.t0 != null && now >= st.t0 && now <= st.t1);
  if (now > end + 120000) act.append(h('span', 'jrow-act gone', 'This journey has ended'));
  else if (lp && lp.kind === 'off') act.append(h('span', 'jrow-act late', lp.parts), kBtn('pill-btn small', null, replan, kIcon('refresh', 16), 'Replan'));
  else if (lp && (lp.kind === 'gps' || (lp.kind === 'est' && rideNow))) act.append(h('span', 'jrow-act', lp.parts), ...(lp.rest ? [h('span', 'jhead-rest' + (lp.restLevel ? ' hurry-' + lp.restLevel : ''), lp.rest)] : [])); // append(null) would write "null"
  else {
    const a = firstAction(now);
    if (a.text) act.append(h('span', 'jrow-act ' + (a.gone ? 'gone' : a.state), a.text, a.gone ? null : kDelay(a.delay)));
    else if (a.quay) act.append(h('span'));
    if (a.quay) act.append(kPlat(a.quay, true));
  }
  if (act.childNodes.length) head.append(act);
  return head;
}
let headKey = '';
function renderHead(force) {
  const node = buildHead();
  const key = node.outerHTML;
  if (!force && key === headKey) return; // unchanged: leave it alone (and its buttons pressable)
  headKey = key;
  jHead.replaceChildren(node);
}

function placeRow(t, name, kind) {
  return h('li', 'tl-row tl-place ' + kind,
    h('span', 'tl-time', h('b', null, fmtTime(t))),
    h('span', 'tl-rail', h('i', kind === 'from' ? 'od-ring' : 'od-pin')),
    h('span', 'tl-name', h('strong', null, name), h('small', null, kind === 'from' ? 'Start' : 'Destination')));
}
// Spare time on a change: from getting off to the next departure, less the walk
function spareLine(st) {
  const wait = (liveMs(st.next.departure, 'departure') - liveMs(st.prev.arrival, 'arrival')) / 1000;
  const s = wait - (st.walkS != null ? st.walkS : (st.walkMin || 0) * 60); // walkS: the engine's walk, to the second
  const level = s < 0 ? 'missed' : s < 120 ? 'tight' : 'ok';
  const extra = (SETTINGS.prefs ? SETTINGS.prefs().extraChangeMin : 0) || 0;
  return h('div', 'spare ' + level, kIcon(level === 'ok' ? 'check' : 'alert', 15),
    level === 'missed' ? h('span', null, h('b', null, `Missed change — ${kDurExact(-s)} too late`))
      : h('span', null, h('b', null, `${kDurExact(s)} to spare`), extra > 0 && s < extra * 60 ? h('small', null, ` — less than your ${extra} min extra change time`) : null));
}
function stepRow(d, active, onClick) {
  const b = kBtn('step' + (active ? ' active' : '') + ' k-' + d.kind, null, onClick,
    h('span', 'step-icon', kIcon(STEP_K[d.kind] || 'walk', 18)), h('span', 'step-text', d.text),
    d.from != null && d.to != null ? h('span', 'tag lvl', levelShort(d.from), kIcon('go', 11), levelShort(d.to)) : null);
  if (active) b.setAttribute('aria-current', 'step');
  return h('li', null, b);
}
function walkBlock(st, i) {
  const transfer = st.type === 'change';
  const mins = walkMinOf(st);
  const target = walkTarget(st);
  if (transfer) {
    const pq = quayOf(st.prevRide, 'arr'), nq = quayOf(st.nextRide, 'dep');
    const samePlace = st.prev.arrival.station.name === st.next.departure.station.name;
    if (!mins && !(st.lines && st.lines.length) && samePlace && pq.label && pq.word === nq.word && pq.label === nq.label) {
      return h('li', 'tl-row tl-walk same', h('span', 'tl-time'), h('span', 'tl-rail walk'),
        h('div', 'tl-main', h('strong', null, `Change at the same ${nq.word.toLowerCase()}`), spareLine(st)));
    }
  }
  const dist = walkDist(st);
  const lvl = levelChange(st);
  const pq = transfer && quayOf(st.prevRide, 'arr'), nq = transfer && quayOf(st.nextRide, 'dep');
  const meta = [
    mins ? `${kDur(mins * 60)} walk` : transfer && pq.label && nq.label ? (pq.word === nq.word ? `${pq.word} ${pq.label} → ${nq.label}` : `${pq.short} ${pq.label} → ${nq.short} ${nq.label}`) : '',
    dist ? fmtDist(dist) : '',
    lvl ? lvl.text.replace(/^Go /, '') : '',
  ].filter(Boolean).join(' · ');
  const active = !routeOverview && journeyStep === i;
  const dirs = walkDirections(st);
  const expanded = openDirs.has(i) || (transfer && !closedDirs.has(i)) || (!!jFocus && jFocus.step === i);
  const title = `${transfer ? 'Change to' : 'Walk to'} ${target}`;
  const main = h('div', 'tl-main',
    kBtn('walk-sum', `${title}, ${kDur(mins * 60)}${dist ? ', ' + fmtDist(dist) : ''}. Show on map`, () => goToStep(i),
      h('strong', null, title), meta ? h('span', 'walk-meta', meta) : null));
  if (transfer) main.append(spareLine(st));
  else if (!st.final && st.nextRide) main.append(h('div', 'quiet-line', 'Leave by ', h('b', null, fmtTime(st.t0))));
  if (s3Plan(st)) main.append(h('div', null, kBtn('view3d', 'Show this walk in the 3D station view', (e) => s3Open(st, e.currentTarget), kIcon('cube', 16), '3D view')));
  if (dirs.length > 1) {
    main.append(kBtn('expander', null, () => {
      if (expanded) { closedDirs.add(i); openDirs.delete(i); } else { openDirs.add(i); closedDirs.delete(i); }
      renderBody();
    }, kIcon(expanded ? 'up' : 'down', 16), expanded ? 'Hide directions' : `Walking directions (${dirs.length})`));
    if (expanded) main.append(h('ol', 'steps', dirs.map((d, k) => stepRow(d, !!jFocus && jFocus.step === i && jFocus.dir === k, () => focusDir(i, k)))));
  }
  return h('li', 'tl-row tl-walk' + (active ? ' active' : ''),
    h('span', 'tl-time', h('small', null, kDur(mins * 60))),
    h('span', 'tl-rail walk', kIcon('walk', 18)),
    main);
}

// "Where to stand": the boarding point as a sign, with everything known about it in words
function standCard(st, i) {
  const q = quayOf(st, 'dep'), j = st.s.journey, mode = modeOf(j.category), edge = q.edge;
  const bearing = edge && edge.bearing != null ? edge.bearing : q.travel;
  const sign = h('div', 'sign' + (q.label ? '' : ' unsigned') + (q.label.length > 2 ? ' long' : ''), h('span', 'sign-noun', q.label ? q.word : 'Stop'));
  if (q.label) sign.append(h('span', 'sign-label', q.label));
  else {
    const arrow = h('span', 'sign-arrow', kIcon(bearing != null ? 'arrow' : 'dot', bearing != null ? 30 : 26));
    if (bearing != null) arrow.style.transform = `rotate(${bearing}deg)`;
    sign.append(arrow);
  }
  const side = edge && edge.side ? cap(edge.side) // the engine names the street
    : mode !== 'train' && edge && edge.bearing != null ? `${cap(compassWord(edge.bearing + 90))} side of the road` : ''; // edges sit right of travel
  const level = edge && edge.level ? `Level ${levelShort(edge.level)}` : '';
  const next = j.passList && j.passList[1] && j.passList[1].station && j.passList[1].station.name;
  let compass = null;
  if (next && bearing != null && q.label) {
    compass = h('span', 'stand-compass', kIcon('arrow', 14));
    compass.style.transform = `rotate(${bearing}deg)`;
    compass.setAttribute('role', 'img');
    compass.setAttribute('aria-label', `Leaves heading ${compassWord(bearing)}`);
  }
  const info = h('div', 'stand-info',
    h('div', 'stand-kicker', 'Where to stand'),
    side ? h('div', 'stand-side', side) : null,
    q.sectors || level ? h('div', 'stand-tags',
      q.sectors ? h('span', 'tag strong', `${q.sectors.replace(/[^A-Za-z0-9]/g, '').length === 1 ? 'Sector' : 'Sectors'} ${q.sectors}`) : null,
      level ? h('span', 'tag', level) : null) : null,
    next ? h('div', 'stand-dir', compass, h('span', null, 'Next stop: ', h('b', null, next))) : null);
  const card = h('div', 'stand', h('div', 'stand-main', sign, info));
  if (q.planned) card.append(h('div', 'stand-note warn', kIcon('alert', 16), `${q.word} ${q.planned} → ${q.label}: changed today`));
  if (!edge) card.append(h('div', 'stand-note', kIcon('info', 16), 'Exact platform or bay unknown — map pin shows the stop'));
  card.append(h('div', 'stand-foot', h('span'), kBtn('link-btn', null, () => showQuay(i), 'Show on map ', kIcon('right', 14))));
  return card;
}
// Scheduled time; a delay follows as "+4 min" in the alarm colour
function callTime(stop, which, strong) {
  const t = stop[which] || stop[which === 'departure' ? 'arrival' : 'departure'];
  if (!t) return h('span', 'tl-time');
  return h('span', 'tl-time', strong ? h('b', null, fmtTime(t)) : h('span', null, fmtTime(t)), kDelay(lateMin(stop, which)));
}
// Real-time state as a word, never by colour alone
function liveTag(st) {
  const p = (st.s.departure.prognosis && st.s.departure.prognosis.departure) || (st.s.arrival.prognosis && st.s.arrival.prognosis.arrival);
  return h('span', 'live-tag ' + (p ? 'predicted' : 'timetable'), p ? h('i', 'live-dot') : kIcon('clock', 12), p ? 'Expected' : 'Timetable');
}
function rideBlock(st, i) {
  const s = st.s, j = s.journey, mode = modeOf(j.category);
  const list = j.passList || [];
  const stops = Math.max(0, list.length - 2);
  const rideS = Math.max(0, (st.t1 - st.t0) / 1000);
  const open = openStops.has(i);
  const li = lineVars(h('li', 'tl-ride'), j);
  li.append(h('div', 'tl-row board',
    callTime(s.departure, 'departure', true),
    h('span', 'tl-rail ride first', h('i', 'tl-node', kIcon(MODE_K[mode] || 'bus', 15))),
    h('span', 'tl-name', h('strong', null, s.departure.station.name)),
    kPlat(quayOf(st, 'dep'))));
  li.append(h('div', 'tl-row', h('span', 'tl-time'), h('span', 'tl-rail ride'),
    h('div', 'tl-main',
      standCard(st, i),
      h('div', 'ride-line', kBadge(j, 'lg'), kIcon('go', 14), h('span', 'ride-head', j.to)),
      h('div', 'ride-sum',
        stops > 0 ? kBtn('expander', null, () => { if (open) openStops.delete(i); else openStops.add(i); renderBody(); }, kIcon(open ? 'up' : 'down', 16), `Ride ${stops + 1} stops · ${kDur(rideS)}`)
          : h('span', 'quiet-line', `Non-stop · ${kDur(rideS)}`),
        liveTag(st)))));
  if (open) list.slice(1, -1).forEach((stop) => li.append(h('div', 'tl-row mid',
    h('span', 'tl-time', h('span', null, fmtTime(liveMs(stop, 'arrival') || liveMs(stop, 'departure')))),
    h('span', 'tl-rail ride', h('i', 'tl-stopdot')),
    h('span', 'tl-name', (stop.station && stop.station.name) || ''))));
  li.append(h('div', 'tl-row alight', callTime(s.arrival, 'arrival'), h('span', 'tl-rail ride last', h('i', 'tl-enddot')),
    h('span', 'tl-name', s.arrival.station.name), kPlat(quayOf(st, 'arr'))));
  return li;
}
function footNote() {
  const p = SETTINGS.prefs ? SETTINGS.prefs() : {};
  const walks = journeySteps.filter((st) => st.type === 'walk' || st.type === 'change');
  const mins = walks.reduce((sum, st) => sum + walkMinOf(st), 0);
  const dists = walks.map(walkDist);
  const dist = dists.every((d) => d != null) ? dists.reduce((a, b) => a + b, 0) : null;
  const kmh = p.walkKmh ? Number(p.walkKmh).toFixed(1).replace('.0', '') : '';
  const changes = Math.max(0, journeySteps.filter((st) => st.type === 'ride').length - 1);
  return h('p', 'foot-note',
    (mins > 0 ? `${kDur(mins * 60)} on foot${dist ? ` (${fmtDist(dist)})` : ''}${kmh ? ` at ${kmh} km/h` : ''}` : 'No walking on this journey') +
    (p.extraChangeMin > 0 && changes > 0 ? ` · ${p.extraChangeMin} min extra change time` : ''));
}
function buildBody() {
  const frag = document.createDocumentFragment();
  if (!journeyConn) {
    if (sheetMsg === 'Finding a connection…') for (let k = 0; k < 4; k++) frag.append(h('div', 'skeleton'));
    return frag;
  }
  if (!routeOverview) frag.append(kBtn('pill-btn overview-btn', null, overview, kIcon('map', 16), 'Show full journey'));
  const tl = h('ol', 'tl');
  const first = journeySteps[0];
  if (first && first.type === 'walk') tl.append(placeRow(first.t0, journeyFrom, 'from'));
  journeySteps.forEach((st, i) => {
    if (st.type === 'ride') tl.append(rideBlock(st, i));
    else if (st.type === 'walk' || st.type === 'change') tl.append(walkBlock(st, i));
  });
  const last = journeySteps.filter((st) => st.type !== 'arrive').pop();
  if (last && last.type === 'walk' && last.final) tl.append(placeRow(journeyEnd(), journeyDest ? journeyDest.title : 'Destination', 'to'));
  frag.append(tl, footNote(), h('div', 'sheet-end'));
  return frag;
}
function renderBody() {
  const top = jBody.scrollTop;
  jBody.replaceChildren(buildBody());
  jBody.scrollTop = top;
}
function renderFoot() {
  if (!journeyConn) { jFoot.replaceChildren(); return; }
  const end = journeyEnd(), start = new Date(journeyConn.from.departure).getTime();
  jFoot.replaceChildren(h('div', 'actionbar',
    kBtn('pill-btn start', null, startFollowing, kIcon('nav', 18), 'Start'),
    ticketLink(),
    kBtn('round-btn', 'Share journey', shareJourney, kIcon('share', 18)),
    h('span', 'actionbar-sum', h('small', null, `Arrive ${fmtTime(end)}`), h('b', null, kDur((end - start) / 1000)))));
}
function renderSheet() {
  renderHead(true);
  renderBody();
  renderFoot();
  if (document.body.classList.contains('journey-mode') && sheetDetent === 'low') placeSheet('low', true); // the header's height may have changed
}
let sheetQueued = false;
function queueSheet() {
  if (sheetQueued) return;
  sheetQueued = true;
  requestAnimationFrame(() => { sheetQueued = false; if (journeyConn) { renderHead(); renderBody(); } });
}
