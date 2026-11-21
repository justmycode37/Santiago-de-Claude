// ---- The two ends of the trip ----
const pointOf = (f: TripField) => (f === 'from' ? tripStart : journeyDest);
function setField(f: TripField, text: string) {
  inputs[f].value = text;
  clears[f].classList.toggle('show', !!text);
}
function blurSearch() {
  for (const f of FIELDS) inputs[f].blur();
  if (list.contains(document.activeElement)) (document.activeElement as HTMLElement).blur(); // a row a screen reader was on
}
function closeSearch() { list.classList.remove('open'); blurSearch(); }

// The card: one pill while you are only looking around; the start row shows once a trip is being planned
const tripBtn = document.getElementById('tripBtn')!;
const planOpen = () => document.body.classList.contains('plan-open');
function setPlanOpen(on: boolean) {
  document.body.classList.toggle('plan-open', on);
  tripBtn.setAttribute('aria-label', on ? 'Swap start and destination' : 'Choose where the trip starts');
  inputs.to.placeholder = on ? 'Where to?' : 'Search places, addresses…';
  inputs.from.placeholder = userLngLat ? 'Your location' : 'Map centre';
}
// Under way (after Start): the card folds into the progress pill. Changing either end brings it back.
function setFollowing(on: boolean) {
  if (on === document.body.classList.contains('following')) return;
  if (!on) stopGuidance(); // guidance belongs to being under way
  document.body.classList.toggle('following', on);
  if (on) closeSearch();
  layoutTop();
  if (document.body.classList.contains('journey-mode')) placeSheet(sheetDetent, true);
}
// Bottom edge of what is at the top of the screen: the search card, or the progress pill once under way.
// (Their boxes, not their rectangles on screen: the pill slides in.)
const jPillEl = document.getElementById('jPill')!;
function topUiBottom() {
  return Math.max(form.offsetHeight ? wrap.offsetTop + form.offsetTop + form.offsetHeight : 0,
    jPillEl.offsetHeight ? jPillEl.offsetTop + jPillEl.offsetHeight : 0);
}
function layoutTop() { root.style.setProperty('--top-ui', topUiBottom() + 'px'); }
if (window.ResizeObserver) {
  new ResizeObserver(() => {
    layoutTop();
    if (document.body.classList.contains('journey-mode')) placeSheet(sheetDetent, false); // the sheet stops below the card
  }).observe(form);
}
layoutTop();

// A destination has been chosen (a result, a place on the map, an event, a dropped pin): plan the trip there.
// quiet: the camera stays where it is until the trip is found (you have just put the pin there yourself)
function showDestinationJourney(r: JourneyDest, quiet?: boolean) {
  const first = !journeyDest;
  if (first) journeyQuery = { mode: 'dep', date: '', time: '' };
  clearPlacePins();
  journeyDest = r;
  setField('to', r.title);
  closeSearch();
  destMarker.setLngLat(r.lngLat).addTo(map);
  setPlanOpen(true);
  setFollowing(false);
  startJourney(r, !first || !!quiet);
}
// Where the trip starts: a place, a dropped pin, or null for where you are
function setStart(r: JourneyDest | null, fly?: boolean) {
  clearPlacePins();
  tripStart = r;
  setField('from', r ? r.title : '');
  closeSearch();
  if (r) startMarker.setLngLat(r.lngLat).addTo(map);
  else startMarker.remove();
  setPlanOpen(true);
  setFollowing(false);
  if (journeyDest) startJourney(journeyDest, true);
  else if (r && fly) map.flyTo({ center: r.lngLat, zoom: Math.max(map.getZoom(), 15), speed: 1.4 });
}
function choose(r: SearchResult, field = activeField) {
  if (field === 'from') setStart(r, true);
  else showDestinationJourney(r);
}
function select(i: number) {
  const r = results[i];
  if (!r) return;
  if (r.origin !== 'event' || !r.eventId) { choose(r); return; }
  // an event opens its page (with "Show journey" on it); the search keeps what was typed for the way back
  const typed = lastSearch;
  closeSearch();
  eventsAtPin = r.series || [];
  // back from the event: the list again, on the row you picked (not the search field, which would open the keyboard)
  eventBack = () => {
    if (results[i] !== r || lastSearch !== typed || !typed || inputs.to.value.trim() !== typed.text || document.body.classList.contains('following')) return null;
    activeField = 'to';
    document.body.classList.add('searching');
    render();
    return list.querySelectorAll<HTMLElement>('li:not(.on-map):not(.more) > button')[i] || null;
  };
  openEvent(r.eventId);
}
// Start ⇄ destination. "Where you are" becomes a fixed point when it turns into the destination.
function swapEnds() {
  const a = tripStart, b = journeyDest;
  if (!a && !b) return;
  const dest = a || { title: userLngLat ? 'Your location' : 'Map centre', subtitle: '', kind: 'address', origin: 'pin',
    lngLat: userLngLat || map.getCenter().toArray() };
  tripStart = b || null;
  setField('from', tripStart ? tripStart.title : '');
  if (tripStart) startMarker.setLngLat(tripStart.lngLat).addTo(map);
  else startMarker.remove();
  showDestinationJourney(dest, true);
}

