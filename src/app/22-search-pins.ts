// ---- The places of a search as pins on the map ("Show on map"): tap one to make it that end of the trip ----
const placeMarkers: maplibregl.Marker[] = [];
const areaChip = document.getElementById('areaChip')!;
let pins: FieldSearch | null = null; // { text, field }: the search whose places are on the map
function clearPlacePins() {
  for (const m of placeMarkers) m.remove();
  placeMarkers.length = 0;
  pins = null;
  areaChip.hidden = true;
}
function drawPlacePins(places: SearchResult[], text: string, field: TripField) {
  clearPlacePins();
  for (const r of places) {
    const k = r.icon || KIND[r.kind] || KIND.other;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'place-pin';
    el.setAttribute('aria-label', `${r.title}, ${r.subtitle}`);
    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.style.background = k.color;
    if (k.fg) icon.style.color = k.fg;
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${k.svg}</svg>`;
    const name = document.createElement('span');
    name.textContent = r.title;
    el.append(icon, name);
    el.addEventListener('click', (e) => { e.stopPropagation(); choose(r, field); });
    placeMarkers.push(new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, -14] }).setLngLat(r.lngLat).addTo(map));
  }
  pins = { text, field };
}
function showPlacesOnMap() {
  const places = results.filter((r) => r.origin === 'place');
  if (!places.length) return;
  const field = activeField;
  drawPlacePins(places, inputs[field].value.trim(), field);
  list.classList.remove('open');
  blurSearch();
  // Stay where you are looking when some of them are there; otherwise show them all
  const view = map.getBounds();
  if (places.some((r) => view.contains(r.lngLat))) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const r of places) bounds.extend(r.lngLat);
  const pad = mapPadding();
  map.fitBounds(bounds, { padding: { ...pad, left: pad.left + 12, right: pad.right + 12, bottom: pad.bottom + 30 }, maxZoom: 16.5, duration: 900 });
}
// "Search this area": the same search again, for the part of the map now in view. The camera stays put.
async function searchArea() {
  if (!pins) return;
  const { text, field } = pins, id = ++reqId, view = map.getBounds();
  areaChip.hidden = true;
  const bbox: PlaceBbox = [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()];
  const [online] = await Promise.all([searchPlacesOnline(text, bbox).catch(() => null), loadPlaces()]);
  if (id !== reqId || !pins || pins.text !== text) return;
  const found = combineResults(text, null, online, searchPlaces(text, true))
    .filter((r) => r.origin === 'place' && view.contains(r.lngLat));
  if (!found.length) { showToast(`Nothing found for “${text}” in this part of the map.`); return; }
  results = found;
  lastSearch = { field, text };
  drawPlacePins(found, text, field);
}
areaChip.addEventListener('click', searchArea);

// A tap on a result row. On phones the click only comes after the browser has moved focus away from the
// search box, and that blur hides the list, so the click never reaches the row. Touches are therefore handled
// on touchend, before any of that happens, and the click that would follow is cancelled. Mouse, keyboard and
// screen readers still use the click.
function onTap(el: HTMLElement, fn: () => void) {
  let start: { x: number; y: number } | null = null;
  el.addEventListener('pointerdown', (e) => e.preventDefault()); // mouse: keep focus in the search box
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    start = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) start = null; // scrolling the list
  }, { passive: true });
  el.addEventListener('touchcancel', () => { start = null; });
  el.addEventListener('touchend', (e) => {
    if (!start || !e.cancelable) return; // not cancelable: leave it to the click
    start = null;
    e.preventDefault(); // no focus change, no late click on whatever opens underneath
    fn();
  });
  el.addEventListener('click', fn);
}

// A row you can pick: a real button, so a screen reader names it as one and a double tap presses it
function rowButton(cls: string, onPick: () => void, ...kids: (Node | string)[]) {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  const b = document.createElement('button');
  b.type = 'button';
  b.append(...kids);
  onTap(b, onPick);
  li.append(b);
  return li;
}
// "5 results", said to screen readers once typing pauses (not after every letter, and not twice)
let countTimer = 0, countSaid = '';
function sayCount(text: string) {
  clearTimeout(countTimer);
  countTimer = setTimeout(() => {
    if (text === countSaid || !list.classList.contains('open')) return;
    countSaid = text;
    A11Y.say(text, { quiet: true });
  }, 700);
}
let listBusy = false; // the list is being redrawn: a row that had the focus and is replaced has not been left
function render(emptyText = 'No results') {
  // a screen reader is on a row: which one, to go on there when the list is drawn again
  const focusRow = list.contains(document.activeElement) ? [...list.querySelectorAll('li > button')].indexOf(document.activeElement as HTMLButtonElement) : -1;
  const focusText = focusRow >= 0 ? document.activeElement!.textContent : null;
  listBusy = true;
  list.innerHTML = '';
  listBusy = false;
  if (!inputs[activeField].value.trim()) {
    // Nothing typed for the destination yet: offer the community events near you, which are otherwise only
    // cards on the map
    if (activeField !== 'to' || document.activeElement !== inputs.to || journeyDest || !visibleEvents().length) { list.classList.remove('open'); return; }
    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.style.background = 'var(--rose)';
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${EVENTS.GLYPHS.community}"/></svg>`;
    const text = document.createElement('div');
    text.className = 'text';
    text.append(mk('div', 'title', 'Events near you'), mk('div', 'subtitle', SETTINGS.eventTags().length ? 'Those that match your settings, nearest first' : 'Community events, nearest first'));
    list.appendChild(rowButton('', () => {
      activeField = 'to';
      setField('to', 'Events near you');
      clearTimeout(debounce);
      search('Events near you');
    }, icon, text));
    list.classList.add('open');
    return;
  }
  if (!results.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    list.appendChild(li);
  }
  const placeCount = results.filter((r) => r.origin === 'place').length;
  if (placeCount >= 2 && results[0].origin === 'place') {
    const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ic.setAttribute('viewBox', '0 0 24 24');
    ic.setAttribute('aria-hidden', 'true');
    ic.innerHTML = '<path d="M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5zM9 4v13.5M15 6.5V20"/>';
    list.appendChild(rowButton('on-map', showPlacesOnMap, ic,
      placeCategory ? `Show ${placeCount} ${placeCategory.toLowerCase()} on the map` : `Show ${placeCount} places on the map`));
  }
  const visible = expanded ? results : results.slice(0, eventsAsked ? 6 : placeCategory ? 5 : COLLAPSED_COUNT);
  visible.forEach((r, i) => {
    const icon = document.createElement('div');
    const k = r.icon || KIND[r.kind] || KIND.other;
    icon.className = 'icon';
    icon.style.background = k.color;
    if (k.fg) icon.style.color = k.fg;
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${k.svg}</svg>`;
    const text = document.createElement('div');
    text.className = 'text';
    // names are in the language of where they are (an event's title in its own), so they are pronounced right
    // (a place listed by its kind, "Public toilet", and a pin are not names: they are in the app's language)
    const title = mk('div', 'title', r.title);
    const t = r.origin === 'event' ? A11Y.inLang(title, A11Y.textLang(r.title)) : r.generic || r.origin === 'pin' ? title : named(title, r.lngLat);
    text.append(t, mk('div', 'subtitle', r.subtitle));
    list.appendChild(rowButton('', () => select(i), icon, text));
  });
  const hidden = results.length - visible.length;
  if (!expanded && hidden > 0) {
    list.appendChild(rowButton('more', () => {
      expanded = true;
      render();
      // a screen reader was on "Show more": carry on at the first row that is new
      const next = list.querySelectorAll<HTMLElement>('li:not(.on-map) > button')[visible.length];
      if (next && document.activeElement !== inputs[activeField]) next.focus();
    }, 'Show more…'));
  }
  if (window.PlaceSearch && results.some((r) => r.source)) { // places from places.js: credit their source
    const attr = document.createElement('li');
    attr.className = 'attr';
    attr.textContent = PlaceSearch.attribution;
    list.appendChild(attr);
  }
  list.classList.add('open');
  if (!expanded) list.scrollTop = 0;
  // the row that had the focus is gone ("Events near you" has become its results, or more results have come in):
  // go on at the row now in its place
  if (focusRow >= 0 && !list.contains(document.activeElement)) {
    // the same row if it is still there (another may have come in above it), else the one now in its place
    const rows = [...list.querySelectorAll<HTMLElement>('li > button')];
    const row = rows.find((b) => b.textContent === focusText) || rows[Math.min(focusRow, rows.length - 1)];
    if (row) row.focus({ preventScroll: true });
  }
  if (emptyText !== 'Searching…' || results.length) {
    sayCount(!results.length ? emptyText : `${visible.length} ${visible.length === 1 ? 'result' : 'results'}${!expanded && hidden > 0 ? `, ${hidden} more` : ''}`);
  }
}
