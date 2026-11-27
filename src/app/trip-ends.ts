// ---- The two ends of the trip ----
import { map } from './map.ts';
import { root } from '../theme.ts';
import { setMenu } from './menu.ts';
import { userLngLat } from './location.ts';
import { FIELDS, clears, destMarker, form, inputs, isPlaceResult, list, startMarker, wrap } from './search.ts';
import { search } from './search-places.ts';
import { areaChip, clearPlacePins, loadPlaceSheet, pins, render, showPlacesOnMap } from './search-pins.ts';
import { armPin, pinMenu } from './pins.ts';
import { categoryForText, enterCategory } from './categories.ts';
import { loadPlaces } from './map-places.ts';
import { placeSheet, sheetDetent } from './sheet.ts';
import { renderFoot, renderHead } from './sheet-content.ts';
import { startJourney } from './pill.ts';
import { endJourney } from './routing.ts';
import { stopFollowCam } from './follow-cam.ts';
import { pickTypedHistory, rememberChoice, rememberTrip } from './search-history-ui.ts';
import { journey, searchState } from './state.ts';
import { PlaceSearch } from '../places.ts';
import type { SearchResult, TripField } from './search.ts';
import type { JourneyDest } from './state.ts';
export const pointOf = (f: TripField) => (f === 'from' ? searchState.tripStart : journey.dest);
export function setField(f: TripField, text: string) {
  inputs[f].value = text;
  clears[f].classList.toggle('show', !!text);
}
export function blurSearch() { for (const f of FIELDS) inputs[f].blur(); }
export function closeSearch() { list.classList.remove('open'); blurSearch(); }

// The card: one pill while you are only looking around; the start row shows once a trip is being planned
const tripBtn = document.getElementById('tripBtn')!;
const planOpen = () => document.body.classList.contains('plan-open');
export function setPlanOpen(on: boolean) {
  document.body.classList.toggle('plan-open', on);
  tripBtn.setAttribute('aria-label', on ? 'Swap start and destination' : 'Choose where the trip starts');
  inputs.to.placeholder = on ? 'Where to?' : 'Search places';
  inputs.from.placeholder = userLngLat ? 'Your location' : 'Map centre';
}
// Under way (after Start): the card folds into the progress pill. Changing either end brings it back.
export function setFollowing(on: boolean) {
  if (on === document.body.classList.contains('following')) return;
  document.body.classList.toggle('following', on);
  if (on) closeSearch();
  else stopFollowCam(); // north up and flat again
  if (journey.conn) { renderHead(true); renderFoot(); } // Start has done its work; the pill has the times
  layoutTop();
  if (document.body.classList.contains('journey-mode')) placeSheet(sheetDetent, true);
}
// Bottom edge of what is at the top of the screen: the search card, or the progress pill once under way.
// (Their boxes, not their rectangles on screen: the pill slides in.)
const jPillEl = document.getElementById('jPill')!;
export function topUiBottom() {
  return Math.max(form.offsetHeight ? wrap.offsetTop + form.offsetTop + form.offsetHeight : 0,
    jPillEl.offsetHeight ? jPillEl.offsetTop + jPillEl.offsetHeight : 0);
}
function layoutTop() { root.style.setProperty('--top-ui', topUiBottom() + 'px'); }

// A destination has been chosen (a result, a place on the map, an event, a dropped pin): plan the trip there.
// quiet: the camera stays where it is until the trip is found (you have just put the pin there yourself)
export function showDestinationJourney(r: JourneyDest, quiet?: boolean) {
  clearTimeout(searchState.debounce);
  searchState.reqId++; // a list of places still on its way does not replace the trip
  const first = !journey.dest;
  if (first) journey.query = { mode: 'dep', date: '', time: '' };
  clearPlacePins();
  journey.dest = r;
  setField('to', r.title);
  closeSearch();
  destMarker.setLngLat(r.lngLat).addTo(map);
  setPlanOpen(true);
  setFollowing(false);
  startJourney(r, !first || !!quiet);
}
// Where the trip starts: a place, a dropped pin, or null for where you are
export function setStart(r: JourneyDest | null, fly?: boolean) {
  clearTimeout(searchState.debounce);
  searchState.reqId++;
  clearPlacePins();
  searchState.tripStart = r;
  setField('from', r ? r.title : '');
  closeSearch();
  if (r) startMarker.setLngLat(r.lngLat).addTo(map);
  else startMarker.remove();
  setPlanOpen(true);
  setFollowing(false);
  if (journey.dest) startJourney(journey.dest, true);
  else if (r && fly) map.flyTo({ center: r.lngLat, zoom: Math.max(map.getZoom(), 15), bearing: 0, pitch: 0, speed: 1.4 });
}
// An end is picked, so the search is done: a late answer to it must not open the list again over the trip
function searchDone() { clearTimeout(searchState.debounce); searchState.reqId++; }
export function choose(r: SearchResult, field = searchState.field) {
  searchDone();
  if (field === 'from') setStart(r, true);
  else showDestinationJourney(r);
  rememberChoice(r); // the place, and the trip once both ends are picked (search-history-ui.ts)
}
// A trip from the search history: both ends at once, planned once, leaving now
export function chooseTrip(from: JourneyDest, to: JourneyDest) {
  searchDone();
  clearPlacePins();
  searchState.tripStart = from;
  setField('from', from.title);
  startMarker.setLngLat(from.lngLat).addTo(map);
  journey.query = { mode: 'dep', date: '', time: '' };
  showDestinationJourney(to);
  rememberTrip();
}
export function select(i: number) {
  const r = searchState.results[i];
  if (r) choose(r);
}
// Start ⇄ destination. "Where you are" becomes a fixed point when it turns into the destination.
function swapEnds() {
  const a = searchState.tripStart, b = journey.dest;
  if (!a && !b) return;
  const dest = a || { title: userLngLat ? 'Your location' : 'Map centre', subtitle: '', kind: 'address', origin: 'pin',
    lngLat: userLngLat || map.getCenter().toArray() };
  searchState.tripStart = b || null;
  setField('from', searchState.tripStart ? searchState.tripStart.title : '');
  if (searchState.tripStart) startMarker.setLngLat(searchState.tripStart.lngLat).addTo(map);
  else startMarker.remove();
  showDestinationJourney(dest, true);
  rememberTrip();
}