for (const f of FIELDS) {
  const input = inputs[f];
  input.addEventListener('input', () => {
    activeField = f;
    const text = input.value.trim();
    clears[f].classList.toggle('show', !!input.value);
    clearTimeout(debounce);
    clearPlacePins();
    countSaid = '';
    if (text.length < 2) { reqId++; results = []; placeCategory = null; eventsAsked = false; lastSearch = null; render(); return; }
    // Google Places is paid per request: wait a little longer for a pause in typing
    debounce = setTimeout(() => search(text), window.PlaceSearch && PlaceSearch.source === 'google' ? 350 : 200);
  });
  input.addEventListener('focus', () => {
    activeField = f;
    document.body.classList.add('searching');
    setMenu(false);
    armPin(null);
    pinMenu.remove();
    loadPlaces(); // so places (toilets, pharmacies…) are ready to be searched
    const p = pointOf(f);
    // the place already chosen: typing replaces it · your own unfinished search: its results again
    if (p && input.value === p.title) { input.select(); list.classList.remove('open'); }
    else if (lastSearch && lastSearch.field === f && lastSearch.text === input.value.trim()) render();
    else if (!input.value.trim()) render(); // nothing typed: "Events near you" (destination only)
    else list.classList.remove('open');
  });
  input.addEventListener('blur', (e) => {
    // focus has gone into the list (a screen reader such as TalkBack focuses a row before it presses it):
    // that is still this search
    if (list.contains(e.relatedTarget as Node | null)) return;
    leaveSearch(f);
  });
  clears[f].addEventListener('pointerdown', (e) => e.preventDefault());
  clears[f].addEventListener('click', () => {
    activeField = f;
    results = [];
    placeCategory = null;
    lastSearch = null;
    reqId++;
    clearPlacePins();
    if (f === 'to' && journeyDest) endJourney(true); // the card stays open for another destination
    else if (f === 'from' && tripStart) setStart(null);
    setField(f, '');
    render();
    input.focus();
  });
}

// The search has been left: the list closes and the field shows again what it stands for
function leaveSearch(f: TripField) {
  list.classList.remove('open');
  document.body.classList.remove('searching');
  // back to what the field stands for, unless its search is on the map as pins
  if (pins && pins.field === f) return;
  const p = pointOf(f);
  if (p) setField(f, p.title);
  else if (f === 'from' && journeyDest) setField(f, ''); // the trip on show starts where you are
}
list.addEventListener('focusout', (e) => {
  if (listBusy || list.contains(e.relatedTarget as Node | null) || e.relatedTarget === inputs[activeField]) return;
  leaveSearch(activeField);
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  // "restaurants" + Enter shows them all on the map; a name or address goes straight there
  if (placeCategory && results.filter((r) => r.origin === 'place').length >= 2) showPlacesOnMap();
  else if (results.length) select(0);
});
tripBtn.addEventListener('click', () => { if (planOpen()) swapEnds(); else setPlanOpen(true); });
document.getElementById('tripClose')!.addEventListener('click', () => endJourney());
document.getElementById('jEdit')!.addEventListener('click', () => setFollowing(false));

// Moving the map closes the keyboard, results and menu; once it has moved away from the places shown,
// "Search this area" looks for them there
let userMove = false;
map.on('movestart', (e) => {
  userMove = !!e.originalEvent; // not the programmatic moves (flyTo after a search)
  if (!userMove) return;
  blurSearch();
  setMenu(false);
});
map.on('moveend', () => { if (userMove && pins) areaChip.hidden = false; });
map.on('mousedown', () => { blurSearch(); setMenu(false); });
map.on('touchstart', () => { blurSearch(); setMenu(false); });