// Moving the map closes the keyboard, results and menu; once it has moved away from the places shown,
// "Search this area" looks for them there
let userMove = false;

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      layoutTop();
      if (document.body.classList.contains('journey-mode')) placeSheet(sheetDetent, false); // the sheet stops below the card
    }).observe(form);
  }
  layoutTop();
  for (const f of FIELDS) {
    const input = inputs[f];
    input.addEventListener('input', () => {
      searchState.field = f;
      const text = input.value.trim();
      clears[f].classList.toggle('show', !!input.value);
      clearTimeout(searchState.debounce);
      clearPlacePins();
      if (text.length < 2) { searchState.reqId++; searchState.results = []; searchState.predictions = []; searchState.placeCategory = null; searchState.last = null; render(); return; }
      // Google is counted per request: wait a little longer for a pause in typing
      searchState.debounce = setTimeout(() => search(text), PlaceSearch && PlaceSearch.source === 'google' ? 350 : 200);
    });
    input.addEventListener('focus', () => {
      searchState.field = f;
      document.body.classList.add('searching');
      setMenu(false);
      armPin(null);
      pinMenu.remove();
      loadPlaces(); // so places (toilets, pharmacies…) are ready to be searched
      if (PlaceSearch) PlaceSearch.endSession(); // typing from here on is a new session (Google's predictions)
      const p = pointOf(f);
      // the place already chosen, or the category on the map: typing replaces it · your own unfinished search: its
      // results again · nothing typed: the categories
      if ((p && input.value === p.title) || (f === 'to' && searchState.category && input.value === searchState.category.label)) { input.select(); list.classList.remove('open'); }
      else if (!input.value.trim()) render();
      else if (searchState.last && searchState.last.field === f && searchState.last.text === input.value.trim()) render();
      else list.classList.remove('open');
    });
    input.addEventListener('blur', () => {
      list.classList.remove('open');
      document.body.classList.remove('searching');
      // back to what the field stands for, unless its search is on the map as pins
      if (pins && pins.field === f) return;
      const p = pointOf(f);
      if (p) setField(f, p.title);
      else if (f === 'from' && journey.dest) setField(f, ''); // the trip on show starts where you are
    });
    clears[f].addEventListener('pointerdown', (e) => e.preventDefault());
    clears[f].addEventListener('click', () => {
      searchState.field = f;
      searchState.results = [];
      searchState.predictions = [];
      searchState.placeCategory = null;
      searchState.last = null;
      searchState.reqId++;
      clearTimeout(searchState.debounce);
      if (PlaceSearch) PlaceSearch.endSession();
      clearPlacePins();
      if (f === 'to' && journey.dest) endJourney(true); // the card stays open for another destination
      else if (f === 'from' && searchState.tripStart) setStart(null);
      setField(f, '');
      render();
      input.focus();
    });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Enter before the pause in typing has searched: this text is searched first (not the list of the text before)
    const field = searchState.field, text = inputs[field].value.trim();
    if (text.length >= 2 && !(searchState.last && searchState.last.field === field && searchState.last.text === text)
      && !(field === 'to' && categoryForText(text))) {
      clearTimeout(searchState.debounce);
      await search(text);
      if (searchState.field !== field || inputs[field].value.trim() !== text) return; // typed on meanwhile
    }
    // "restaurants" + Enter: the best restaurants here, as if the category had been tapped; "pizza", "Migros" + Enter:
    // the list of them and their pins (with Google: its results); one place: its card; an address or a stop goes
    // straight there
    const to = searchState.field === 'to';
    const typed = to ? categoryForText(inputs.to.value) : null;
    const first = searchState.results[0];
    const places = searchState.results.filter(isPlaceResult).length;
    const google = !!PlaceSearch && PlaceSearch.source === 'google';
    if (typed) enterCategory(typed);
    else if (pickTypedHistory()) return; // a search of yours it matches, the row on top (search-history-ui.ts)
    else if (to && (first ? isPlaceResult(first) : searchState.predictions.length > 0) && (places >= 2 || google)) showPlacesOnMap();
    else if (!to && searchState.placeCategory && places >= 2) showPlacesOnMap();
    else if (to && first && isPlaceResult(first)) { closeSearch(); loadPlaceSheet().then((mod) => { if (mod) mod.showPlace(first); }); }
    else if (first) select(0);
  });
  tripBtn.addEventListener('click', () => { if (planOpen()) swapEnds(); else setPlanOpen(true); });
  document.getElementById('tripClose')!.addEventListener('click', () => endJourney());
  document.getElementById('jEdit')!.addEventListener('click', () => setFollowing(false));
  map.on('movestart', (e) => {
    userMove = !!e.originalEvent; // not the programmatic moves (flyTo after a search)
    if (!userMove) return;
    blurSearch();
    setMenu(false);
  });
  map.on('moveend', () => { if (userMove && (pins || (searchState.category && !searchState.category.events))) areaChip.hidden = false; });
  map.on('mousedown', () => { blurSearch(); setMenu(false); });
  map.on('touchstart', () => { blurSearch(); setMenu(false); });
}
